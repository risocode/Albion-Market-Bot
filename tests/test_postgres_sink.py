from albion_bot.persistence.postgres_sink import (
    manual_fetch_unique_name,
    parse_query_tier_enchant,
    watchlist_fetch_unique_name,
)


def test_parse_query_tier_enchant_trailing_tier() -> None:
    base, tier, enchant = parse_query_tier_enchant("Scholar Robe 5.1")
    assert base == "Scholar Robe"
    assert tier == 5
    assert enchant == 1


def test_parse_query_tier_enchant_no_suffix() -> None:
    base, tier, enchant = parse_query_tier_enchant("Tome of Insight")
    assert base == "Tome of Insight"
    assert tier is None
    assert enchant == 0


def test_watchlist_and_manual_unique_names_stable() -> None:
    assert watchlist_fetch_unique_name("abc-123") == "BOT_WL_abc-123"
    a = manual_fetch_unique_name("same query")
    b = manual_fetch_unique_name("same query")
    c = manual_fetch_unique_name("other")
    assert a == b
    assert a != c
