from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(slots=True)
class HotkeySettings:
    start_stop: str = "f8"
    single_capture: str = "f9"
    calibrate_region: str = "f10"
    toggle_overlay: str = "f11"
    calibrate_search_point: str = "f6"
    run_market_query_once: str = "f7"


@dataclass(slots=True)
class AppSettings:
    capture_interval_seconds: float = 1.0
    output_csv: Path = Path("capture_log.csv")
    temp_image_path: Path = Path("temp_capture.png")
    tesseract_cmd: str | None = None
    market_search_text: str = "scholar robe 5.1"
    ui_settle_delay_seconds: float = 0.35
    post_search_delay_seconds: float = 0.6
    hotkeys: HotkeySettings = field(default_factory=HotkeySettings)

