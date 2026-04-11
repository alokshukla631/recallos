import { useState, useEffect } from "react";
import "./Timeline.css";

interface AuditEntry {
  id: string;
  memory_item_id: string;
  action: string;
  details: string | null;
  memory_key: string | null;
  memory_type: string | null;
  memory_value: string | null;
  created_at: string;
}

const ACTION_COLORS: Record<string, string> = {
  created: "#22c55e",
  superseded: "#f59e0b",
  reconfirmed: "#3b82f6",
  marked_stale: "#ef4444",
  imported: "#8b5cf6",
  deleted: "#6b7280",
};

function Timeline() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(50);

  useEffect(() => {
    fetchTimeline();
  }, [limit]);

  async function fetchTimeline() {
    setLoading(true);
    try {
      const res = await fetch(`/api/memory/audit/recent?limit=${limit}`);
      if (!res.ok) return;
      setEntries(await res.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  function formatDate(iso: string): string {
    try {
      const d = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z"));
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  }

  function formatTime(iso: string): string {
    try {
      const d = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z"));
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  // Group entries by date
  const grouped = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    const date = formatDate(entry.created_at);
    const group = grouped.get(date) || [];
    group.push(entry);
    grouped.set(date, group);
  }

  return (
    <div className="page timeline-page">
      <h2>Timeline</h2>
      <p>Chronological history of memory changes.</p>

      <div className="timeline-controls">
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          <option value={25}>Last 25</option>
          <option value={50}>Last 50</option>
          <option value={100}>Last 100</option>
          <option value={200}>Last 200</option>
        </select>
      </div>

      {loading && <p className="muted">Loading...</p>}

      {!loading && entries.length === 0 && (
        <p className="muted">No timeline entries yet.</p>
      )}

      {!loading && entries.length > 0 && (
        <div className="timeline">
          {[...grouped.entries()].map(([date, items]) => (
            <div key={date} className="timeline-group">
              <div className="timeline-date">{date}</div>
              <div className="timeline-entries">
                {items.map((entry) => (
                  <div key={entry.id} className="timeline-entry">
                    <div className="timeline-dot" style={{ backgroundColor: ACTION_COLORS[entry.action] || "#6b7280" }} />
                    <div className="timeline-content">
                      <div className="timeline-header">
                        <span className="timeline-action" style={{ color: ACTION_COLORS[entry.action] || "#6b7280" }}>
                          {entry.action}
                        </span>
                        <span className="timeline-key">{entry.memory_key || entry.memory_item_id?.slice(0, 8)}</span>
                        <span className="timeline-time">{formatTime(entry.created_at)}</span>
                      </div>
                      {entry.details && <div className="timeline-details">{entry.details}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Timeline;
