from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path


class DataLogger:
    def __init__(self, output_path: Path) -> None:
        self._output_path = output_path

    def append_value(self, value: int | None) -> None:
        self._output_path.parent.mkdir(parents=True, exist_ok=True)
        file_exists = self._output_path.exists()
        with self._output_path.open("a", newline="", encoding="utf-8") as file_obj:
            writer = csv.DictWriter(file_obj, fieldnames=["timestamp", "value"])
            if not file_exists:
                writer.writeheader()
            writer.writerow(
                {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "value": "" if value is None else str(value),
                }
            )

