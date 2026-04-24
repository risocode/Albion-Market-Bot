from albion_bot.recommendation.models import ScanResult, WatchItem
from albion_bot.recommendation.scoring import OpportunityScorer


def test_scoring_marks_strong_when_price_under_target() -> None:
    scorer = OpportunityScorer()
    item = WatchItem(query_text="scholar robe 5.1", target_price=30000, min_profit_pct=5.0)
    scan = ScanResult(
        item_id=item.id,
        query_text=item.query_text,
        timestamp="2026-01-01T00:00:00Z",
        raw_text="25,000",
        value=25000,
        confidence=0.9,
    )
    opp = scorer.score(item, scan, baseline_value=None)
    assert opp.label == "strong"
    assert opp.delta_pct > 5.0


def test_scoring_marks_skip_when_price_above_reference() -> None:
    scorer = OpportunityScorer()
    item = WatchItem(query_text="scholar robe 5.1", target_price=24000, min_profit_pct=5.0)
    scan = ScanResult(
        item_id=item.id,
        query_text=item.query_text,
        timestamp="2026-01-01T00:00:00Z",
        raw_text="26,000",
        value=26000,
        confidence=0.8,
    )
    opp = scorer.score(item, scan, baseline_value=None)
    assert opp.label == "skip"
    assert opp.score < 50


def test_scoring_handles_missing_numeric_value() -> None:
    scorer = OpportunityScorer()
    item = WatchItem(query_text="scholar robe 5.1", target_price=26000, min_profit_pct=5.0)
    scan = ScanResult(
        item_id=item.id,
        query_text=item.query_text,
        timestamp="2026-01-01T00:00:00Z",
        raw_text="",
        value=None,
        confidence=0.0,
        error="OCR failed",
    )
    opp = scorer.score(item, scan, baseline_value=None)
    assert opp.label == "skip"
    assert opp.reason.startswith("No numeric value")

