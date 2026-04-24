from __future__ import annotations

import ctypes
from ctypes import wintypes

from albion_bot.state.runtime_state import ScreenPoint


class _POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


def get_cursor_position() -> ScreenPoint:
    point = _POINT()
    if not ctypes.windll.user32.GetCursorPos(ctypes.byref(point)):
        raise RuntimeError("Could not read cursor position.")
    return ScreenPoint(x=int(point.x), y=int(point.y))

