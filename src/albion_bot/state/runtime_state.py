from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Optional


@dataclass(slots=True)
class CaptureRegion:
    left: int
    top: int
    width: int
    height: int


@dataclass(slots=True)
class ScreenPoint:
    x: int
    y: int


class RuntimeState:
    def __init__(self) -> None:
        self._lock = Lock()
        self._is_running = False
        self._last_value: Optional[int] = None
        self._region: Optional[CaptureRegion] = None
        self._search_point: Optional[ScreenPoint] = None

    def set_running(self, value: bool) -> None:
        with self._lock:
            self._is_running = value

    def is_running(self) -> bool:
        with self._lock:
            return self._is_running

    def set_last_value(self, value: Optional[int]) -> None:
        with self._lock:
            self._last_value = value

    def get_last_value(self) -> Optional[int]:
        with self._lock:
            return self._last_value

    def set_region(self, region: Optional[CaptureRegion]) -> None:
        with self._lock:
            self._region = region

    def get_region(self) -> Optional[CaptureRegion]:
        with self._lock:
            return self._region

    def set_search_point(self, point: Optional[ScreenPoint]) -> None:
        with self._lock:
            self._search_point = point

    def get_search_point(self) -> Optional[ScreenPoint]:
        with self._lock:
            return self._search_point

