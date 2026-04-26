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
            safe_query = self._sanitize_query_text(query_text)
            self._click(search_point.x, search_point.y)
            time.sleep(self._with_jitter(self._settle_delay_seconds))
            self._clear_search_box()
            try:
                pyperclip.copy(safe_query)
                time.sleep(self._with_jitter(0.02))
                keyboard.press_and_release("ctrl+v")
                time.sleep(self._with_jitter(0.035))
            except Exception:
                # Fallback path when clipboard interaction fails in some sessions.
                keyboard.write(safe_query, delay=self._with_jitter(self._key_delay_base_seconds))
                time.sleep(self._with_jitter(0.02))
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

    def _clear_search_box(self) -> None:
        """
        Force-clear market search box before each query.
        Running the sequence twice avoids sticky leftovers in some sessions.
        """
        for _ in range(2):
            keyboard.press_and_release("ctrl+a")
            time.sleep(self._with_jitter(0.02))
            keyboard.press_and_release("backspace")
            time.sleep(self._with_jitter(0.015))
            keyboard.press_and_release("ctrl+a")
            time.sleep(self._with_jitter(0.015))
            keyboard.press_and_release("delete")
            time.sleep(self._with_jitter(0.02))

    @staticmethod
    def _sanitize_query_text(query_text: str) -> str:
        """Normalize spacing/apostrophes so bot paste matches manual paste."""
        text = str(query_text or "")
        apostrophe_variants = {
            "\u2019": "'",  # right single quote
            "\u2018": "'",  # left single quote
            "\u02bc": "'",  # modifier letter apostrophe
            "\u00b4": "'",  # acute accent
            "`": "'",
        }
        for src, dst in apostrophe_variants.items():
            text = text.replace(src, dst)
        # Collapse all whitespace into single spaces and trim.
        text = " ".join(text.split())
        return text

