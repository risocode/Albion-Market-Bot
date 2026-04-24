from __future__ import annotations

import csv
from pathlib import Path

from albion_bot.recommendation.models import Opportunity


class RecommendationExporter:
    def __init__(self, file_path: Path) -> None:
        self._file_path = file_path

    def append(self, opportunity: Opportunity) -> None:
        self._file_path.parent.mkdir(parents=True, exist_ok=True)
        exists = self._file_path.exists()
        with self._file_path.open("a", encoding="utf-8", newline="") as file_obj:
            writer = csv.DictWriter(
                file_obj,
                fieldnames=[
                    "timestamp",
                    "item_id",
                    "query_text",
                    "observed_value",
                    "target_price",
                    "baseline_value",
                    "delta_value",
                    "delta_pct",
                    "score",
                    "label",
                    "reason",
                    "raw_text",
                ],
            )
            if not exists:
                writer.writeheader()
            writer.writerow(
                {
                    "timestamp": opportunity.timestamp,
                    "item_id": opportunity.item_id,
                    "query_text": opportunity.query_text,
                    "observed_value": opportunity.observed_value,
                    "target_price": opportunity.target_price,
                    "baseline_value": opportunity.baseline_value,
                    "delta_value": opportunity.delta_value,
                    "delta_pct": opportunity.delta_pct,
                    "score": opportunity.score,
                    "label": opportunity.label,
                    "reason": opportunity.reason,
                    "raw_text": opportunity.raw_text,
                }
            )

