from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Deque

from albion_bot.recommendation.models import Opportunity, ScanResult, SessionStats


@dataclass(slots=True)
class _SessionCounters:
    scan_batches: int = 0
    scan_items_total: int = 0
    scan_items_success: int = 0
    ocr_failures: int = 0
    last_scan_started_at: str | None = None
    last_scan_finished_at: str | None = None


class SessionStore:
    def __init__(self, max_history: int = 300) -> None:
        self._counters = _SessionCounters()
        self._opportunities: Deque[Opportunity] = deque(maxlen=max_history)
        self._scan_results: Deque[ScanResult] = deque(maxlen=max_history)

    def mark_scan_started(self, timestamp: str) -> None:
        self._counters.scan_batches += 1
        self._counters.last_scan_started_at = timestamp

    def mark_scan_finished(self, timestamp: str) -> None:
        self._counters.last_scan_finished_at = timestamp

    def record_scan_result(self, result: ScanResult) -> None:
        self._scan_results.appendleft(result)
        self._counters.scan_items_total += 1
        if result.value is not None:
            self._counters.scan_items_success += 1
        else:
            self._counters.ocr_failures += 1

    def record_opportunity(self, opportunity: Opportunity) -> None:
        self._opportunities.appendleft(opportunity)

    def recent_opportunities(self, limit: int = 80) -> list[Opportunity]:
        return list(self._opportunities)[:limit]

    def baseline_for_item(self, item_id: str, lookback: int = 15) -> float | None:
        values: list[int] = []
        for row in self._scan_results:
            if row.item_id != item_id:
                continue
            if row.value is None:
                continue
            values.append(row.value)
            if len(values) >= lookback:
                break
        if not values:
            return None
        return sum(values) / len(values)

    def stats(self) -> SessionStats:
        scores = [row.score for row in self._opportunities]
        avg_score = (sum(scores) / len(scores)) if scores else 0.0
        top_score = max(scores) if scores else 0.0
        success_rate = 0.0
        if self._counters.scan_items_total > 0:
            success_rate = (
                self._counters.scan_items_success / self._counters.scan_items_total
            ) * 100.0
        return SessionStats(
            scan_batches=self._counters.scan_batches,
            scan_items_total=self._counters.scan_items_total,
            scan_items_success=self._counters.scan_items_success,
            ocr_failures=self._counters.ocr_failures,
            avg_score=round(avg_score, 3),
            top_score=round(top_score, 3),
            success_rate=round(success_rate, 3),
            last_scan_started_at=self._counters.last_scan_started_at,
            last_scan_finished_at=self._counters.last_scan_finished_at,
        )

