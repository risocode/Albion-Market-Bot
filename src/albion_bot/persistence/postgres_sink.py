from __future__ import annotations

import hashlib
import re
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

_CATALOG_SQL = """
insert into public.item_catalog (item_unique_name, item_name, tier, enchantment)
values (%s, %s, %s, %s)
on conflict (item_unique_name) do update
set item_name = excluded.item_name,
    tier = excluded.tier,
    enchantment = excluded.enchantment
"""

_PRICE_SQL = """
insert into public.item_prices (item_id, city, price, posted_at, source)
values (
  (select id from public.item_catalog where item_unique_name = %s),
  %s::public.price_city,
  %s,
  coalesce(%s, now()),
  %s
)
on conflict (item_id, city) do update
set price = excluded.price,
    posted_at = excluded.posted_at,
    source = excluded.source
"""

_HISTORY_SQL = """
insert into public.item_price_history (item_id, city, price, posted_at, source)
values (
  (select id from public.item_catalog where item_unique_name = %s),
  %s::public.price_city,
  %s,
  coalesce(%s, now()),
  %s
)
"""


def parse_query_tier_enchant(query_text: str) -> tuple[str, int | None, int]:
    """Strip trailing ``tier.enchant`` (e.g. ``scholar robe 5.1``) for display name + tier fields."""
    q = query_text.strip()
    m = re.search(r"\s+(\d+)\.(\d+)\s*$", q)
    if not m:
        return q, None, 0
    base = q[: m.start()].strip()
    return base, int(m.group(1)), int(m.group(2))


def manual_fetch_unique_name(query_text: str) -> str:
    digest = hashlib.sha256(query_text.strip().encode("utf-8")).hexdigest()[:24]
    return f"BOT_ONCE_{digest}"


def watchlist_fetch_unique_name(watch_item_id: str) -> str:
    return f"BOT_WL_{watch_item_id}"


class PostgresPriceSink:
    """Posts catalog + price rows using the project's Supabase/Postgres schema."""

    def __init__(
        self,
        conninfo: str | None,
        *,
        source: str = "albion_market_bot",
        include_history: bool = True,
    ) -> None:
        self._conninfo = (conninfo or "").strip()
        self._source = source or "albion_market_bot"
        self._include_history = include_history
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return bool(self._conninfo)

    def post_fetch(
        self,
        *,
        item_unique_name: str,
        item_name: str,
        tier: int | None,
        enchantment: int,
        city: str,
        price: int,
        posted_at_iso: str | None,
        emit_log: Callable[[str, str], Any] | None = None,
    ) -> None:
        if not self.enabled:
            return
        city_clean = str(city or "").strip()
        if not city_clean:
            return
        unique = str(item_unique_name or "").strip()
        if not unique:
            return
        name = str(item_name or "").strip() or unique
        posted_at = _parse_iso_datetime(posted_at_iso)

        try:
            import psycopg
        except ImportError as exc:  # pragma: no cover
            if emit_log:
                emit_log("error", f"PostgreSQL sync skipped (psycopg not installed): {exc}")
            return

        try:
            with self._lock:
                with psycopg.connect(self._conninfo) as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            _CATALOG_SQL,
                            (unique, name, tier, enchantment),
                        )
                        cur.execute(
                            _PRICE_SQL,
                            (unique, city_clean, price, posted_at, self._source),
                        )
                        if self._include_history:
                            cur.execute(
                                _HISTORY_SQL,
                                (unique, city_clean, price, posted_at, self._source),
                            )
                    conn.commit()
        except Exception as exc:  # pragma: no cover
            if emit_log:
                emit_log("error", f"PostgreSQL price post failed: {exc}")


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)
