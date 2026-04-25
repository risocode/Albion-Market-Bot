from __future__ import annotations

import csv
import json
import re
import shutil
import threading
import time
from csv import DictReader, DictWriter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from PySide6.QtWidgets import QApplication

from albion_bot.automation.market_query import MarketQueryAutomation, SearchAnchorInteractionError
from albion_bot.capture.cursor_position import get_cursor_position
from albion_bot.capture.point_selector import PointSelector
from albion_bot.capture.region_selector import RegionSelector
from albion_bot.capture.screen_capture import ScreenCapture
from albion_bot.config.settings import AppSettings
from albion_bot.logging.data_logger import DataLogger
from albion_bot.ocr.normalize import normalize_numeric_text
from albion_bot.ocr.ocr_engine import TesseractOCREngine, _resolve_tesseract_path
from albion_bot.recommendation.exporter import RecommendationExporter
from albion_bot.recommendation.models import ScanResult, utc_now_iso
from albion_bot.recommendation.scoring import OpportunityScorer
from albion_bot.recommendation.session_store import SessionStore
from albion_bot.recommendation.watchlist_repo import WatchlistRepo
from albion_bot.recommendation.watchlist_store import WatchlistStore
from albion_bot.state.runtime_state import CaptureRegion, RuntimeState, ScreenPoint
from albion_bot.persistence.postgres_sink import (
    PostgresPriceSink,
    manual_fetch_unique_name,
    parse_query_tier_enchant,
    watchlist_fetch_unique_name,
)


@dataclass(slots=True)
class HumanizationConfig:
    settle_delay_seconds: float
    post_search_delay_seconds: float
    jitter_ratio: float
    key_delay_base_ms: int


