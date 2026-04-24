from albion_bot.recommendation.models import Opportunity, ScanResult
from albion_bot.recommendation.session_store import SessionStore


def test_session_store_aggregates_metrics() -> None:
    store = SessionStore(max_history=20)
    store.mark_scan_started("2026-01-01T00:00:00Z")

    success = ScanResult(
        item_id="item-1",
        query_text="item a",
        timestamp="2026-01-01T00:00:01Z",
        raw_text="25,000",
        value=25000,
        confidence=0.9,
    )
    failed = ScanResult(
        item_id="item-2",
        query_text="item b",
        timestamp="2026-01-01T00:00:02Z",
        raw_text="",
        value=None,
        confidence=0.0,
        error="ocr",
    )
    store.record_scan_result(success)
    store.record_scan_result(failed)

    store.record_opportunity(
        Opportunity(
            item_id="item-1",
            query_text="item a",
            timestamp="2026-01-01T00:00:01Z",
            observed_value=25000,
            target_price=26000,
            baseline_value=None,
            delta_value=1000,
            delta_pct=3.8,
            score=70.0,
            label="watch",
            reason="ok",
            raw_text="25,000",
        )
    )
    store.mark_scan_finished("2026-01-01T00:00:03Z")

    stats = store.stats()
    assert stats.scan_batches == 1
    assert stats.scan_items_total == 2
    assert stats.scan_items_success == 1
    assert stats.ocr_failures == 1
    assert stats.success_rate == 50.0
    assert stats.top_score == 70.0

