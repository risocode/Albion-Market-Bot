from __future__ import annotations

from pathlib import Path

import mss
from PIL import Image

from albion_bot.state.runtime_state import CaptureRegion


class ScreenCapture:
    def __init__(self) -> None:
        self._sct = mss.mss()

    def capture_region(self, region: CaptureRegion, output_path: Path) -> Path:
        shot = self._sct.grab(
            {
                "left": region.left,
                "top": region.top,
                "width": region.width,
                "height": region.height,
            }
        )
        image = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path)
        return output_path

