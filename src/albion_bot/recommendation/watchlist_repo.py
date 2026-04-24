from __future__ import annotations

from typing import Iterable

from albion_bot.recommendation.models import WatchItem, utc_now_iso
from albion_bot.recommendation.watchlist_store import WatchlistStore


class WatchlistRepo:
    def __init__(self, store: WatchlistStore) -> None:
        self._store = store
        self._items: list[WatchItem] = store.load()

    def list(self) -> list[WatchItem]:
        return list(self._items)

    def list_enabled(self) -> list[WatchItem]:
        return [item for item in self._items if item.enabled]

    def add(self, query_text: str, target_price: float | None, min_profit_pct: float, tags: Iterable[str]) -> WatchItem:
        cleaned = query_text.strip()
        if not cleaned:
            raise ValueError("queryText cannot be empty.")
        item = WatchItem(
            query_text=cleaned,
            target_price=float(target_price) if target_price is not None else None,
            min_profit_pct=float(min_profit_pct),
            tags=[str(tag).strip() for tag in tags if str(tag).strip()],
        )
        self._items.append(item)
        self._persist()
        return item

    def update(
        self,
        item_id: str,
        query_text: str | None = None,
        target_price: float | None = None,
        min_profit_pct: float | None = None,
        enabled: bool | None = None,
        tags: Iterable[str] | None = None,
    ) -> WatchItem:
        item = self.get(item_id)
        if query_text is not None:
            cleaned = query_text.strip()
            if not cleaned:
                raise ValueError("queryText cannot be empty.")
            item.query_text = cleaned
        if target_price is not None:
            item.target_price = float(target_price)
        if min_profit_pct is not None:
            item.min_profit_pct = float(min_profit_pct)
        if enabled is not None:
            item.enabled = bool(enabled)
        if tags is not None:
            item.tags = [str(tag).strip() for tag in tags if str(tag).strip()]
        item.updated_at = utc_now_iso()
        self._persist()
        return item

    def remove(self, item_id: str) -> bool:
        before = len(self._items)
        self._items = [item for item in self._items if item.id != item_id]
        removed = len(self._items) != before
        if removed:
            self._persist()
        return removed

    def toggle(self, item_id: str) -> WatchItem:
        item = self.get(item_id)
        item.enabled = not item.enabled
        item.updated_at = utc_now_iso()
        self._persist()
        return item

    def get(self, item_id: str) -> WatchItem:
        for item in self._items:
            if item.id == item_id:
                return item
        raise ValueError(f"Watch item not found: {item_id}")

    def _persist(self) -> None:
        self._store.save(self._items)

