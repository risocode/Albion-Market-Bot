from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from PySide6.QtWidgets import QApplication

from albion_bot.automation.market_query import MarketQueryAutomation
from albion_bot.capture.cursor_position import get_cursor_position
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

        self._watchlist_loop_thread: threading.Thread | None = None
        self._watchlist_loop_stop = threading.Event()
        self._watchlist_interval_seconds = settings.capture_interval_seconds
        self._watchlist_item_spacing_seconds = 0.25
        self._calibration_file = Path("calibration_profile.json")
        self._load_calibration_profile()

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
