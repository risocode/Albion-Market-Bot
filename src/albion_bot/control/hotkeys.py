from __future__ import annotations

import ctypes
import threading
import time
from dataclasses import dataclass
from typing import Callable

import keyboard


@dataclass(slots=True)
class HotkeyBindings:
    start_stop: str
    single_capture: str
    calibrate_region: str
    toggle_overlay: str
    calibrate_search_point: str
    run_market_query_once: str


class HotkeyController:
    def __init__(
        self,
        bindings: HotkeyBindings,
        on_start_stop: Callable[[], None],
        on_single_capture: Callable[[], None],
        on_calibrate: Callable[[], None],
        on_toggle_overlay: Callable[[], None],
        on_calibrate_search_point: Callable[[], None],
        on_market_query_once: Callable[[], None],
    ) -> None:
        self._bindings = bindings
        self._on_start_stop = on_start_stop
        self._on_single_capture = on_single_capture
        self._on_calibrate = on_calibrate
        self._on_toggle_overlay = on_toggle_overlay
        self._on_calibrate_search_point = on_calibrate_search_point
        self._on_market_query_once = on_market_query_once
        self._hotkey_refs: list[int] = []
        self._poll_stop = threading.Event()
        self._poll_thread: threading.Thread | None = None
        self._pressed_states: dict[str, bool] = {}
        self._mouse_pressed_states: dict[str, bool] = {
            "xbutton1": False,
            "xbutton2": False,
        }
        self._last_trigger_at: dict[str, float] = {}
        self._debounce_seconds = 0.35

    def register(self) -> None:
        self._register_many(
            [self._bindings.start_stop, "ctrl+alt+8"],
            "start_stop",
            self._on_start_stop,
        )
        self._register_many(
            [self._bindings.single_capture, "ctrl+alt+9"],
            "single_capture",
            self._on_single_capture,
        )
        self._register_many(
            [self._bindings.calibrate_region, "ctrl+alt+0"],
            "calibrate_region",
            self._on_calibrate,
        )
        self._register_many(
            [self._bindings.toggle_overlay, "ctrl+alt+h"],
            "toggle_overlay",
            self._on_toggle_overlay,
        )
        self._register_many(
            [self._bindings.calibrate_search_point, "ctrl+alt+6"],
            "calibrate_search_point",
            self._on_calibrate_search_point,
        )
        self._register_many(
            [self._bindings.run_market_query_once, "ctrl+alt+7"],
            "market_query_once",
            self._on_market_query_once,
        )
        self._start_poll_fallback()

    def _register_many(self, hotkeys: list[str], action_key: str, callback: Callable[[], None]) -> None:
        for hotkey in hotkeys:
            try:
                self._hotkey_refs.append(
                    keyboard.add_hotkey(hotkey, lambda key=action_key, cb=callback: self._invoke_once(key, cb))
                )
            except Exception:
                # Some fullscreen/directx contexts can reject hook registration.
                continue

    def _start_poll_fallback(self) -> None:
        self._poll_stop.clear()
        self._poll_thread = threading.Thread(target=self._poll_loop, name="hotkey-poll", daemon=True)
        self._poll_thread.start()

    def _poll_loop(self) -> None:
        callbacks: dict[str, tuple[str, Callable[[], None]]] = {
            "f8": ("start_stop", self._on_start_stop),
            "f9": ("single_capture", self._on_single_capture),
            "f10": ("calibrate_region", self._on_calibrate),
            "f11": ("toggle_overlay", self._on_toggle_overlay),
            "f6": ("calibrate_search_point", self._on_calibrate_search_point),
            "f7": ("market_query_once", self._on_market_query_once),
            "ctrl+alt+6": ("calibrate_search_point", self._on_calibrate_search_point),
            "ctrl+alt+0": ("calibrate_region", self._on_calibrate),
            "ctrl+alt+7": ("market_query_once", self._on_market_query_once),
            "ctrl+alt+8": ("start_stop", self._on_start_stop),
            "ctrl+alt+9": ("single_capture", self._on_single_capture),
            "ctrl+alt+h": ("toggle_overlay", self._on_toggle_overlay),
        }
        for key_name in callbacks:
            self._pressed_states[key_name] = False

        while not self._poll_stop.is_set():
            for key_name, (action_key, callback) in callbacks.items():
                pressed = self._is_pressed(key_name)
                was_pressed = self._pressed_states.get(key_name, False)
                if pressed and not was_pressed:
                    self._invoke_once(action_key, callback)
                self._pressed_states[key_name] = pressed

            # Mouse-button fallback for fullscreen contexts:
            # XBUTTON1 => calibrate search point
            # XBUTTON2 => calibrate region corner / finalize region
            x1 = self._mouse_down("xbutton1")
            if x1 and not self._mouse_pressed_states["xbutton1"]:
                self._invoke_once("xbutton1", self._on_calibrate_search_point)
            self._mouse_pressed_states["xbutton1"] = x1

            x2 = self._mouse_down("xbutton2")
            if x2 and not self._mouse_pressed_states["xbutton2"]:
                self._invoke_once("xbutton2", self._on_calibrate)
            self._mouse_pressed_states["xbutton2"] = x2
            time.sleep(0.02)

    def _invoke_once(self, action_key: str, callback: Callable[[], None]) -> None:
        now = time.monotonic()
        last = self._last_trigger_at.get(action_key, 0.0)
        if now - last < self._debounce_seconds:
            return
        self._last_trigger_at[action_key] = now
        callback()

    def _is_pressed(self, hotkey: str) -> bool:
        if "+" not in hotkey:
            return self._vk_down(hotkey)
        parts = [part.strip().lower() for part in hotkey.split("+")]
        return all(self._vk_down(part) for part in parts)

    def _vk_down(self, key_name: str) -> bool:
        vk = _VK_MAP.get(key_name)
        if vk is None:
            return False
        return bool(ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000)

    def _mouse_down(self, button_name: str) -> bool:
        vk = _MOUSE_VK_MAP.get(button_name)
        if vk is None:
            return False
        return bool(ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000)

    def unregister(self) -> None:
        self._poll_stop.set()
        if self._poll_thread and self._poll_thread.is_alive():
            self._poll_thread.join(timeout=1.0)
        self._poll_thread = None

        for hotkey_id in self._hotkey_refs:
            try:
                keyboard.remove_hotkey(hotkey_id)
            except Exception:
                continue
        self._hotkey_refs.clear()


_VK_MAP = {
    "ctrl": 0x11,
    "alt": 0x12,
    "h": 0x48,
    "f6": 0x75,
    "f7": 0x76,
    "f8": 0x77,
    "f9": 0x78,
    "f10": 0x79,
    "f11": 0x7A,
    "0": 0x30,
    "6": 0x36,
    "7": 0x37,
    "8": 0x38,
    "9": 0x39,
}

_MOUSE_VK_MAP = {
    "xbutton1": 0x05,
    "xbutton2": 0x06,
}

