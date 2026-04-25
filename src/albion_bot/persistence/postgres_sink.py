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

_RECENT_PRICES_SQL = """
select
  p.posted_at,
  p.city::text as city,
  c.item_name,
  c.item_unique_name,
  c.tier,
  c.enchantment,
  p.price,
  p.source
from public.item_prices p
join public.item_catalog c on c.id = p.item_id
order by p.posted_at desc
limit %s
"""

_MARKET_PRICE_ROWS_SQL = """
select
  p.posted_at,
  p.city::text as city,
  c.item_name,
  c.item_unique_name,
  c.tier,
  c.enchantment,
  p.price,
  p.source
from public.item_prices p
join public.item_catalog c on c.id = p.item_id
where (%s = '' or p.source = %s)
  and (%s = '' or c.item_name ilike %s)
  and (%s = '' or p.city::text = %s)
  and (%s is null or c.tier = %s)
  and (%s is null or c.enchantment = %s)
order by p.posted_at desc
limit %s
offset %s
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
    ) -> tuple[bool, str | None]:
        if not self.enabled:
            return False, "Database connection is not configured."
        city_clean = str(city or "").strip()
        if not city_clean:
            return False, "City is required."
        unique = str(item_unique_name or "").strip()
        if not unique:
            return False, "item_unique_name is required."
        name = str(item_name or "").strip() or unique
        posted_at = _parse_iso_datetime(posted_at_iso)

        try:
            import psycopg
        except ImportError as exc:  # pragma: no cover
            if emit_log:
                emit_log("error", f"PostgreSQL sync skipped (psycopg not installed): {exc}")
            return False, f"psycopg not installed: {exc}"

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
            return True, None
        except Exception as exc:  # pragma: no cover
            if emit_log:
                emit_log("error", f"PostgreSQL price post failed: {exc}")
            return False, str(exc)

    def fetch_recent_prices(
        self,
        *,
        limit: int = 500,
        emit_log: Callable[[str, str], Any] | None = None,
    ) -> list[dict]:
        if not self.enabled:
            return []
        cap = max(1, int(limit))
        try:
            import psycopg
        except ImportError as exc:  # pragma: no cover
            if emit_log:
                emit_log("error", f"PostgreSQL read skipped (psycopg not installed): {exc}")
            return []
        try:
            with self._lock:
                with psycopg.connect(self._conninfo) as conn:
                    with conn.cursor() as cur:
                        cur.execute(_RECENT_PRICES_SQL, (cap,))
                        rows = cur.fetchall()
            out: list[dict] = []
            for posted_at, city, item_name, item_unique_name, tier, enchant, price, source in rows:
                try:
                    price_num = int(price) if price is not None else None
                except Exception:
                    price_num = None
                try:
                    tier_num = int(tier) if tier is not None else None
                except Exception:
                    tier_num = None
                try:
                    enchant_num = int(enchant) if enchant is not None else 0
                except Exception:
                    enchant_num = 0
                out.append(
                    {
                        "timestamp": posted_at.isoformat() if posted_at else "",
                        "city": city or "",
                        "category": "all_cities",
                        "item_name": item_name or item_unique_name or "",
                        "item_id": item_unique_name or "",
                        "tier": tier_num,
                        "enchant": enchant_num,
                        "observed_price": price_num,
                        "error": "",
                        "source": source or "supabase",
                    }
                )
            return out
        except Exception as exc:  # pragma: no cover
            if emit_log:
                emit_log("error", f"PostgreSQL recent price load failed: {exc}")
            return []

    def fetch_market_price_rows(
        self,
        *,
        search: str = "",
        city: str = "",
        tier: int | None = None,
        enchant: int | None = None,
        category: str = "",
        item_type: str = "",
        sort: str = "last_updated_desc",
        limit: int = 1000,
        offset: int = 0,
        bot_only: bool = True,
        emit_log: Callable[[str, str], Any] | None = None,
    ) -> list[dict]:
        if not self.enabled:
            return []
        cap = max(1, int(limit))
        skip = max(0, int(offset))
        search_clean = str(search or "").strip()
        city_clean = str(city or "").strip()
        source_filter = self._source if bot_only else ""
        try:
            import psycopg
        except ImportError as exc:  # pragma: no cover
            if emit_log:
                emit_log("error", f"PostgreSQL market read skipped (psycopg not installed): {exc}")
            return []
        try:
            with self._lock:
                with psycopg.connect(self._conninfo) as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            _MARKET_PRICE_ROWS_SQL,
                            (
                                source_filter,
                                source_filter,
                                search_clean,
                                f"%{search_clean}%",
                                city_clean,
                                city_clean,
                                tier,
                                tier,
                                enchant,
                                enchant,
                                cap,
                                skip,
                            ),
                        )
                        rows = cur.fetchall()
            out: list[dict] = []
            for posted_at, city_v, item_name, item_unique_name, tier_v, enchant_v, price_v, source_v in rows:
                category_v = _infer_category_from_unique_name(item_unique_name)
                type_v = _infer_type_from_item_name(item_name)
                if category and category_v != category:
                    continue
                if item_type and type_v != item_type:
                    continue
                row = {
                    "item": item_name or item_unique_name or "",
                    "tier": int(tier_v) if tier_v is not None else None,
                    "enchant": int(enchant_v) if enchant_v is not None else 0,
                    "city": city_v or "",
                    "category": category_v,
                    "type": type_v,
                    "quality": "-",
                    "price": int(price_v) if price_v is not None else 0,
                    "last_updated": posted_at.isoformat() if posted_at else "",
                    "item_id": item_unique_name or "",
                    "source": source_v or "",
                }
                out.append(row)
            if sort == "price_asc":
                out.sort(key=lambda r: (int(r.get("price") or 0), r.get("item") or ""))
            elif sort == "price_desc":
                out.sort(key=lambda r: (int(r.get("price") or 0), r.get("item") or ""), reverse=True)
            elif sort == "item_asc":
                out.sort(key=lambda r: (r.get("item") or "").lower())
            else:
                out.sort(key=lambda r: r.get("last_updated") or "", reverse=True)
            return out
        except Exception as exc:  # pragma: no cover
            if emit_log:
                emit_log("error", f"PostgreSQL market row load failed: {exc}")
            return []


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


def _infer_category_from_unique_name(unique_name: str | None) -> str:
    u = str(unique_name or "").upper()
    if (
        "ARTEFACT" in u
        or "ARTIFACT" in u
        or "_RUNE" in u
        or "_SOUL" in u
        or "_RELIC" in u
    ):
        return "artifact"
    if "_MAIN_" in u or ("_2H_" in u and "_2H_TOOL_" not in u):
        return "weapons"
    if "_ARMOR_" in u:
        return "chest_armor"
    if "_HEAD_" in u:
        return "head_armor"
    if "_SHOES_" in u:
        return "foot_armor"
    if "_OFF_" in u:
        return "off_hands"
    if "CAPE" in u:
        return "capes"
    if re.search(r"^T\d+_BAG", u):
        return "bags"
    if "MOUNT" in u:
        return "mount"
    if "_TOOL_" in u:
        return "gathering_equipment"
    if "FARM" in u or "SEED" in u or "BABY" in u or "MOUNT_GROWN" in u:
        return "farming"
    if "FURNITURE" in u or "HOUSE" in u or "TROPHY" in u:
        return "furniture"
    if "VANITY" in u or "SKIN" in u:
        return "vanity"
    if "MATERIAL" in u or "METALBAR" in u or "PLANK" in u or "CLOTH" in u or "LEATHER" in u:
        return "crafting"
    return "consumable"


def _infer_type_from_item_name(item_name: str | None) -> str:
    text = str(item_name or "").strip()
    if not text:
        return "-"
    parts = text.split()
    if not parts:
        return "-"
    if len(parts) >= 2 and parts[0].endswith("'s"):
        return parts[1]
    return parts[0]
