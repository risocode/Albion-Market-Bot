from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_env_files() -> None:
    """Load simple KEY=VALUE pairs from .env.local / .env if present.

    Existing process environment values are preserved (file values only fill missing keys).
    """
    def _load_one(path: Path) -> None:
        if not path.exists():
            return
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if not key:
                continue
            if (value.startswith('"') and value.endswith('"')) or (
                value.startswith("'") and value.endswith("'")
            ):
                value = value[1:-1]
            os.environ.setdefault(key, value)

    # Priority:
    # 1) explicit env dir from Electron userData (persistent across updates)
    # 2) current working directory (dev/local runs)
    env_dirs: list[Path] = []
    configured_dir = os.environ.get("ALBION_BOT_ENV_DIR", "").strip()
    if configured_dir:
        env_dirs.append(Path(configured_dir))
    env_dirs.append(Path.cwd())

    for root in env_dirs:
        for env_name in (".env.local", ".env"):
            _load_one(root / env_name)


_load_env_files()


def _env_strip(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def _first_env(*keys: str) -> str:
    for key in keys:
        value = _env_strip(key)
        if value:
            return value
    return ""


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
        default_factory=lambda: _first_env(
            "ALBION_BOT_DATABASE_URL",
            "DATABASE_URL",
            "POSTGRES_URL",
            "POSTGRES_PRISMA_URL",
            "POSTGRES_URL_NON_POOLING",
        )
    )
    default_price_city: str = field(default_factory=lambda: _env_strip("ALBION_DEFAULT_PRICE_CITY"))
    price_source: str = field(
        default_factory=lambda: _env_strip("ALBION_PRICE_SOURCE") or "albion_market_bot"
    )
    database_include_history: bool = field(default_factory=lambda: _env_bool("ALBION_DB_INCLUDE_HISTORY", True))

