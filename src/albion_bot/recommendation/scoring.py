from __future__ import annotations

from albion_bot.recommendation.models import Opportunity, ScanResult, WatchItem


class OpportunityScorer:
    def score(
        self,
        watch_item: WatchItem,
        scan_result: ScanResult,
        baseline_value: float | None,
    ) -> Opportunity:
        observed_value = scan_result.value
        if observed_value is None:
            return Opportunity(
                item_id=watch_item.id,
                query_text=watch_item.query_text,
                timestamp=scan_result.timestamp,
                observed_value=None,
                target_price=watch_item.target_price,
                baseline_value=baseline_value,
                delta_value=0.0,
                delta_pct=0.0,
                score=0.0,
                label="skip",
                reason="No numeric value extracted.",
                raw_text=scan_result.raw_text,
            )

        target_reference = watch_item.target_price if watch_item.target_price else baseline_value
        if target_reference is None or target_reference <= 0:
            return Opportunity(
                item_id=watch_item.id,
                query_text=watch_item.query_text,
                timestamp=scan_result.timestamp,
                observed_value=observed_value,
                target_price=watch_item.target_price,
                baseline_value=baseline_value,
                delta_value=0.0,
                delta_pct=0.0,
                score=50.0,
                label="watch",
                reason="No target/baseline reference configured.",
                raw_text=scan_result.raw_text,
            )

        delta_value = target_reference - observed_value
        delta_pct = (delta_value / target_reference) * 100.0
        score = max(0.0, min(100.0, 50.0 + (delta_pct * 2.2)))

        if delta_pct >= watch_item.min_profit_pct:
            label = "strong"
            reason = "Meets minimum profit threshold."
        elif delta_pct >= 0:
            label = "watch"
            reason = "Below minimum profit threshold but non-negative spread."
        else:
            label = "skip"
            reason = "Observed value is above reference target."

        return Opportunity(
            item_id=watch_item.id,
            query_text=watch_item.query_text,
            timestamp=scan_result.timestamp,
            observed_value=observed_value,
            target_price=watch_item.target_price,
            baseline_value=baseline_value,
            delta_value=round(delta_value, 3),
            delta_pct=round(delta_pct, 3),
            score=round(score, 3),
            label=label,
            reason=reason,
            raw_text=scan_result.raw_text,
        )