class BotService:
    def __init__(self, settings: AppSettings, emit_event: Callable[[str, dict], None]) -> None:
        self._settings = settings
        self._emit_event = emit_event
        self._state = RuntimeState()
        self._capture = ScreenCapture()
        self._ocr = TesseractOCREngine(settings.tesseract_cmd)
        self._logger = DataLogger(settings.output_csv)
        self._market = MarketQueryAutomation(
            settle_delay_seconds=settings.ui_settle_delay_seconds,
            post_search_delay_seconds=settings.post_search_delay_seconds,
        )
        self._query_text = settings.market_search_text
        self._humanization = HumanizationConfig(
            settle_delay_seconds=settings.ui_settle_delay_seconds,
            post_search_delay_seconds=settings.post_search_delay_seconds,
            jitter_ratio=0.1,
            key_delay_base_ms=12,
        )

        self._loop_thread: threading.Thread | None = None
        self._loop_stop = threading.Event()
        self._loop_interval_seconds = settings.capture_interval_seconds
        self._single_flight_lock = threading.Lock()
        self._query_running = False
        self._qt_app: QApplication | None = None
        self._max_retries = 2

        self._watchlist_repo = WatchlistRepo(WatchlistStore(Path("watchlist.json")))
        self._scorer = OpportunityScorer()
        self._session = SessionStore(max_history=500)
        self._recommendation_exporter = RecommendationExporter(Path("recommendations_log.csv"))
        self._market_prices_file = Path("market_prices_log.csv")

        self._watchlist_loop_thread: threading.Thread | None = None
        self._watchlist_loop_stop = threading.Event()
        self._watchlist_interval_seconds = settings.capture_interval_seconds
        self._watchlist_item_spacing_seconds = 0.25
        self._category_item_spacing_seconds = 2.0
        self._category_break_every_seconds = 60.0
        self._category_break_duration_seconds = 5.0
        self._category_max_consecutive_no_data = 15
        self._search_anchor_retry_limit = 3
        self._search_anchor_retry_wait_seconds = 5.0
        self._category_scan_thread: threading.Thread | None = None
        self._category_scan_stop = threading.Event()
        self._category_scan_pause = threading.Event()
        self._category_scan_skip_spacing = threading.Event()
        self._category_scan_running = False
        self._category_scan_checkpoint_file = Path("category_scan_checkpoint.json")
        self._category_scan_checkpoint_lock = threading.Lock()
        self._calibration_file = Path("calibration_profile.json")
        self._load_calibration_profile()
        self._pg_sink = PostgresPriceSink(
            self._settings.database_url,
            source=self._settings.price_source,
            include_history=False,
        )

    def get_state(self) -> dict:
        session_stats = self._session.stats()
        return {
            "runtimeStatus": "Running" if self._state.is_running() else "Idle",
            "lastValue": self._state.get_last_value(),
            "searchPoint": self._point_to_dict(self._state.get_search_point()),
            "region": self._region_to_dict(self._state.get_region()),
            "queryText": self._query_text,
            "captureIntervalSeconds": self._loop_interval_seconds,
            "humanization": {
                "settleDelaySeconds": self._humanization.settle_delay_seconds,
                "postSearchDelaySeconds": self._humanization.post_search_delay_seconds,
                "jitterRatio": self._humanization.jitter_ratio,
                "keyDelayBaseMs": self._humanization.key_delay_base_ms,
            },
            "watchlist": [item.to_dict() for item in self._watchlist_repo.list()],
            "sessionStats": session_stats.to_dict(),
            "diagnostics": self._diagnostics(),
        }

    def set_search_point(self, x: int, y: int) -> dict:
        point = ScreenPoint(x=int(x), y=int(y))
        self._state.set_search_point(point)
        self._save_calibration_profile()
        self._emit_event("status", {"runtimeStatus": "Idle"})
        return self._point_to_dict(point)

    def set_region(self, left: int, top: int, width: int, height: int) -> dict:
        if width < 2 or height < 2:
            raise ValueError("Region width/height too small.")
        region = CaptureRegion(left=int(left), top=int(top), width=int(width), height=int(height))
        self._state.set_region(region)
        self._save_calibration_profile()
        self._emit_event("status", {"runtimeStatus": "Idle"})
        return self._region_to_dict(region)

    def set_query_text(self, query_text: str) -> dict:
        cleaned = query_text.strip()
        if not cleaned:
            raise ValueError("Query text cannot be empty.")
        self._query_text = cleaned
        return {"queryText": self._query_text}

    def set_humanization(
        self,
        settle_delay_seconds: float,
        post_search_delay_seconds: float,
        jitter_ratio: float,
        key_delay_base_ms: int,
    ) -> dict:
        settle = max(0.0, float(settle_delay_seconds))
        post = max(0.0, float(post_search_delay_seconds))
        jitter = min(max(float(jitter_ratio), 0.0), 0.5)
        key_ms = int(max(0, min(80, int(key_delay_base_ms))))
        self._humanization = HumanizationConfig(
            settle_delay_seconds=settle,
            post_search_delay_seconds=post,
            jitter_ratio=jitter,
            key_delay_base_ms=key_ms,
        )
        self._market.set_humanization(
            settle_delay_seconds=settle,
            post_search_delay_seconds=post,
            jitter_ratio=jitter,
            key_delay_base_ms=key_ms,
        )
        return {
            "settleDelaySeconds": settle,
            "postSearchDelaySeconds": post,
            "jitterRatio": jitter,
            "keyDelayBaseMs": key_ms,
        }

    def capture_cursor(self) -> dict:
        point = get_cursor_position()
        return self._point_to_dict(point)

    def select_point(self) -> dict | None:
        _ = self._ensure_qt_app()
        point = PointSelector.select_point()
        if point is None:
            return None
        return self._point_to_dict(point)

    def select_region(self) -> dict | None:
        _ = self._ensure_qt_app()
        region = RegionSelector.select_region()
        if region is None:
            return None
        self._state.set_region(region)
        self._save_calibration_profile()
        return self._region_to_dict(region)

    def run_query_once(self) -> dict:
        self._acquire_single_flight("runQueryOnce")
        try:
            self._emit_event("status", {"runtimeStatus": "Running"})
            scan_result = self._execute_query_scan(
                query_text=self._query_text,
                item_id="single",
                max_retries=self._max_retries,
            )
            value = scan_result.value
            self._state.set_last_value(value)
            self._logger.append_value(value)
            self._post_item_price_to_database(
                item_unique_name=manual_fetch_unique_name(self._query_text),
                item_name=self._query_text.strip(),
                city=self._settings.default_price_city,
                price=value,
                posted_at_iso=scan_result.timestamp,
                context="runQueryOnce",
                tier_enchant_from_query=self._query_text,
            )
            payload = {
                "timestamp": scan_result.timestamp,
                "queryText": self._query_text,
                "value": value,
                "rawText": scan_result.raw_text,
                "confidence": scan_result.confidence,
                "runtimeStatus": "Idle",
            }
            self._emit_event("result", payload)
            self._emit_event("status", {"runtimeStatus": "Idle"})
            return payload
        finally:
            self._release_single_flight()

    def list_watch_items(self) -> list[dict]:
        return [item.to_dict() for item in self._watchlist_repo.list()]

    def add_watch_item(
        self,
        query_text: str,
        target_price: float | None,
        min_profit_pct: float = 5.0,
        tags: list[str] | None = None,
    ) -> dict:
        item = self._watchlist_repo.add(
            query_text=query_text,
            target_price=target_price,
            min_profit_pct=min_profit_pct,
            tags=tags or [],
        )
        self._emit_event("watchlistChanged", {"items": self.list_watch_items()})
        return item.to_dict()

    def update_watch_item(self, item_id: str, payload: dict) -> dict:
        item = self._watchlist_repo.update(
            item_id=item_id,
            query_text=payload.get("queryText"),
            target_price=payload.get("targetPrice"),
            min_profit_pct=payload.get("minProfitPct"),
            enabled=payload.get("enabled"),
            tags=payload.get("tags"),
        )
        self._emit_event("watchlistChanged", {"items": self.list_watch_items()})
        return item.to_dict()

    def remove_watch_item(self, item_id: str) -> dict:
        removed = self._watchlist_repo.remove(item_id)
        self._emit_event("watchlistChanged", {"items": self.list_watch_items()})
        return {"removed": removed, "itemId": item_id}

    def toggle_watch_item(self, item_id: str) -> dict:
        item = self._watchlist_repo.toggle(item_id)
        self._emit_event("watchlistChanged", {"items": self.list_watch_items()})
        return item.to_dict()

    def run_watchlist_scan(self, item_spacing_seconds: float = 0.25) -> dict:
        self._acquire_single_flight("runWatchlistScan")
        scan_started = utc_now_iso()
        enabled = self._watchlist_repo.list_enabled()
        if not enabled:
            self._release_single_flight()
            raise RuntimeError("Watchlist has no enabled items.")

        self._watchlist_item_spacing_seconds = max(0.0, item_spacing_seconds)
        self._session.mark_scan_started(scan_started)
        self._emit_event("status", {"runtimeStatus": "Running"})
        self._emit_event("scanStarted", {"timestamp": scan_started, "itemCount": len(enabled)})

        processed = 0
        failures = 0
        try:
            for idx, item in enumerate(enabled):
                try:
                    scan_result = self._execute_query_scan(
                        query_text=item.query_text,
                        item_id=item.id,
                        max_retries=self._max_retries,
                    )
                    self._session.record_scan_result(scan_result)
                    baseline = self._session.baseline_for_item(item.id)
                    opportunity = self._scorer.score(item, scan_result, baseline)
                    self._session.record_opportunity(opportunity)
                    self._recommendation_exporter.append(opportunity)

                    if scan_result.value is not None:
                        self._state.set_last_value(scan_result.value)
                        self._logger.append_value(scan_result.value)
                        base_name, tier_p, enchant_p = parse_query_tier_enchant(item.query_text)
                        self._post_item_price_to_database(
                            item_unique_name=watchlist_fetch_unique_name(item.id),
                            item_name=(base_name or item.query_text.strip()),
                            city=self._settings.default_price_city,
                            price=scan_result.value,
                            posted_at_iso=scan_result.timestamp,
                            context="watchlist",
                            tier=tier_p,
                            enchantment=enchant_p,
                        )
                    else:
                        failures += 1

                    processed += 1
                    self._emit_event(
                        "scanItemComplete",
                        {
                            "index": idx,
                            "itemCount": len(enabled),
                            "scanResult": scan_result.to_dict(),
                            "opportunity": opportunity.to_dict(),
                        },
                    )
                except Exception as exc:  # pragma: no cover
                    failures += 1
                    self._emit_event(
                        "scanItemComplete",
                        {
                            "index": idx,
                            "itemCount": len(enabled),
                            "error": str(exc),
                            "item": item.to_dict(),
                        },
                    )
                if idx < len(enabled) - 1:
                    self._watchlist_loop_stop.wait(self._watchlist_item_spacing_seconds)
        finally:
            finished = utc_now_iso()
            self._session.mark_scan_finished(finished)
            self._emit_event(
                "scanFinished",
                {
                    "startedAt": scan_started,
                    "finishedAt": finished,
                    "processed": processed,
                    "failures": failures,
                    "stats": self._session.stats().to_dict(),
                },
            )
            self._emit_event("status", {"runtimeStatus": "Idle"})
            self._release_single_flight()

        return {
            "startedAt": scan_started,
            "processed": processed,
            "failures": failures,
            "recentOpportunities": self.get_recent_opportunities(limit=20),
            "sessionStats": self.get_session_stats(),
        }

    def start_watchlist_loop(self, interval_seconds: float, item_spacing_seconds: float = 0.25) -> dict:
        if self._watchlist_loop_thread and self._watchlist_loop_thread.is_alive():
            return {"running": True}
        self._watchlist_interval_seconds = max(0.2, float(interval_seconds))
        self._watchlist_item_spacing_seconds = max(0.0, float(item_spacing_seconds))
        self._watchlist_loop_stop.clear()
        self._state.set_running(True)
        self._watchlist_loop_thread = threading.Thread(
            target=self._watchlist_loop_worker,
            name="watchlist-loop",
            daemon=True,
        )
        self._watchlist_loop_thread.start()
        self._emit_event("status", {"runtimeStatus": "Running"})
        return {
            "running": True,
            "intervalSeconds": self._watchlist_interval_seconds,
            "itemSpacingSeconds": self._watchlist_item_spacing_seconds,
        }

    def stop_watchlist_loop(self) -> dict:
        self._watchlist_loop_stop.set()
        self._state.set_running(False)
        if self._watchlist_loop_thread and self._watchlist_loop_thread.is_alive():
            self._watchlist_loop_thread.join(timeout=1.5)
        self._watchlist_loop_thread = None
        self._emit_event("status", {"runtimeStatus": "Idle"})
        return {"running": False}

    def get_recent_opportunities(self, limit: int = 80) -> list[dict]:
        return [row.to_dict() for row in self._session.recent_opportunities(limit)]

    def get_session_stats(self) -> dict:
        return self._session.stats().to_dict()

    def export_recommendations_csv(self) -> dict:
        return {"path": str(Path("recommendations_log.csv").resolve())}

    def run_category_scan(self, category_id: str, items: list[dict], city: str = "") -> dict:
        if self._category_scan_running:
            return {"running": True}

        category = str(category_id).strip()
        if not category:
            raise ValueError("Category is required.")
        market_city = str(city or "").strip()
        if not market_city:
            raise ValueError("City is required (choose where the market is open in-game).")
        if not items:
            raise ValueError("No items provided for category scan.")

        normalized_items: list[dict] = []
        for row in items:
            item_name = str(row.get("name") or row.get("queryText") or "").strip()
            item_id = str(row.get("id") or row.get("itemId") or "").strip()
            if not item_name:
                continue
            normalized_items.append(
                {
                    "name": item_name,
                    "base_name": self._strip_item_tier_prefix(item_name),
                    "id": item_id or item_name,
                    "tier": int(row["tier"]) if row.get("tier") is not None else None,
                    "enchant": int(row["enchant"]) if row.get("enchant") is not None else 0,
                }
            )
        if not normalized_items:
            raise ValueError("No valid items to scan.")
        normalized_items = self._apply_category_tier_filter(category_id=category, items=normalized_items)
        if not normalized_items:
            raise ValueError("No items left after tier filter.")
        normalized_items.sort(
            key=lambda item: (
                item.get("base_name", ""),
                item.get("tier") if item.get("tier") is not None else 999,
                item.get("enchant", 0),
            )
        )

        scan_id = utc_now_iso()
        self._write_category_scan_checkpoint(
            {
                "scanId": scan_id,
                "categoryId": category,
                "city": market_city,
                "startedAt": scan_id,
                "updatedAt": scan_id,
                "finishedAt": "",
                "totalItems": len(normalized_items),
                "nextIndex": 0,
                "processed": 0,
                "failures": 0,
                "cancelled": False,
                "completed": False,
                "items": [
                    {
                        "name": str(item.get("name") or ""),
                        "id": str(item.get("id") or ""),
                        "tier": item.get("tier"),
                        "enchant": int(item.get("enchant") or 0),
                    }
                    for item in normalized_items
                ],
            }
        )

        self._category_scan_stop.clear()
        self._category_scan_pause.clear()
        self._category_scan_skip_spacing.clear()
        self._category_scan_running = True
        self._category_scan_thread = threading.Thread(
            target=self._category_scan_worker,
            args=(category, normalized_items, market_city, scan_id),
            daemon=True,
            name="category-scan",
        )
        self._category_scan_thread.start()
        return {
            "running": True,
            "categoryId": category,
            "city": market_city,
            "totalItems": len(normalized_items),
        }

    def stop_category_scan(self) -> dict:
        self._category_scan_stop.set()
        self._category_scan_pause.clear()
        return {"running": self._category_scan_running}

    def pause_category_scan(self) -> dict:
        if not self._category_scan_running:
            return {"paused": False, "running": False}
        self._category_scan_pause.set()
        return {"paused": True, "running": True}

    def resume_category_scan(self) -> dict:
        self._category_scan_pause.clear()
        return {"paused": False, "running": self._category_scan_running}

    def toggle_category_scan_pause(self) -> dict:
        if not self._category_scan_running:
            return {"paused": False, "running": False}
        if self._category_scan_pause.is_set():
            self._category_scan_pause.clear()
            return {"paused": False, "running": True}
        self._category_scan_pause.set()
        return {"paused": True, "running": True}

    def skip_category_scan_delay(self) -> dict:
        if not self._category_scan_running:
            return {"skipped": False, "running": False}
        self._category_scan_skip_spacing.set()
        return {"skipped": True, "running": True}

    def get_category_scan_state(self) -> dict:
        return {
            "running": self._category_scan_running,
            "paused": self._category_scan_pause.is_set(),
        }

    def get_resume_scan_checkpoint(self) -> dict:
        checkpoint = self._load_category_scan_checkpoint()
        if not checkpoint:
            return {"hasCheckpoint": False}
        valid, reason = self._validate_category_scan_checkpoint(checkpoint)
        if not valid:
            return {
                "hasCheckpoint": True,
                "resumable": False,
                "invalid": True,
                "reason": reason,
                "checkpointPath": str(self._category_scan_checkpoint_file.resolve()),
            }
        total = int(checkpoint.get("totalItems") or 0)
        next_index = int(checkpoint.get("nextIndex") or 0)
        return {
            "hasCheckpoint": True,
            "resumable": not bool(checkpoint.get("completed")) and next_index < total,
            "invalid": False,
            "scanId": str(checkpoint.get("scanId") or ""),
            "categoryId": str(checkpoint.get("categoryId") or ""),
            "city": str(checkpoint.get("city") or ""),
            "startedAt": str(checkpoint.get("startedAt") or ""),
            "updatedAt": str(checkpoint.get("updatedAt") or ""),
            "processed": int(checkpoint.get("processed") or 0),
            "failures": int(checkpoint.get("failures") or 0),
            "nextIndex": next_index,
            "totalItems": total,
            "cancelled": bool(checkpoint.get("cancelled")),
            "completed": bool(checkpoint.get("completed")),
            "checkpointPath": str(self._category_scan_checkpoint_file.resolve()),
        }

    def clear_scan_checkpoint(self) -> dict:
        if self._category_scan_running:
            raise RuntimeError("Cannot clear checkpoint while category scan is running.")
        if self._category_scan_checkpoint_file.exists():
            self._category_scan_checkpoint_file.unlink(missing_ok=True)
        return {"cleared": True}

    def resume_category_scan_from_checkpoint(self) -> dict:
        if self._category_scan_running:
            return {"running": True}
        checkpoint = self._load_category_scan_checkpoint()
        if not checkpoint:
            raise ValueError("No saved scan checkpoint found.")
        valid, reason = self._validate_category_scan_checkpoint(checkpoint)
        if not valid:
            raise ValueError(f"Saved checkpoint is invalid: {reason}")
        if bool(checkpoint.get("completed")):
            raise ValueError("Saved scan is already completed.")
        total = int(checkpoint.get("totalItems") or 0)
        next_index = int(checkpoint.get("nextIndex") or 0)
        if next_index >= total:
            raise ValueError("Saved scan has no remaining items to resume.")
        items = list(checkpoint.get("items") or [])
        remaining = items[next_index:]
        if not remaining:
            raise ValueError("Saved scan has no remaining items to resume.")
        return self.run_category_scan(
            category_id=str(checkpoint.get("categoryId") or ""),
            items=remaining,
            city=str(checkpoint.get("city") or ""),
        )

    def _wait_while_category_paused(self) -> None:
        while self._category_scan_pause.is_set() and not self._category_scan_stop.is_set():
            time.sleep(0.12)

    def _interruptible_category_wait(self, seconds: float) -> None:
        if seconds <= 0:
            return
        deadline = time.monotonic() + float(seconds)
        while time.monotonic() < deadline:
            if self._category_scan_stop.is_set():
                return
            if self._category_scan_skip_spacing.is_set():
                self._category_scan_skip_spacing.clear()
                return
            self._wait_while_category_paused()
            if self._category_scan_stop.is_set():
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.1, remaining))

    def _category_scan_worker(
        self,
        category: str,
        normalized_items: list[dict],
        city: str,
        scan_id: str,
    ) -> None:
        self._acquire_single_flight("runCategoryScan")
        started_at = scan_id or utc_now_iso()
        self._emit_event(
            "categoryScanStarted",
            {
                "categoryId": category,
                "city": city,
                "startedAt": started_at,
                "totalItems": len(normalized_items),
            },
        )
        self._emit_event("status", {"runtimeStatus": "Running"})

        processed = 0
        failures = 0
        cancelled = False
        consecutive_no_data = 0
        break_anchor = time.monotonic()
        try:
            for idx, item in enumerate(normalized_items, start=1):
                if self._category_scan_stop.is_set():
                    cancelled = True
                    break
                self._wait_while_category_paused()
                if self._category_scan_stop.is_set():
                    cancelled = True
                    break
                if time.monotonic() - break_anchor >= self._category_break_every_seconds:
                    self._emit_event(
                        "log",
                        {
                            "level": "info",
                            "message": f"Human break: pausing {self._category_break_duration_seconds:.0f}s before next item.",
                        },
                    )
                    self._interruptible_category_wait(self._category_break_duration_seconds)
                    break_anchor = time.monotonic()
                    if self._category_scan_stop.is_set():
                        cancelled = True
                        break
                query_text = self._build_market_query_text(
                    item_name=item["name"],
                    tier=item.get("tier"),
                    enchant=item.get("enchant", 0),
                )
                scan_result = None
                anchor_failed = False
                for anchor_try in range(1, self._search_anchor_retry_limit + 1):
                    scan_result = self._execute_query_scan(
                        query_text=query_text,
                        item_id=item["id"],
                        max_retries=self._max_retries,
                    )
                    err_text = str(scan_result.error or "")
                    if not err_text.startswith("SEARCH_ANCHOR_ERROR:"):
                        break
                    if anchor_try < self._search_anchor_retry_limit:
                        self._emit_event(
                            "log",
                            {
                                "level": "warning",
                                "message": (
                                    f"Search box interaction failed ({anchor_try}/{self._search_anchor_retry_limit}). "
                                    f"Retrying in {int(self._search_anchor_retry_wait_seconds)}s..."
                                ),
                            },
                        )
                        self._interruptible_category_wait(self._search_anchor_retry_wait_seconds)
                        if self._category_scan_stop.is_set():
                            cancelled = True
                            break
                    else:
                        anchor_failed = True
                if cancelled:
                    break
                if scan_result is None:
                    anchor_failed = True
                    scan_result = ScanResult(
                        item_id=item["id"],
                        query_text=query_text,
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        raw_text="",
                        value=None,
                        confidence=0.0,
                        attempts=0,
                        error="SEARCH_ANCHOR_ERROR: scan_result missing after retries",
                    )
                if anchor_failed:
                    cancelled = True
                    self._emit_event(
                        "log",
                        {
                            "level": "warning",
                            "message": (
                                "Search box click/paste failed after 3 retries. "
                                "Stopping scan and closing bot."
                            ),
                        },
                    )
                    self._emit_event(
                        "maintenanceDetected",
                        {
                            "categoryId": category,
                            "city": city,
                            "index": idx,
                            "totalItems": len(normalized_items),
                            "reason": "search_anchor_retry_exhausted",
                        },
                    )
                    break
                if scan_result.value is not None:
                    self._state.set_last_value(scan_result.value)
                    self._logger.append_value(scan_result.value)
                else:
                    failures += 1
                try:
                    numeric_value = int(scan_result.value) if scan_result.value is not None else None
                except Exception:
                    numeric_value = None
                has_data = numeric_value is not None and numeric_value > 1
                if has_data:
                    consecutive_no_data = 0
                else:
                    consecutive_no_data += 1
                self._append_market_price_row(category, city, item, scan_result)
                processed += 1
                self._emit_event(
                    "categoryScanItem",
                    {
                        "categoryId": category,
                        "city": city,
                        "index": idx,
                        "totalItems": len(normalized_items),
                        "failures": failures,
                        "scanResult": scan_result.to_dict(),
                        "item": item,
                    },
                )
                self._write_category_scan_checkpoint(
                    {
                        "scanId": started_at,
                        "categoryId": category,
                        "city": city,
                        "startedAt": started_at,
                        "updatedAt": utc_now_iso(),
                        "finishedAt": "",
                        "totalItems": len(normalized_items),
                        "nextIndex": idx,
                        "processed": processed,
                        "failures": failures,
                        "cancelled": False,
                        "completed": False,
                        "items": [
                            {
                                "name": str(row.get("name") or ""),
                                "id": str(row.get("id") or ""),
                                "tier": row.get("tier"),
                                "enchant": int(row.get("enchant") or 0),
                            }
                            for row in normalized_items
                        ],
                    }
                )
                if consecutive_no_data >= self._category_max_consecutive_no_data:
                    cancelled = True
                    self._emit_event(
                        "log",
                        {
                            "level": "warning",
                            "message": (
                                "Detected 15 consecutive no-data OCR results. "
                                "Possible game maintenance; stopping scan and closing bot."
                            ),
                        },
                    )
                    self._emit_event(
                        "maintenanceDetected",
                        {
                            "categoryId": category,
                            "city": city,
                            "index": idx,
                            "totalItems": len(normalized_items),
                            "consecutiveNoData": consecutive_no_data,
                        },
                    )
                    break
                if idx < len(normalized_items):
                    self._interruptible_category_wait(self._category_item_spacing_seconds)

            finished_at = utc_now_iso()
            summary = {
                "categoryId": category,
                "city": city,
                "startedAt": started_at,
                "finishedAt": finished_at,
                "processed": processed,
                "failures": failures,
                "cancelled": cancelled,
                "outputFile": str(self._market_prices_file.resolve()),
            }
            self._emit_event("categoryScanFinished", summary)
            self._write_category_scan_checkpoint(
                {
                    "scanId": started_at,
                    "categoryId": category,
                    "city": city,
                    "startedAt": started_at,
                    "updatedAt": finished_at,
                    "finishedAt": finished_at,
                    "totalItems": len(normalized_items),
                    "nextIndex": processed,
                    "processed": processed,
                    "failures": failures,
                    "cancelled": cancelled,
                    "completed": not cancelled,
                    "items": [
                        {
                            "name": str(row.get("name") or ""),
                            "id": str(row.get("id") or ""),
                            "tier": row.get("tier"),
                            "enchant": int(row.get("enchant") or 0),
                        }
                        for row in normalized_items
                    ],
                }
            )
        finally:
            self._category_scan_running = False
            self._category_scan_pause.clear()
            self._category_scan_skip_spacing.clear()
            self._emit_event("status", {"runtimeStatus": "Idle"})
            self._release_single_flight()

    def get_price_history(self, limit: int = 500) -> dict:
        cap = max(1, int(limit))
        rows: list[dict] = []
        if self._market_prices_file.exists():
            with self._market_prices_file.open("r", encoding="utf-8", newline="") as fh:
                csv_rows = list(DictReader(fh))
            csv_rows = csv_rows[-cap:]
            csv_rows.reverse()
            rows.extend(csv_rows)
        if self._pg_sink.enabled:
            db_rows = self._pg_sink.fetch_recent_prices(
                limit=cap,
                emit_log=lambda level, msg: self._emit_event("log", {"level": level, "message": msg}),
            )
            rows.extend(db_rows)

        def _ts_key(row: dict) -> datetime:
            raw = str(row.get("timestamp") or "").replace("Z", "+00:00")
            try:
                dt = datetime.fromisoformat(raw)
            except ValueError:
                return datetime.min.replace(tzinfo=timezone.utc)
            if dt.tzinfo is None:
                return dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)

        rows.sort(key=_ts_key, reverse=True)
        rows = rows[:cap]
        return {"rows": rows, "path": str(self._market_prices_file.resolve())}

    def get_market_price_rows(self, payload: dict | None = None) -> dict:
        body = payload or {}
        search = str(body.get("search") or "").strip()
        category = str(body.get("category") or "").strip()
        item_type = str(body.get("type") or "").strip()
        city = str(body.get("city") or "").strip()
        sort = str(body.get("sort") or "last_updated_desc").strip()
        tier_raw = body.get("tier")
        enchant_raw = body.get("enchant")
        tier = int(tier_raw) if tier_raw not in (None, "", "all") else None
        enchant = int(enchant_raw) if enchant_raw not in (None, "", "all") else None
        limit = max(1, int(body.get("limit", 1000)))
        offset = max(0, int(body.get("offset", 0)))
        bot_only = bool(body.get("botOnly", True))

        rows = self._pg_sink.fetch_market_price_rows(
            search=search,
            city=city,
            tier=tier,
            enchant=enchant,
            category=category,
            item_type=item_type,
            sort=sort,
            limit=limit,
            offset=offset,
            bot_only=bot_only,
            emit_log=lambda level, msg: self._emit_event("log", {"level": level, "message": msg}),
        )
        categories = sorted({str(r.get("category") or "").strip() for r in rows if r.get("category")})
        types = sorted({str(r.get("type") or "").strip() for r in rows if r.get("type") and r.get("type") != "-"})
        cities = sorted({str(r.get("city") or "").strip() for r in rows if r.get("city")})
        tiers = sorted({int(r.get("tier")) for r in rows if r.get("tier") is not None})
        enchants = sorted({int(r.get("enchant") or 0) for r in rows})
        return {
            "rows": rows,
            "filters": {
                "categories": categories,
                "types": types,
                "cities": cities,
                "tiers": tiers,
                "enchants": enchants,
            },
        }

    def post_reviewed_prices(self, rows: list[dict]) -> dict:
        if not isinstance(rows, list):
            raise ValueError("rows must be a list.")
        results: list[dict] = []
        posted = 0
        failed = 0
        for row in rows:
            row_id = str(row.get("rowId") or "")
            try:
                item_unique_name = str(row.get("itemUniqueName") or "").strip()
                item_name = str(row.get("itemName") or item_unique_name).strip()
                city = str(row.get("city") or "").strip()
                price = int(row.get("price"))
                if not item_unique_name:
                    raise ValueError("itemUniqueName is required.")
                if not city:
                    raise ValueError("city is required.")
                if price < 0:
                    raise ValueError("price must be zero or greater.")
                ok, err = self._post_item_price_to_database(
                    item_unique_name=item_unique_name,
                    item_name=item_name,
                    tier=(int(row["tier"]) if row.get("tier") is not None else None),
                    enchantment=int(row.get("enchant") or 0),
                    city=city,
                    price=price,
                    posted_at_iso=str(row.get("postedAt") or ""),
                    context="reviewedPost",
                )
                if not ok:
                    raise RuntimeError(err or "Unknown database post error.")
                posted += 1
                results.append({"rowId": row_id, "ok": True, "error": None})
            except Exception as exc:
                failed += 1
                results.append({"rowId": row_id, "ok": False, "error": str(exc)})
        return {"posted": posted, "failed": failed, "results": results}

    def start_loop(self, interval_seconds: float) -> dict:
        if self._state.is_running():
            return {"running": True}
        self._loop_interval_seconds = max(0.2, float(interval_seconds))
        self._loop_stop.clear()
        self._state.set_running(True)
        self._emit_event("status", {"runtimeStatus": "Running"})
        self._loop_thread = threading.Thread(target=self._loop_worker, name="service-loop", daemon=True)
        self._loop_thread.start()
        return {"running": True, "intervalSeconds": self._loop_interval_seconds}

    def stop_loop(self) -> dict:
        self._loop_stop.set()
        self._state.set_running(False)
        if self._loop_thread and self._loop_thread.is_alive():
            self._loop_thread.join(timeout=1.5)
        self._loop_thread = None
        self._emit_event("status", {"runtimeStatus": "Idle"})
        return {"running": False}

    def _loop_worker(self) -> None:
        while not self._loop_stop.is_set():
            try:
                self.run_query_once()
            except Exception as exc:  # pragma: no cover
                self._emit_event("log", {"level": "error", "message": f"Loop error: {exc}"})
            self._loop_stop.wait(self._loop_interval_seconds)
        self._state.set_running(False)
        self._emit_event("status", {"runtimeStatus": "Idle"})

    def _watchlist_loop_worker(self) -> None:
        while not self._watchlist_loop_stop.is_set():
            try:
                self.run_watchlist_scan(item_spacing_seconds=self._watchlist_item_spacing_seconds)
            except Exception as exc:  # pragma: no cover
                self._emit_event("log", {"level": "error", "message": f"Watchlist loop error: {exc}"})
            self._watchlist_loop_stop.wait(self._watchlist_interval_seconds)
        self._state.set_running(False)
        self._emit_event("status", {"runtimeStatus": "Idle"})

    def _execute_query_scan(self, query_text: str, item_id: str, max_retries: int) -> ScanResult:
        search_point = self._state.get_search_point()
        region = self._state.get_region()
        if search_point is None:
            raise RuntimeError("Search point is not calibrated.")
        if region is None:
            raise RuntimeError("Capture region is not calibrated.")

        last_error: Exception | None = None
        for attempt in range(1, max_retries + 2):
            try:
                self._market.run_once(search_point, query_text)
                image_path = self._capture.capture_region(region, self._settings.temp_image_path)
                raw_text = self._ocr.extract_text(image_path)
                value = normalize_numeric_text(raw_text)
                return ScanResult(
                    item_id=item_id,
                    query_text=query_text,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    raw_text=raw_text,
                    value=value,
                    confidence=self._estimate_confidence(raw_text, value),
                    attempts=attempt,
                )
            except Exception as exc:  # pragma: no cover
                if isinstance(exc, SearchAnchorInteractionError):
                    return ScanResult(
                        item_id=item_id,
                        query_text=query_text,
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        raw_text="",
                        value=None,
                        confidence=0.0,
                        attempts=attempt,
                        error=f"SEARCH_ANCHOR_ERROR: {exc}",
                    )
                last_error = exc
        return ScanResult(
            item_id=item_id,
            query_text=query_text,
            timestamp=datetime.now(timezone.utc).isoformat(),
            raw_text="",
            value=None,
            confidence=0.0,
            attempts=max_retries + 1,
            error=str(last_error) if last_error else "Unknown scan error",
        )

    @staticmethod
    def _estimate_confidence(raw_text: str, value: int | None) -> float:
        if value is None:
            return 0.0
        digits = sum(1 for ch in raw_text if ch.isdigit())
        if digits == 0:
            return 0.2
        confidence = 0.45 + min(0.5, digits * 0.07)
        return round(min(1.0, confidence), 3)

    def _acquire_single_flight(self, operation: str) -> None:
        with self._single_flight_lock:
            if self._query_running:
                raise RuntimeError(f"{operation} already in progress.")
            self._query_running = True

    def _release_single_flight(self) -> None:
        with self._single_flight_lock:
            self._query_running = False

    def _diagnostics(self) -> dict:
        tesseract_path = _resolve_tesseract_path()
        stats = self._session.stats()
        return {
            "tesseractAvailable": bool(tesseract_path),
            "tesseractPath": tesseract_path,
            "outputCsv": str(self._settings.output_csv),
            "tempImagePath": str(self._settings.temp_image_path),
            "recommendationsCsv": str(Path("recommendations_log.csv")),
            "watchlistFile": str(Path("watchlist.json")),
            "calibrationFile": str(self._calibration_file),
            "categoryScanCheckpointFile": str(self._category_scan_checkpoint_file),
            "postgresEnabled": self._pg_sink.enabled,
            "defaultPriceCityConfigured": bool(str(self._settings.default_price_city or "").strip()),
            "ocrFailureRate": (
                0.0
                if stats.scan_items_total == 0
                else round((stats.ocr_failures / stats.scan_items_total) * 100.0, 3)
            ),
        }

    def _load_calibration_profile(self) -> None:
        if not self._calibration_file.exists():
            return
        try:
            payload = json.loads(self._calibration_file.read_text(encoding="utf-8"))
            search_point = payload.get("searchPoint")
            region = payload.get("region")
            if search_point:
                self._state.set_search_point(
                    ScreenPoint(
                        x=int(search_point.get("x", 0)),
                        y=int(search_point.get("y", 0)),
                    )
                )
            if region:
                self._state.set_region(
                    CaptureRegion(
                        left=int(region.get("left", 0)),
                        top=int(region.get("top", 0)),
                        width=int(region.get("width", 0)),
                        height=int(region.get("height", 0)),
                    )
                )
        except Exception as exc:  # pragma: no cover
            self._emit_event(
                "log",
                {
                    "level": "error",
                    "message": f"Could not load calibration profile: {exc}",
                },
            )

    def _save_calibration_profile(self) -> None:
        payload = {
            "searchPoint": self._point_to_dict(self._state.get_search_point()),
            "region": self._region_to_dict(self._state.get_region()),
        }
        self._calibration_file.write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )

    def _load_category_scan_checkpoint(self) -> dict | None:
        if not self._category_scan_checkpoint_file.exists():
            return None
        try:
            payload = json.loads(self._category_scan_checkpoint_file.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        return payload

    @staticmethod
    def _validate_category_scan_checkpoint(payload: dict) -> tuple[bool, str | None]:
        required = ("categoryId", "city", "totalItems", "nextIndex", "items")
        for key in required:
            if key not in payload:
                return False, f"missing field: {key}"
        items = payload.get("items")
        if not isinstance(items, list):
            return False, "items must be a list"
        try:
            total = int(payload.get("totalItems") or 0)
            next_index = int(payload.get("nextIndex") or 0)
        except Exception:
            return False, "totalItems/nextIndex must be integers"
        if total < 0 or next_index < 0:
            return False, "negative counters are not allowed"
        if next_index > total:
            return False, "nextIndex cannot be greater than totalItems"
        if total != len(items):
            return False, "totalItems does not match items length"
        return True, None

    def _write_category_scan_checkpoint(self, payload: dict) -> None:
        valid, reason = self._validate_category_scan_checkpoint(payload)
        if not valid:
            self._emit_event(
                "log",
                {"level": "error", "message": f"Checkpoint write skipped (invalid payload): {reason}"},
            )
            return
        tmp = self._category_scan_checkpoint_file.with_suffix(".tmp")
        text = json.dumps(payload, ensure_ascii=True, indent=2)
        with self._category_scan_checkpoint_lock:
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(self._category_scan_checkpoint_file)

    def _migrate_market_csv_if_legacy(self) -> None:
        path = self._market_prices_file
        if not path.exists() or path.stat().st_size == 0:
            return
        with path.open("r", encoding="utf-8", newline="") as fh:
            header = next(csv.reader(fh), None)
        if not header or "city" in header:
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        backup = path.with_name(f"{path.stem}_pre_city_{stamp}{path.suffix}")
        shutil.move(str(path), str(backup))
        self._emit_event(
            "log",
            {
                "level": "info",
                "message": f"Archived previous price log to {backup.name} (schema now includes city).",
            },
        )

    def _post_item_price_to_database(
        self,
        *,
        item_unique_name: str,
        item_name: str,
        city: str,
        price: int,
        posted_at_iso: str | None,
        context: str,
        tier: int | None = None,
        enchantment: int = 0,
        tier_enchant_from_query: str | None = None,
    ) -> tuple[bool, str | None]:
        if not self._pg_sink.enabled:
            return False, "Database posting is disabled (no DB URL configured)."
        display_name = item_name
        tier_val = tier
        enchant_val = enchantment
        if tier_enchant_from_query:
            base, t, en = parse_query_tier_enchant(tier_enchant_from_query)
            display_name = base or display_name
            tier_val = t
            enchant_val = en
        city_clean = str(city or "").strip()
        if not city_clean:
            self._emit_event(
                "log",
                {
                    "level": "warning",
                    "message": (
                        f"Skipping database post ({context}): no city. "
                        "Set ALBION_DEFAULT_PRICE_CITY (watchlist / single query) "
                        "or use category fetch (city from UI)."
                    ),
                },
            )
            return False, "City is required."
        return self._pg_sink.post_fetch(
            item_unique_name=item_unique_name,
            item_name=display_name,
            tier=tier_val,
            enchantment=int(enchant_val),
            city=city_clean,
            price=int(price),
            posted_at_iso=posted_at_iso,
            emit_log=lambda level, msg: self._emit_event("log", {"level": level, "message": msg}),
        )

    def _append_market_price_row(
        self, category_id: str, city: str, item: dict, scan_result: ScanResult
    ) -> None:
        self._migrate_market_csv_if_legacy()
        fieldnames = [
            "timestamp",
            "city",
            "category",
            "item_name",
            "item_id",
            "tier",
            "enchant",
            "observed_price",
            "raw_text",
            "confidence",
            "error",
        ]
        row = {
            "timestamp": scan_result.timestamp,
            "city": city,
            "category": category_id,
            "item_name": item.get("name"),
            "item_id": item.get("id"),
            "tier": item.get("tier"),
            "enchant": item.get("enchant"),
            "observed_price": scan_result.value,
            "raw_text": scan_result.raw_text,
            "confidence": scan_result.confidence,
            "error": scan_result.error or "",
        }
        write_header = not self._market_prices_file.exists() or self._market_prices_file.stat().st_size == 0
        with self._market_prices_file.open("a", encoding="utf-8", newline="") as fh:
            writer = DictWriter(fh, fieldnames=fieldnames)
            if write_header:
                writer.writeheader()
            writer.writerow(row)
        # Category scan DB posting is intentionally review-first via post_reviewed_prices.

    @staticmethod
    def _build_market_query_text(item_name: str, tier: int | None, enchant: int) -> str:
        base_name = BotService._strip_item_tier_prefix(item_name)
        if tier is None:
            return base_name
        return f"{base_name} {tier}.{max(0, int(enchant))}"

    @staticmethod
    def _strip_item_tier_prefix(item_name: str) -> str:
        """Strip tier adjectives so queries match the in-game market (e.g. ``Light Crossbow 4.0``).

        ao-bin-dumps EN-US strings use two patterns:
        - Possessive on the tier word: ``Adept's Light Crossbow``
        - Tier as its own token: ``Adept Mercenary's Trophy``, ``Expert Fiber Harvester Tome``
        """
        possessive = (
            "Grandmaster's ",
            "Journeyman's ",
            "Novice's ",
            "Master's ",
            "Expert's ",
            "Adept's ",
            "Elder's ",
        )
        cleaned = item_name.strip()
        for prefix in possessive:
            if cleaned.startswith(prefix):
                return cleaned[len(prefix) :].strip()
        m = re.match(
            r"^(?:Novice|Journeyman|Adept|Expert|Master|Grandmaster|Elder)\s+(.+)$",
            cleaned,
        )
        if m:
            return m.group(1).strip()
        return cleaned

    @staticmethod
    def _apply_category_tier_filter(category_id: str, items: list[dict]) -> list[dict]:
        min_tier_categories = {
            "weapons",
            "chest_armor",
            "head_armor",
            "foot_armor",
            "bags",
            "capes",
        }
        if category_id not in min_tier_categories:
            return items
        return [item for item in items if item.get("tier") is None or int(item["tier"]) >= 4]

    def _ensure_qt_app(self) -> QApplication:
        app = QApplication.instance()
        if app is None:
            app = QApplication([])
            self._qt_app = app
        return app

    @staticmethod
    def _point_to_dict(point: ScreenPoint | None) -> dict | None:
        if point is None:
            return None
        return {"x": point.x, "y": point.y}

    @staticmethod
    def _region_to_dict(region: CaptureRegion | None) -> dict | None:
        if region is None:
            return None
        return {
            "left": region.left,
            "top": region.top,
            "width": region.width,
            "height": region.height,
        }

    def to_json(self) -> str:
        return json.dumps(self.get_state())
