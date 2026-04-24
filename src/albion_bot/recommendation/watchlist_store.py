from __future__ import annotations

import json
from pathlib import Path

from albion_bot.recommendation.models import WatchItem


class WatchlistStore:
    def __init__(self, file_path: Path) -> None:
        self._file_path = file_path

    def load(self) -> list[WatchItem]:
        if not self._file_path.exists():
            return []
        payload = json.loads(self._file_path.read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            return []
        return [WatchItem.from_dict(item) for item in payload]

    def save(self, items: list[WatchItem]) -> None:
        self._file_path.parent.mkdir(parents=True, exist_ok=True)
        payload = [item.to_dict() for item in items]
        self._file_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

