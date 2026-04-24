from __future__ import annotations

import sys
import threading
import time
from typing import Optional

from PySide6.QtCore import QObject, Signal
from PySide6.QtWidgets import QApplication

from albion_bot.automation.market_query import MarketQueryAutomation
from albion_bot.capture.cursor_position import get_cursor_position
from albion_bot.capture.region_selector import RegionSelector
from albion_bot.capture.screen_capture import ScreenCapture
from albion_bot.config.settings import AppSettings
from albion_bot.control.hotkeys import HotkeyBindings, HotkeyController
from albion_bot.logging.data_logger import DataLogger
from albion_bot.ocr.normalize import normalize_numeric_text
from albion_bot.ocr.ocr_engine import TesseractOCREngine
from albion_bot.overlay.overlay_window import OverlayWindow
from albion_bot.pipeline.capture_runner import CaptureRunner, RunnerDependencies
from albion_bot.state.runtime_state import CaptureRegion, RuntimeState, ScreenPoint


class AppSignals(QObject):
    start_stop_requested = Signal()
    single_capture_requested = Signal()
    calibrate_requested = Signal()
    calibrate_search_point_requested = Signal()
    market_query_once_requested = Signal()
    toggle_overlay_requested = Signal()
    idle_requested = Signal()
    result_ready = Signal(object)
    error_occurred = Signal(str)


