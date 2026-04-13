"""
RecallOS Python SDK

Wraps the RecallOS REST API for easy use from Python scripts,
notebooks, and AI agent frameworks.
"""

from __future__ import annotations

from typing import Any, Optional
import httpx


class RecallOS:
    """Synchronous client for the RecallOS API."""

    def __init__(self, base_url: str = "http://localhost:3001"):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self.base_url, timeout=30.0)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "RecallOS":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    # -- Health ---------------------------------------------------------------

    def health(self) -> dict:
        """Check if the backend is running."""
        r = self._client.get("/health")
        r.raise_for_status()
        return r.json()

    # -- Memory ---------------------------------------------------------------

    def list_memory(
        self,
        status: str = "active",
        type: Optional[str] = None,
        scope: Optional[str] = None,
        trip_id: Optional[str] = None,
    ) -> list[dict]:
        """List memory items with optional filters."""
        params: dict[str, str] = {"status": status}
        if type:
            params["type"] = type
        if scope:
            params["scope"] = scope
        if trip_id:
            params["trip_id"] = trip_id
        r = self._client.get("/api/memory", params=params)
        r.raise_for_status()
        return r.json()

    def get_memory(self, memory_id: str) -> dict:
        """Get a single memory item by ID."""
        r = self._client.get(f"/api/memory/{memory_id}")
        r.raise_for_status()
        return r.json()

    def create_memory(
        self,
        key: str,
        value: str,
        type: str = "fact",
        scope: str = "global",
        domain: Optional[str] = None,
        confidence: Optional[float] = None,
    ) -> dict:
        """Create a memory item directly."""
        body: dict[str, Any] = {"key": key, "value": value, "type": type, "scope": scope}
        if domain:
            body["domain"] = domain
        if confidence is not None:
            body["confidence"] = confidence
        r = self._client.post("/api/memory", json=body)
        r.raise_for_status()
        return r.json()

    def search_memory(self, query: str) -> list[dict]:
        """Search memory using BM25 full-text ranking."""
        r = self._client.get("/api/memory/search", params={"q": query})
        r.raise_for_status()
        return r.json()

    def delete_memory(self, memory_id: str) -> dict:
        """Soft-delete a memory item (marks as stale)."""
        r = self._client.delete(f"/api/memory/{memory_id}")
        r.raise_for_status()
        return r.json()

    def update_memory(self, memory_id: str, **fields: Any) -> dict:
        """Update a memory item. Pass value, status, or scope as kwargs."""
        r = self._client.put(f"/api/memory/{memory_id}", json=fields)
        r.raise_for_status()
        return r.json()

    # -- Session cleanup ------------------------------------------------------

    def session_stats(self) -> dict:
        """Get session memory stats."""
        r = self._client.get("/api/memory/session/stats")
        r.raise_for_status()
        return r.json()

    def session_cleanup(self, ttl_hours: int = 24) -> dict:
        """Expire old session memory items."""
        r = self._client.post("/api/memory/session/cleanup", json={"ttl_hours": ttl_hours})
        r.raise_for_status()
        return r.json()

    # -- Bulk import ----------------------------------------------------------

    def bulk_import(self, statements: list[str], trip_id: Optional[str] = None) -> dict:
        """Import memory from a list of natural-language statements."""
        body: dict[str, Any] = {"statements": statements}
        if trip_id:
            body["trip_id"] = trip_id
        r = self._client.post("/api/memory/bulk", json=body)
        r.raise_for_status()
        return r.json()

    # -- Context --------------------------------------------------------------

    def get_context(self, message: str, trip_id: Optional[str] = None) -> dict:
        """Compile context for a message (without calling a provider)."""
        body: dict[str, Any] = {"message": message}
        if trip_id:
            body["trip_id"] = trip_id
        r = self._client.post("/api/context/benchmark", json=body)
        r.raise_for_status()
        return r.json()

    # -- Chat -----------------------------------------------------------------

    def chat(
        self,
        message: str,
        provider: str,
        conversation_id: Optional[str] = None,
        trip_id: Optional[str] = None,
    ) -> dict:
        """Send a chat message through the full pipeline."""
        body: dict[str, Any] = {"message": message, "provider": provider}
        if conversation_id:
            body["conversation_id"] = conversation_id
        if trip_id:
            body["trip_id"] = trip_id
        r = self._client.post("/api/chat", json=body)
        r.raise_for_status()
        return r.json()

    # -- Trips ----------------------------------------------------------------

    def list_trips(self) -> list[dict]:
        """List all trips."""
        r = self._client.get("/api/trips")
        r.raise_for_status()
        return r.json()

    def create_trip(
        self,
        name: str,
        destination: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> dict:
        """Create a new trip."""
        body: dict[str, Any] = {"name": name}
        if destination:
            body["destination"] = destination
        if start_date:
            body["start_date"] = start_date
        if end_date:
            body["end_date"] = end_date
        r = self._client.post("/api/trips", json=body)
        r.raise_for_status()
        return r.json()

    def delete_trip(self, trip_id: str) -> dict:
        """Delete a trip."""
        r = self._client.delete(f"/api/trips/{trip_id}")
        r.raise_for_status()
        return r.json()

    # -- Passport -------------------------------------------------------------

    def export_passport(self) -> dict:
        """Export all memory and trips as a portable JSON passport."""
        r = self._client.get("/api/passport/export")
        r.raise_for_status()
        return r.json()

    def import_passport(self, passport: dict) -> dict:
        """Import memory and trips from a passport JSON."""
        r = self._client.post("/api/passport/import", json=passport)
        r.raise_for_status()
        return r.json()

    # -- Scraper --------------------------------------------------------------

    def scraper_sources(self) -> list[dict]:
        """List available log sources and their status."""
        r = self._client.get("/api/scraper/sources")
        r.raise_for_status()
        return r.json()

    def scraper_run(self) -> dict:
        """Scrape all available log sources for new conversations."""
        r = self._client.post("/api/scraper/run", json={})
        r.raise_for_status()
        return r.json()

    # -- Audit ----------------------------------------------------------------

    def audit_log(self, limit: int = 20) -> list[dict]:
        """Get recent audit log entries."""
        r = self._client.get("/api/memory/audit/recent", params={"limit": str(limit)})
        r.raise_for_status()
        return r.json()

    # -- Tags -----------------------------------------------------------------

    def list_tags(self) -> list[dict]:
        """List all tags in use."""
        r = self._client.get("/api/memory/tags")
        r.raise_for_status()
        return r.json()

    def add_tag(self, memory_id: str, tag: str) -> list[dict]:
        """Add a tag to a memory item."""
        r = self._client.post(f"/api/memory/{memory_id}/tags", json={"tag": tag})
        r.raise_for_status()
        return r.json()

    # -- Links ----------------------------------------------------------------

    def get_links(self, memory_id: str) -> list[dict]:
        """Get all links for a memory item."""
        r = self._client.get(f"/api/memory/{memory_id}/links")
        r.raise_for_status()
        return r.json()

    def create_link(
        self,
        source_id: str,
        target_id: str,
        relation: str,
        strength: float = 1.0,
        note: Optional[str] = None,
    ) -> dict:
        """Create a link between two memory items."""
        body: dict[str, Any] = {
            "target_id": target_id,
            "relation": relation,
            "strength": strength,
        }
        if note:
            body["note"] = note
        r = self._client.post(f"/api/memory/{source_id}/links", json=body)
        r.raise_for_status()
        return r.json()

    # -- Stats ----------------------------------------------------------------

    def memory_stats(self) -> dict:
        """Get full memory statistics."""
        r = self._client.get("/api/memory/stats")
        r.raise_for_status()
        return r.json()

    def retention_stats(self) -> dict:
        """Get memory retention analytics (weekly survival rates)."""
        r = self._client.get("/api/memory/stats/retention")
        r.raise_for_status()
        return r.json()

    # -- Webhooks -------------------------------------------------------------

    def list_webhooks(self) -> list[dict]:
        """List all configured webhooks."""
        r = self._client.get("/api/settings/webhooks")
        r.raise_for_status()
        return r.json()

    def add_webhook(self, url: str, events: Optional[list[str]] = None) -> dict:
        """Register a new webhook."""
        body: dict[str, Any] = {"url": url, "events": events or ["*"]}
        r = self._client.post("/api/settings/webhooks", json=body)
        r.raise_for_status()
        return r.json()

    def delete_webhook(self, webhook_id: str) -> dict:
        """Delete a webhook."""
        r = self._client.delete(f"/api/settings/webhooks/{webhook_id}")
        r.raise_for_status()
        return r.json()

    # -- Passport (Markdown) --------------------------------------------------

    def export_passport_markdown(self) -> str:
        """Export memory as human-readable Markdown."""
        r = self._client.get("/api/passport/export/markdown")
        r.raise_for_status()
        return r.text

    # -- Importance -----------------------------------------------------------

    def importance_ranking(self, limit: int = 20) -> list[dict]:
        """Get memory items ranked by importance score."""
        r = self._client.get("/api/memory/importance", params={"limit": str(limit)})
        r.raise_for_status()
        return r.json()

    def importance_breakdown(self, memory_id: str) -> dict:
        """Get the importance score breakdown for a single item."""
        r = self._client.get(f"/api/memory/{memory_id}/importance")
        r.raise_for_status()
        return r.json()

    # -- Decay ----------------------------------------------------------------

    def decay_preview(
        self,
        max_age_days: Optional[int] = None,
        max_stale_days: Optional[int] = None,
        min_importance: Optional[int] = None,
    ) -> dict:
        """Preview which items would be marked stale by decay rules."""
        params: dict[str, str] = {}
        if max_age_days is not None:
            params["max_age_days"] = str(max_age_days)
        if max_stale_days is not None:
            params["max_stale_days"] = str(max_stale_days)
        if min_importance is not None:
            params["min_importance"] = str(min_importance)
        r = self._client.get("/api/memory/decay", params=params)
        r.raise_for_status()
        return r.json()

    def decay_apply(
        self,
        max_age_days: Optional[int] = None,
        max_stale_days: Optional[int] = None,
        min_importance: Optional[int] = None,
    ) -> dict:
        """Apply decay rules and mark stale items."""
        body: dict[str, Any] = {}
        if max_age_days is not None:
            body["max_age_days"] = max_age_days
        if max_stale_days is not None:
            body["max_stale_days"] = max_stale_days
        if min_importance is not None:
            body["min_importance"] = min_importance
        r = self._client.post("/api/memory/decay", json=body)
        r.raise_for_status()
        return r.json()

    # -- Reconfirmation -------------------------------------------------------

    def reconfirm(self, memory_id: str) -> dict:
        """Manually reconfirm a memory item as still valid."""
        r = self._client.post(f"/api/memory/{memory_id}/reconfirm")
        r.raise_for_status()
        return r.json()

    # -- Merge ----------------------------------------------------------------

    def merge(self, source_id: str, target_id: str, merged_value: Optional[str] = None) -> dict:
        """Merge two memory items. Source gets superseded, target keeps the result."""
        body: dict[str, Any] = {"source_id": source_id, "target_id": target_id}
        if merged_value:
            body["merged_value"] = merged_value
        r = self._client.post("/api/memory/merge", json=body)
        r.raise_for_status()
        return r.json()

    def get_detail(self, memory_id: str) -> dict:
        """Get comprehensive detail for a memory item (importance, tags, links, audit)."""
        r = self._client.get(f"/api/memory/{memory_id}/detail")
        r.raise_for_status()
        return r.json()

    def restore_memory(self, memory_id: str) -> dict:
        """Restore a deleted or superseded item back to active status."""
        r = self._client.post(f"/api/memory/{memory_id}/restore")
        r.raise_for_status()
        return r.json()

    def recently_deleted(self, limit: int = 20) -> list:
        """List recently deleted memory items."""
        r = self._client.get("/api/memory/recently-deleted", params={"limit": limit})
        r.raise_for_status()
        return r.json()

    def trends(self, days: int = 30) -> list:
        """Get daily activity trends over time."""
        r = self._client.get("/api/memory/stats/trends", params={"days": days})
        r.raise_for_status()
        return r.json()

    def graph(self) -> dict:
        """Get graph data (nodes + edges) for memory visualization."""
        r = self._client.get("/api/memory/graph")
        r.raise_for_status()
        return r.json()

    # -- Conflicts ------------------------------------------------------------

    def get_conflicts(self, status: str = "pending") -> dict:
        """Get memory conflicts."""
        r = self._client.get("/api/memory/conflicts", params={"status": status})
        r.raise_for_status()
        return r.json()

    def resolve_conflict(
        self, conflict_id: str, resolution: str, merged_value: Optional[str] = None
    ) -> dict:
        """Resolve a memory conflict (keep_new, keep_old, or merged)."""
        body: dict[str, str] = {"resolution": resolution}
        if merged_value:
            body["merged_value"] = merged_value
        r = self._client.post(
            f"/api/memory/conflicts/{conflict_id}/resolve", json=body
        )
        r.raise_for_status()
        return r.json()

    # -- Import ---------------------------------------------------------------

    def import_memories(self, items: list[dict]) -> dict:
        """Bulk import structured memory items."""
        r = self._client.post("/api/memory/import", json={"items": items})
        r.raise_for_status()
        return r.json()

    # -- Snapshot comparison --------------------------------------------------

    def compare_snapshots(self, snapshot_a: str, snapshot_b: str) -> dict:
        """Compare two context compilation snapshots."""
        r = self._client.get(
            "/api/context/snapshots/compare",
            params={"a": snapshot_a, "b": snapshot_b},
        )
        r.raise_for_status()
        return r.json()

    def list_snapshots(self, event_id: Optional[str] = None) -> list[dict]:
        """List context compilation snapshots."""
        params: dict[str, str] = {}
        if event_id:
            params["event_id"] = event_id
        r = self._client.get("/api/context/snapshots", params=params)
        r.raise_for_status()
        return r.json()

    # -- MCP config -----------------------------------------------------------

    def mcp_config(self) -> dict:
        """Get the MCP server config for Claude Desktop."""
        r = self._client.get("/api/settings/mcp/config")
        r.raise_for_status()
        return r.json()

    def mcp_install(self) -> dict:
        """Auto-install MCP config into Claude Desktop."""
        r = self._client.post("/api/settings/mcp/install", json={})
        r.raise_for_status()
        return r.json()


class AsyncRecallOS:
    """Async client for the RecallOS API (uses httpx.AsyncClient)."""

    def __init__(self, base_url: str = "http://localhost:3001"):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=30.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncRecallOS":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def health(self) -> dict:
        r = await self._client.get("/health")
        r.raise_for_status()
        return r.json()

    async def list_memory(
        self,
        status: str = "active",
        type: Optional[str] = None,
        scope: Optional[str] = None,
    ) -> list[dict]:
        params: dict[str, str] = {"status": status}
        if type:
            params["type"] = type
        if scope:
            params["scope"] = scope
        r = await self._client.get("/api/memory", params=params)
        r.raise_for_status()
        return r.json()

    async def create_memory(
        self,
        key: str,
        value: str,
        type: str = "fact",
        scope: str = "global",
        domain: Optional[str] = None,
        confidence: Optional[float] = None,
    ) -> dict:
        """Create a memory item directly."""
        body: dict[str, Any] = {"key": key, "value": value, "type": type, "scope": scope}
        if domain:
            body["domain"] = domain
        if confidence is not None:
            body["confidence"] = confidence
        r = await self._client.post("/api/memory", json=body)
        r.raise_for_status()
        return r.json()

    async def search_memory(self, query: str) -> list[dict]:
        r = await self._client.get("/api/memory/search", params={"q": query})
        r.raise_for_status()
        return r.json()

    async def get_context(self, message: str, trip_id: Optional[str] = None) -> dict:
        body: dict[str, Any] = {"message": message}
        if trip_id:
            body["trip_id"] = trip_id
        r = await self._client.post("/api/context/benchmark", json=body)
        r.raise_for_status()
        return r.json()

    async def chat(
        self,
        message: str,
        provider: str,
        conversation_id: Optional[str] = None,
        trip_id: Optional[str] = None,
    ) -> dict:
        body: dict[str, Any] = {"message": message, "provider": provider}
        if conversation_id:
            body["conversation_id"] = conversation_id
        if trip_id:
            body["trip_id"] = trip_id
        r = await self._client.post("/api/chat", json=body)
        r.raise_for_status()
        return r.json()

    async def list_trips(self) -> list[dict]:
        r = await self._client.get("/api/trips")
        r.raise_for_status()
        return r.json()

    async def export_passport(self) -> dict:
        r = await self._client.get("/api/passport/export")
        r.raise_for_status()
        return r.json()

    async def scraper_run(self) -> dict:
        r = await self._client.post("/api/scraper/run", json={})
        r.raise_for_status()
        return r.json()

    async def session_cleanup(self, ttl_hours: int = 24) -> dict:
        r = await self._client.post("/api/memory/session/cleanup", json={"ttl_hours": ttl_hours})
        r.raise_for_status()
        return r.json()

    async def audit_log(self, limit: int = 20) -> list[dict]:
        r = await self._client.get("/api/memory/audit/recent", params={"limit": str(limit)})
        r.raise_for_status()
        return r.json()

    async def memory_stats(self) -> dict:
        r = await self._client.get("/api/memory/stats")
        r.raise_for_status()
        return r.json()

    async def retention_stats(self) -> dict:
        r = await self._client.get("/api/memory/stats/retention")
        r.raise_for_status()
        return r.json()

    async def list_webhooks(self) -> list[dict]:
        r = await self._client.get("/api/settings/webhooks")
        r.raise_for_status()
        return r.json()

    async def add_webhook(self, url: str, events: Optional[list[str]] = None) -> dict:
        body: dict[str, Any] = {"url": url, "events": events or ["*"]}
        r = await self._client.post("/api/settings/webhooks", json=body)
        r.raise_for_status()
        return r.json()

    async def delete_webhook(self, webhook_id: str) -> dict:
        r = await self._client.delete(f"/api/settings/webhooks/{webhook_id}")
        r.raise_for_status()
        return r.json()

    async def export_passport_markdown(self) -> str:
        r = await self._client.get("/api/passport/export/markdown")
        r.raise_for_status()
        return r.text

    async def bulk_import(self, statements: list[str], trip_id: Optional[str] = None) -> dict:
        body: dict[str, Any] = {"statements": statements}
        if trip_id:
            body["trip_id"] = trip_id
        r = await self._client.post("/api/memory/bulk", json=body)
        r.raise_for_status()
        return r.json()

    async def importance_ranking(self, limit: int = 20) -> list[dict]:
        r = await self._client.get("/api/memory/importance", params={"limit": str(limit)})
        r.raise_for_status()
        return r.json()

    async def importance_breakdown(self, memory_id: str) -> dict:
        r = await self._client.get(f"/api/memory/{memory_id}/importance")
        r.raise_for_status()
        return r.json()

    async def decay_preview(
        self,
        max_age_days: Optional[int] = None,
        max_stale_days: Optional[int] = None,
        min_importance: Optional[int] = None,
    ) -> dict:
        params: dict[str, str] = {}
        if max_age_days is not None:
            params["max_age_days"] = str(max_age_days)
        if max_stale_days is not None:
            params["max_stale_days"] = str(max_stale_days)
        if min_importance is not None:
            params["min_importance"] = str(min_importance)
        r = await self._client.get("/api/memory/decay", params=params)
        r.raise_for_status()
        return r.json()

    async def decay_apply(
        self,
        max_age_days: Optional[int] = None,
        max_stale_days: Optional[int] = None,
        min_importance: Optional[int] = None,
    ) -> dict:
        body: dict[str, Any] = {}
        if max_age_days is not None:
            body["max_age_days"] = max_age_days
        if max_stale_days is not None:
            body["max_stale_days"] = max_stale_days
        if min_importance is not None:
            body["min_importance"] = min_importance
        r = await self._client.post("/api/memory/decay", json=body)
        r.raise_for_status()
        return r.json()

    async def reconfirm(self, memory_id: str) -> dict:
        r = await self._client.post(f"/api/memory/{memory_id}/reconfirm")
        r.raise_for_status()
        return r.json()

    async def merge(self, source_id: str, target_id: str, merged_value: Optional[str] = None) -> dict:
        body: dict[str, Any] = {"source_id": source_id, "target_id": target_id}
        if merged_value:
            body["merged_value"] = merged_value
        r = await self._client.post("/api/memory/merge", json=body)
        r.raise_for_status()
        return r.json()

    async def get_detail(self, memory_id: str) -> dict:
        """Get comprehensive detail for a memory item."""
        r = await self._client.get(f"/api/memory/{memory_id}/detail")
        r.raise_for_status()
        return r.json()

    async def restore_memory(self, memory_id: str) -> dict:
        """Restore a deleted or superseded item back to active status."""
        r = await self._client.post(f"/api/memory/{memory_id}/restore")
        r.raise_for_status()
        return r.json()

    async def recently_deleted(self, limit: int = 20) -> list:
        """List recently deleted memory items."""
        r = await self._client.get("/api/memory/recently-deleted", params={"limit": limit})
        r.raise_for_status()
        return r.json()

    async def trends(self, days: int = 30) -> list:
        """Get daily activity trends over time."""
        r = await self._client.get("/api/memory/stats/trends", params={"days": days})
        r.raise_for_status()
        return r.json()

    async def graph(self) -> dict:
        """Get graph data (nodes + edges) for memory visualization."""
        r = await self._client.get("/api/memory/graph")
        r.raise_for_status()
        return r.json()

    async def get_conflicts(self, status: str = "pending") -> dict:
        """Get memory conflicts."""
        r = await self._client.get("/api/memory/conflicts", params={"status": status})
        r.raise_for_status()
        return r.json()

    async def resolve_conflict(
        self, conflict_id: str, resolution: str, merged_value: Optional[str] = None
    ) -> dict:
        """Resolve a memory conflict."""
        body: dict[str, str] = {"resolution": resolution}
        if merged_value:
            body["merged_value"] = merged_value
        r = await self._client.post(
            f"/api/memory/conflicts/{conflict_id}/resolve", json=body
        )
        r.raise_for_status()
        return r.json()

    async def import_memories(self, items: list[dict]) -> dict:
        """Bulk import structured memory items."""
        r = await self._client.post("/api/memory/import", json={"items": items})
        r.raise_for_status()
        return r.json()

    async def compare_snapshots(self, snapshot_a: str, snapshot_b: str) -> dict:
        r = await self._client.get(
            "/api/context/snapshots/compare",
            params={"a": snapshot_a, "b": snapshot_b},
        )
        r.raise_for_status()
        return r.json()

    async def list_snapshots(self, event_id: Optional[str] = None) -> list[dict]:
        params: dict[str, str] = {}
        if event_id:
            params["event_id"] = event_id
        r = await self._client.get("/api/context/snapshots", params=params)
        r.raise_for_status()
        return r.json()
