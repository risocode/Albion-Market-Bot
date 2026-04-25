from __future__ import annotations

import json
import sys
import threading
from typing import Any

from albion_bot.config.settings import AppSettings
from albion_bot.service_core import BotService


class ServiceProtocolError(Exception):
    pass


class ServiceHost:
    def __init__(self) -> None:
        self._stdout_lock = threading.Lock()
        self._service = BotService(settings=AppSettings(), emit_event=self.emit_event)

    def emit_event(self, event: str, payload: dict) -> None:
        self._write_line({"type": "event", "event": event, "payload": payload})

    def serve_forever(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
                response = self._handle_request(request)
            except Exception as exc:
                request_id = None
                try:
                    request_id = json.loads(line).get("requestId")
                except Exception:
                    request_id = None
                response = {
                    "type": "response",
                    "requestId": request_id,
                    "error": str(exc),
                    "payload": None,
                }
            self._write_line(response)

    def _handle_request(self, request: dict[str, Any]) -> dict:
        if request.get("type") != "request":
            raise ServiceProtocolError("Invalid message type; expected 'request'.")
        request_id = request.get("requestId")
        command = request.get("command")
        payload = request.get("payload") or {}

        handler = self._command_handler(command)
        result_payload = handler(payload)
        return {"type": "response", "requestId": request_id, "error": None, "payload": result_payload}

    def _command_handler(self, command: str):
        mapping = {
            "getState": lambda _payload: self._service.get_state(),
            "captureCursor": lambda _payload: self._service.capture_cursor(),
            "selectPoint": lambda _payload: self._service.select_point(),
            "selectRegion": lambda _payload: self._service.select_region(),
            "setSearchPoint": lambda payload: self._service.set_search_point(
                x=int(payload["x"]),
                y=int(payload["y"]),
            ),
            "setRegion": lambda payload: self._service.set_region(
                left=int(payload["left"]),
                top=int(payload["top"]),
                width=int(payload["width"]),
                height=int(payload["height"]),
            ),
            "setQueryText": lambda payload: self._service.set_query_text(payload["queryText"]),
            "runQueryOnce": lambda _payload: self._service.run_query_once(),
            "listWatchItems": lambda _payload: self._service.list_watch_items(),
            "addWatchItem": lambda payload: self._service.add_watch_item(
                query_text=payload["queryText"],
                target_price=payload.get("targetPrice"),
                min_profit_pct=float(payload.get("minProfitPct", 5.0)),
                tags=payload.get("tags", []),
            ),
            "updateWatchItem": lambda payload: self._service.update_watch_item(
                item_id=payload["itemId"], payload=payload
            ),
            "removeWatchItem": lambda payload: self._service.remove_watch_item(payload["itemId"]),
            "toggleWatchItem": lambda payload: self._service.toggle_watch_item(payload["itemId"]),
            "runWatchlistScan": lambda payload: self._service.run_watchlist_scan(
                item_spacing_seconds=float(payload.get("itemSpacingSeconds", 0.25))
            ),
            "startWatchlistLoop": lambda payload: self._service.start_watchlist_loop(
                interval_seconds=float(payload.get("intervalSeconds", 2.0)),
                item_spacing_seconds=float(payload.get("itemSpacingSeconds", 0.25)),
            ),
            "stopWatchlistLoop": lambda _payload: self._service.stop_watchlist_loop(),
            "getSessionStats": lambda _payload: self._service.get_session_stats(),
            "getRecentOpportunities": lambda payload: self._service.get_recent_opportunities(
                limit=int(payload.get("limit", 80))
            ),
            "exportRecommendationsCsv": lambda _payload: self._service.export_recommendations_csv(),
            "startLoop": lambda payload: self._service.start_loop(
                interval_seconds=float(payload.get("intervalSeconds", 1.0))
            ),
            "stopLoop": lambda _payload: self._service.stop_loop(),
            "setHumanization": lambda payload: self._service.set_humanization(
                settle_delay_seconds=float(payload["settleDelaySeconds"]),
                post_search_delay_seconds=float(payload["postSearchDelaySeconds"]),
                jitter_ratio=float(payload["jitterRatio"]),
                key_delay_base_ms=int(payload["keyDelayBaseMs"]),
            ),
            "runCategoryScan": lambda payload: self._service.run_category_scan(
                category_id=str(payload["categoryId"]),
                items=payload.get("items", []),
                city=str(payload.get("city") or ""),
            ),
            "stopCategoryScan": lambda _payload: self._service.stop_category_scan(),
            "pauseCategoryScan": lambda _payload: self._service.pause_category_scan(),
            "resumeCategoryScan": lambda _payload: self._service.resume_category_scan(),
            "toggleCategoryScanPause": lambda _payload: self._service.toggle_category_scan_pause(),
            "skipCategoryScanDelay": lambda _payload: self._service.skip_category_scan_delay(),
            "getCategoryScanState": lambda _payload: self._service.get_category_scan_state(),
            "getResumeScanCheckpoint": lambda _payload: self._service.get_resume_scan_checkpoint(),
            "resumeCategoryScanFromCheckpoint": lambda _payload: self._service.resume_category_scan_from_checkpoint(),
            "clearCategoryScanCheckpoint": lambda _payload: self._service.clear_scan_checkpoint(),
            "getPriceHistory": lambda payload: self._service.get_price_history(
                limit=int(payload.get("limit", 500))
            ),
            "getMarketPriceRows": lambda payload: self._service.get_market_price_rows(payload),
            "postReviewedPrices": lambda payload: self._service.post_reviewed_prices(
                rows=payload.get("rows", [])
            ),
        }
        if command not in mapping:
            raise ServiceProtocolError(f"Unsupported command: {command}")
        return mapping[command]

    def _write_line(self, obj: dict) -> None:
        with self._stdout_lock:
            sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
            sys.stdout.flush()


def main() -> int:
    host = ServiceHost()
    host.emit_event("log", {"level": "info", "message": "Python backend service ready"})
    host.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
