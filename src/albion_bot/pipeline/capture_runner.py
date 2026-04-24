from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from albion_bot.state.runtime_state import CaptureRegion


CaptureStep = Callable[[CaptureRegion, Path], Path]
ExtractTextStep = Callable[[Path], str]
NormalizeStep = Callable[[str], int | None]
PersistStep = Callable[[int | None], None]
ResultStep = Callable[[int | None], None]
ErrorStep = Callable[[str], None]


@dataclass(slots=True)
class RunnerDependencies:
    capture_step: CaptureStep
    extract_text_step: ExtractTextStep
    normalize_step: NormalizeStep
    persist_step: PersistStep
    result_step: ResultStep
    error_step: ErrorStep


class CaptureRunner:
    def __init__(
        self,
        deps: RunnerDependencies,
        interval_seconds: float,
        temp_image_path: Path,
    ) -> None:
        self._deps = deps
        self._interval_seconds = interval_seconds
        self._temp_image_path = temp_image_path
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, region: CaptureRegion) -> bool:
        if self.is_running:
            return False
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._loop,
            args=(region,),
            name="capture-runner",
            daemon=True,
        )
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None

    def run_once(self, region: CaptureRegion) -> int | None:
        image_path = self._deps.capture_step(region, self._temp_image_path)
        raw_text = self._deps.extract_text_step(image_path)
        value = self._deps.normalize_step(raw_text)
        self._deps.persist_step(value)
        self._deps.result_step(value)
        return value

    def _loop(self, region: CaptureRegion) -> None:
        while not self._stop_event.is_set():
            try:
                self.run_once(region)
            except Exception as exc:  # pragma: no cover - runtime safety
                self._deps.error_step(f"Capture loop error: {exc}")
            self._stop_event.wait(self._interval_seconds)

