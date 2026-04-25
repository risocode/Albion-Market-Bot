from __future__ import annotations

import ctypes
import random
import time

import keyboard
import pyperclip

from albion_bot.state.runtime_state import ScreenPoint


class SearchAnchorInteractionError(RuntimeError):
    """Raised when search-box interaction (click/type/paste) cannot be performed."""


class MarketQueryAutomation:
    LEFTDOWN = 0x0002
    LEFTUP = 0x0004

    def __init__(self, settle_delay_seconds: float, post_search_delay_seconds: float) -> None:
        self._settle_delay_seconds = settle_delay_seconds
        self._post_search_delay_seconds = post_search_delay_seconds
        self._jitter_ratio = 0.1
        self._key_delay_base_seconds = 0.012
        self._user32 = ctypes.windll.user32

    def set_humanization(
        self,
        settle_delay_seconds: float,
        post_search_delay_seconds: float,
        jitter_ratio: float,
        key_delay_base_ms: int,
    ) -> None:
        self._settle_delay_seconds = max(0.0, settle_delay_seconds)
        self._post_search_delay_seconds = max(0.0, post_search_delay_seconds)
        self._jitter_ratio = min(max(jitter_ratio, 0.0), 0.5)
        self._key_delay_base_seconds = max(0.0, key_delay_base_ms / 1000.0)

    def run_once(self, search_point: ScreenPoint, query_text: str) -> None:
        try:
            self._click(search_point.x, search_point.y)
            time.sleep(self._with_jitter(self._settle_delay_seconds))

            keyboard.press_and_release("ctrl+a")
            keyboard.press_and_release("backspace")
            try:
                pyperclip.copy(query_text)
                keyboard.press_and_release("ctrl+v")
            except Exception:
                # Fallback path when clipboard interaction fails in some sessions.
                keyboard.write(query_text, delay=self._with_jitter(self._key_delay_base_seconds))
            keyboard.press_and_release("enter")
        except Exception as exc:
            raise SearchAnchorInteractionError(f"Search anchor interaction failed: {exc}") from exc

        time.sleep(self._with_jitter(self._post_search_delay_seconds))

    def _click(self, x: int, y: int) -> None:
        ok = self._user32.SetCursorPos(x, y)
        if not ok:
            raise SearchAnchorInteractionError("SetCursorPos failed.")
        self._user32.mouse_event(self.LEFTDOWN, 0, 0, 0, 0)
        self._user32.mouse_event(self.LEFTUP, 0, 0, 0, 0)

    def _with_jitter(self, base_seconds: float) -> float:
        if base_seconds <= 0:
            return 0
        delta = base_seconds * self._jitter_ratio
        return max(0.0, random.uniform(base_seconds - delta, base_seconds + delta))