class AppController(QObject):
    def __init__(self, settings: AppSettings) -> None:
        super().__init__()
        self._settings = settings
        self._state = RuntimeState()
        self._overlay = OverlayWindow()
        self._signals = AppSignals()
        self._market_action_lock = threading.Lock()
        self._market_action_running = False

        self._capture = ScreenCapture()
        self._ocr = TesseractOCREngine(settings.tesseract_cmd)
        self._logger = DataLogger(settings.output_csv)
        self._market_query = MarketQueryAutomation(
            settle_delay_seconds=settings.ui_settle_delay_seconds,
            post_search_delay_seconds=settings.post_search_delay_seconds,
        )
        self._runner = CaptureRunner(
            deps=RunnerDependencies(
                capture_step=self._capture.capture_region,
                extract_text_step=self._ocr.extract_text,
                normalize_step=normalize_numeric_text,
                persist_step=self._logger.append_value,
                result_step=self._signals.result_ready.emit,
                error_step=self._signals.error_occurred.emit,
            ),
            interval_seconds=settings.capture_interval_seconds,
            temp_image_path=settings.temp_image_path,
        )

        self._signals.start_stop_requested.connect(self._toggle_start_stop)
        self._signals.single_capture_requested.connect(self._single_capture)
        self._signals.calibrate_requested.connect(self._calibrate_region)
        self._signals.calibrate_search_point_requested.connect(self._calibrate_search_point)
        self._signals.market_query_once_requested.connect(self._market_query_once)
        self._signals.toggle_overlay_requested.connect(self._overlay.toggle_visible)
        self._signals.idle_requested.connect(self._set_idle_status)
        self._signals.result_ready.connect(self._handle_result)
        self._signals.error_occurred.connect(self._handle_error)

        self._hotkeys = HotkeyController(
            bindings=HotkeyBindings(
                start_stop=settings.hotkeys.start_stop,
                single_capture=settings.hotkeys.single_capture,
                calibrate_region=settings.hotkeys.calibrate_region,
                toggle_overlay=settings.hotkeys.toggle_overlay,
                calibrate_search_point=settings.hotkeys.calibrate_search_point,
                run_market_query_once=settings.hotkeys.run_market_query_once,
            ),
            on_start_stop=self._signals.start_stop_requested.emit,
            on_single_capture=self._signals.single_capture_requested.emit,
            on_calibrate=self._signals.calibrate_requested.emit,
            on_toggle_overlay=self._signals.toggle_overlay_requested.emit,
            on_calibrate_search_point=self._signals.calibrate_search_point_requested.emit,
            on_market_query_once=self._signals.market_query_once_requested.emit,
        )
        self._hotkeys.register()
        self._set_idle_status()

    def close(self) -> None:
        self._runner.stop()
        self._state.set_running(False)
        self._hotkeys.unregister()

    def _toggle_start_stop(self) -> None:
        if self._runner.is_running:
            self._runner.stop()
            self._state.set_running(False)
            self._set_idle_status()
            return

        region = self._state.get_region()
        if region is None:
            self._overlay.set_status("Idle (Calibrate first)")
            return

        started = self._runner.start(region)
        if started:
            self._state.set_running(True)
            self._overlay.set_status("Running")

    def _single_capture(self) -> None:
        region = self._state.get_region()
        if region is None:
            self._overlay.set_status("Idle (Calibrate first)")
            return

        self._overlay.set_status("Single Capture")
        worker = threading.Thread(target=self._run_single_capture_worker, args=(region,), daemon=True)
        worker.start()

    def _run_single_capture_worker(self, region: CaptureRegion) -> None:
        try:
            self._runner.run_once(region)
        except Exception as exc:  # pragma: no cover - runtime safety
            self._signals.error_occurred.emit(f"Single capture error: {exc}")

    def _market_query_once(self) -> None:
        region = self._state.get_region()
        point = self._state.get_search_point()
        if region is None:
            self._overlay.set_status("Idle (Calibrate price region first)")
            return
        if point is None:
            self._overlay.set_status("Idle (Calibrate search point first)")
            return
        with self._market_action_lock:
            if self._market_action_running:
                self._overlay.set_status("Search + Capture (already running)")
                return
            self._market_action_running = True

        self._overlay.set_status("Search + Capture")
        worker = threading.Thread(
            target=self._run_market_query_worker,
            args=(point, region),
            daemon=True,
        )
        worker.start()

    def _run_market_query_worker(self, point: ScreenPoint, region: CaptureRegion) -> None:
        completed_without_error = False
        try:
            self._market_query.run_once(point, self._settings.market_search_text)
            self._runner.run_once(region)
            completed_without_error = True
        except Exception as exc:  # pragma: no cover - runtime safety
            self._signals.error_occurred.emit(f"Market query error: {exc}")
        finally:
            with self._market_action_lock:
                self._market_action_running = False
            if completed_without_error and not self._runner.is_running:
                time.sleep(0.05)
                self._signals.idle_requested.emit()

    def _calibrate_region(self) -> None:
        was_visible = self._overlay.isVisible()
        if was_visible:
            self._overlay.hide()

        try:
            region = RegionSelector.select_region()
        except Exception as exc:
            self._signals.error_occurred.emit(f"Region calibration error: {exc}")
            if was_visible:
                self._overlay.show()
            return

        if was_visible:
            self._overlay.show()
        if region is None:
            self._set_idle_status()
            return

        self._state.set_region(region)
        self._overlay.set_status(
            f"Idle (Region {region.width}x{region.height} at {region.left},{region.top})"
        )

    def _calibrate_search_point(self) -> None:
        try:
            point = get_cursor_position()
        except Exception as exc:
            self._signals.error_occurred.emit(f"Search point calibration error: {exc}")
            return
        self._state.set_search_point(point)
        self._overlay.set_status(f"Idle (Search point at {point.x},{point.y})")

    def _handle_result(self, value: Optional[int]) -> None:
        self._state.set_last_value(value)
        self._overlay.set_last_value(value)
        if self._runner.is_running:
            self._overlay.set_status("Running")
        else:
            self._set_idle_status()

    def _handle_error(self, message: str) -> None:
        lower = message.lower()
        if "tesseract" in lower and "not" in lower and "found" in lower:
            self._overlay.set_status("OCR unavailable: install Tesseract")
        else:
            condensed = message.replace("\n", " ").strip()
            self._overlay.set_status(f"Error: {condensed[:60]}")
        print(message, flush=True)

    def _set_idle_status(self) -> None:
        self._overlay.set_status("Idle")


def main() -> int:
    app = QApplication(sys.argv)
    settings = AppSettings()
    controller = AppController(settings)
    app.aboutToQuit.connect(controller.close)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())

