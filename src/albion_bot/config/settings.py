from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env_strip(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def _env_bool(key: str, default: bool = True) -> bool:
    raw = _env_strip(key)
    if not raw:
        return default
    return raw.lower() not in ("0", "false", "no", "off")


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
    database_url: str = field(
        default_factory=lambda: _env_strip("ALBION_BOT_DATABASE_URL") or _env_strip("DATABASE_URL")
    )
    default_price_city: str = field(default_factory=lambda: _env_strip("ALBION_DEFAULT_PRICE_CITY"))
    price_source: str = field(
        default_factory=lambda: _env_strip("ALBION_PRICE_SOURCE") or "albion_market_bot"
    )
    database_include_history: bool = field(default_factory=lambda: _env_bool("ALBION_DB_INCLUDE_HISTORY", True))

