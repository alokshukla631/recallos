import { useState, useEffect } from "react";
import "./Links.css";

interface MemoryItem {
  id: string;
  key: string;
  type: string;
  value: string;
  scope: string;
  domain: string | null;
  confidence: number;
}

interface MemoryLink {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  strength: number;
  note: string | null;
  created_at: string;
}

const RELATION_COLORS: Record<string, string> = {
  related_to: "#3b82f6",
  depends_on: "#f59e0b",
  conflicts_with: "#ef4444",
  refines: "#8b5cf6",
  derived_from: "#06b6d4",
};

function Links() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [links, setLinks] = useState<MemoryLink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Create link form
  const [targetId, setTargetId] = useState("");
  const [relation, setRelation] = useState("related_to");
  const [creating, setCreating] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchItems();
  }, []);

  async function fetchItems() {
    setLoading(true);
    try {
      const res = await fetch("/api/memory?status=active");
      if (!res.ok) throw new Error("Failed");
      setItems(await res.json());
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  async function selectItem(id: string) {
    setSelectedId(id);
    setLoadingLinks(true);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/memory/${id}/links`);
      if (!res.ok) throw new Error("Failed");
      setLinks(await res.json());
    } catch {
      setLinks([]);
    } finally {
      setLoadingLinks(false);
    }
  }

  async function createLink() {
    if (!selectedId || !targetId) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/memory/${selectedId}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: targetId, relation }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed");
      }
      setStatusMsg("Link created");
      setTargetId("");
      selectItem(selectedId);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Failed");
    } finally {
      setCreating(false);
    }
  }

  async function deleteLink(linkId: string) {
    try {
      await fetch(`/api/memory/links/${linkId}`, { method: "DELETE" });
      if (selectedId) selectItem(selectedId);
    } catch {
      // ignore
    }
  }

  function getItemLabel(id: string): string {
    const item = items.find((i) => i.id === id);
    return item ? `${item.key}: ${item.value.slice(0, 40)}` : id.slice(0, 8);
  }

  const selectedItem = items.find((i) => i.id === selectedId);

  const filteredItems = searchQuery.trim()
    ? items.filter(
        (i) =>
          i.key.toLowerCase().includes(searchQuery.toLowerCase()) ||
          i.value.toLowerCase().includes(searchQuery.toLowerCase()) ||
          i.type.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : items;

  const linkedItemIds = new Set(
    links.flatMap((l) => [l.source_id, l.target_id])
  );

  return (
    <div className="links-page">
      <h2>Memory Links</h2>
      <p>Explore and manage relationships between memory items.</p>

      {/* Stats bar */}
      {!loading && (
        <div className="links-stats-bar">
          <span className="links-stat">{items.length} items</span>
          <span className="links-stat-sep" />
          <span className="links-stat">{links.length} links on selected</span>
        </div>
      )}

      <div className="links-layout">
        {/* Item list */}
        <div className="links-sidebar">
          <h3>Memory Items ({filteredItems.length})</h3>
          <input
            className="links-search"
            type="text"
            placeholder="Filter items..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {loading ? (
            <p className="muted">Loading...</p>
          ) : (
            <div className="item-list">
              {filteredItems.map((item) => (
                <div
                  key={item.id}
                  className={`item-row ${selectedId === item.id ? "selected" : ""} ${linkedItemIds.has(item.id) ? "linked" : ""}`}
                  onClick={() => selectItem(item.id)}
                >
                  <span className="item-key">{item.key}</span>
                  <span className="item-type" style={{ color: getTypeColor(item.type) }}>
                    {item.type}
                  </span>
                </div>
              ))}
              {filteredItems.length === 0 && (
                <p className="muted" style={{ padding: "12px 0" }}>No matching items.</p>
              )}
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div className="links-detail">
          {!selectedItem ? (
            <div className="links-empty">Select a memory item to see its links.</div>
          ) : (
            <>
              <div className="selected-item-card">
                <div className="selected-header">
                  <span className="selected-key">{selectedItem.key}</span>
                  <span className="selected-type">{selectedItem.type}</span>
                  {selectedItem.domain && (
                    <span className="selected-domain">{selectedItem.domain}</span>
                  )}
                </div>
                <div className="selected-value">{selectedItem.value}</div>
              </div>

              <h3>Links ({links.length})</h3>
              {loadingLinks ? (
                <p className="muted">Loading links...</p>
              ) : links.length === 0 ? (
                <p className="muted">No links yet. Create one below.</p>
              ) : (
                <div className="links-list">
                  {links.map((link) => {
                    const otherId = link.source_id === selectedId ? link.target_id : link.source_id;
                    const direction = link.source_id === selectedId ? "outgoing" : "incoming";
                    return (
                      <div key={link.id} className="link-card">
                        <span
                          className="link-relation"
                          style={{ color: RELATION_COLORS[link.relation] || "#6b7280" }}
                        >
                          {link.relation.replace(/_/g, " ")}
                        </span>
                        <span className="link-direction">{direction}</span>
                        <span
                          className="link-target"
                          onClick={() => selectItem(otherId)}
                        >
                          {getItemLabel(otherId)}
                        </span>
                        <span className="link-strength">
                          {(link.strength * 100).toFixed(0)}%
                        </span>
                        <button
                          className="link-delete"
                          onClick={() => deleteLink(link.id)}
                          title="Remove link"
                        >
                          x
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Create link form */}
              <div className="create-link-form">
                <h4>Create Link</h4>
                <div className="form-row">
                  <select
                    value={targetId}
                    onChange={(e) => setTargetId(e.target.value)}
                  >
                    <option value="">Select target item...</option>
                    {items
                      .filter((i) => i.id !== selectedId)
                      .map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.key}: {i.value.slice(0, 50)}
                        </option>
                      ))}
                  </select>
                  <select
                    value={relation}
                    onChange={(e) => setRelation(e.target.value)}
                  >
                    <option value="related_to">Related to</option>
                    <option value="depends_on">Depends on</option>
                    <option value="conflicts_with">Conflicts with</option>
                    <option value="refines">Refines</option>
                    <option value="derived_from">Derived from</option>
                  </select>
                  <button
                    className="btn btn-primary"
                    onClick={createLink}
                    disabled={creating || !targetId}
                  >
                    {creating ? "Creating..." : "Link"}
                  </button>
                </div>
                {statusMsg && <p className="link-status">{statusMsg}</p>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function getTypeColor(type: string): string {
  const colors: Record<string, string> = {
    preference: "#3b82f6",
    constraint: "#ef4444",
    fact: "#22c55e",
    goal: "#a855f7",
    override: "#f97316",
  };
  return colors[type] || "#6b7280";
}

export default Links;
