from albion_bot.service_main import ServiceHost


class _FakeService:
    def get_state(self):
        return {"ok": True}

    def capture_cursor(self):
        return {"x": 1, "y": 2}

    def select_region(self):
        return None

    def set_search_point(self, x, y):
        return {"x": x, "y": y}

    def set_region(self, left, top, width, height):
        return {"left": left, "top": top, "width": width, "height": height}

    def set_query_text(self, query_text):
        return {"queryText": query_text}

    def run_query_once(self):
        return {"value": 123}

    def list_watch_items(self):
        return []

    def add_watch_item(self, query_text, target_price, min_profit_pct, tags):
        return {"queryText": query_text, "targetPrice": target_price, "minProfitPct": min_profit_pct, "tags": tags}

    def update_watch_item(self, item_id, payload):
        return {"itemId": item_id, **payload}

    def remove_watch_item(self, item_id):
        return {"removed": True, "itemId": item_id}

    def toggle_watch_item(self, item_id):
        return {"itemId": item_id, "enabled": False}

    def run_watchlist_scan(self, item_spacing_seconds):
        return {"processed": 1, "itemSpacingSeconds": item_spacing_seconds}

    def start_watchlist_loop(self, interval_seconds, item_spacing_seconds):
        return {"running": True, "intervalSeconds": interval_seconds, "itemSpacingSeconds": item_spacing_seconds}

    def stop_watchlist_loop(self):
        return {"running": False}

    def get_session_stats(self):
        return {"scanBatches": 0}

    def get_recent_opportunities(self, limit):
        return [{"limit": limit}]

    def export_recommendations_csv(self):
        return {"path": "recommendations_log.csv"}

    def start_loop(self, interval_seconds):
        return {"running": True, "intervalSeconds": interval_seconds}

    def stop_loop(self):
        return {"running": False}

    def set_humanization(self, settle_delay_seconds, post_search_delay_seconds, jitter_ratio, key_delay_base_ms):
        return {
            "settleDelaySeconds": settle_delay_seconds,
            "postSearchDelaySeconds": post_search_delay_seconds,
            "jitterRatio": jitter_ratio,
            "keyDelayBaseMs": key_delay_base_ms,
        }


def _host_with_fake_service() -> ServiceHost:
    host = ServiceHost.__new__(ServiceHost)
    host._service = _FakeService()
    return host


def test_service_protocol_supports_phase2_commands() -> None:
    host = _host_with_fake_service()
    request = {
        "type": "request",
        "requestId": "req-1",
        "command": "runWatchlistScan",
        "payload": {"itemSpacingSeconds": 0.35},
    }
    response = host._handle_request(request)
    assert response["error"] is None
    assert response["payload"]["processed"] == 1

    response2 = host._handle_request(
        {
            "type": "request",
            "requestId": "req-2",
            "command": "getRecentOpportunities",
            "payload": {"limit": 5},
        }
    )
    assert response2["payload"] == [{"limit": 5}]

