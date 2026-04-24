from pathlib import Path

from albion_bot.recommendation.watchlist_repo import WatchlistRepo
from albion_bot.recommendation.watchlist_store import WatchlistStore


def test_watchlist_crud_and_persistence(tmp_path: Path) -> None:
    store_path = tmp_path / "watchlist.json"
    repo = WatchlistRepo(WatchlistStore(store_path))

    added = repo.add(
        query_text="scholar robe 5.1",
        target_price=26000,
        min_profit_pct=4.5,
        tags=["cloth", "robe"],
    )
    assert added.query_text == "scholar robe 5.1"
    assert len(repo.list()) == 1

    updated = repo.update(
        item_id=added.id,
        target_price=25500,
        min_profit_pct=5.0,
        enabled=False,
    )
    assert updated.target_price == 25500
    assert updated.enabled is False
    assert repo.list_enabled() == []

    toggled = repo.toggle(added.id)
    assert toggled.enabled is True
    assert len(repo.list_enabled()) == 1

    assert repo.remove(added.id) is True
    assert repo.list() == []


def test_watchlist_loads_saved_items(tmp_path: Path) -> None:
    store_path = tmp_path / "watchlist.json"
    repo = WatchlistRepo(WatchlistStore(store_path))
    created = repo.add("adept bag 5.1", 15000, 3.0, [])

    reloaded = WatchlistRepo(WatchlistStore(store_path))
    items = reloaded.list()
    assert len(items) == 1
    assert items[0].id == created.id
    assert items[0].query_text == "adept bag 5.1"

