from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4


RecommendationLabel = Literal["strong", "watch", "skip"]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(slots=True)
class WatchItem:
    id: str = field(default_factory=lambda: str(uuid4()))
    query_text: str = ""
    target_price: float | None = None
    min_profit_pct: float = 5.0
    enabled: bool = True
    tags: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "queryText": self.query_text,
            "targetPrice": self.target_price,
            "minProfitPct": self.min_profit_pct,
            "enabled": self.enabled,
            "tags": self.tags,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @staticmethod
    def from_dict(payload: dict) -> "WatchItem":
        return WatchItem(
            id=str(payload.get("id") or str(uuid4())),
            query_text=str(payload.get("queryText", "")).strip(),
            target_price=(
                float(payload["targetPrice"])
                if payload.get("targetPrice") is not None
                else None
            ),
            min_profit_pct=float(payload.get("minProfitPct", 5.0)),
            enabled=bool(payload.get("enabled", True)),
            tags=[str(tag) for tag in payload.get("tags", [])],
            created_at=str(payload.get("createdAt") or utc_now_iso()),
            updated_at=str(payload.get("updatedAt") or utc_now_iso()),
        )


@dataclass(slots=True)
class ScanResult:
    item_id: str
    query_text: str
    timestamp: str
    raw_text: str
    value: int | None
    confidence: float
    attempts: int = 1
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "itemId": self.item_id,
            "queryText": self.query_text,
            "timestamp": self.timestamp,
            "rawText": self.raw_text,
            "value": self.value,
            "confidence": self.confidence,
            "attempts": self.attempts,
            "error": self.error,
        }


@dataclass(slots=True)
class Opportunity:
    item_id: str
    query_text: str
    timestamp: str
    observed_value: int | None
    target_price: float | None
    baseline_value: float | None
    delta_value: float
    delta_pct: float
    score: float
    label: RecommendationLabel
    reason: str
    raw_text: str

    def to_dict(self) -> dict:
        return {
            "itemId": self.item_id,
            "queryText": self.query_text,
            "timestamp": self.timestamp,
            "observedValue": self.observed_value,
            "targetPrice": self.target_price,
            "baselineValue": self.baseline_value,
            "deltaValue": self.delta_value,
            "deltaPct": self.delta_pct,
            "score": self.score,
            "label": self.label,
            "reason": self.reason,
            "rawText": self.raw_text,
        }


@dataclass(slots=True)
class SessionStats:
    scan_batches: int
    scan_items_total: int
    scan_items_success: int
    ocr_failures: int
    avg_score: float
    top_score: float
    success_rate: float
    last_scan_started_at: str | None
    last_scan_finished_at: str | None

    def to_dict(self) -> dict:
        return {
            "scanBatches": self.scan_batches,
            "scanItemsTotal": self.scan_items_total,
            "scanItemsSuccess": self.scan_items_success,
            "ocrFailures": self.ocr_failures,
            "avgScore": self.avg_score,
            "topScore": self.top_score,
            "successRate": self.success_rate,
            "lastScanStartedAt": self.last_scan_started_at,
            "lastScanFinishedAt": self.last_scan_finished_at,
        }

