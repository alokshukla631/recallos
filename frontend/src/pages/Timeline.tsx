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

interface HeatmapDay {
  date: string;
  total: number;
  actions: Record<string, number>;
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
  const [heatmapDays, setHeatmapDays] = useState<HeatmapDay[]>([]);
  const [heatmapMax, setHeatmapMax] = useState(1);
  const [hoveredDay, setHoveredDay] = useState<HeatmapDay | null>(null);

  useEffect(() => {
    fetchTimeline();
    fetchHeatmap();
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

  async function fetchHeatmap() {
    try {
      const res = await fetch("/api/memory/audit/heatmap?weeks=12");
      if (!res.ok) return;
      const data = await res.json();
      setHeatmapDays(data.days || []);
      setHeatmapMax(data.max_activity || 1);
    } catch {
      // ignore
    }
  }

  function heatColor(count: number): string {
    if (count === 0) return "var(--color-surface)";
    const ratio = count / heatmapMax;
    if (ratio < 0.25) return "rgba(109, 109, 255, 0.2)";
    if (ratio < 0.5) return "rgba(109, 109, 255, 0.4)";
    if (ratio < 0.75) return "rgba(109, 109, 255, 0.6)";
    return "rgba(109, 109, 255, 0.85)";
  }

  // Build heatmap grid (7 rows = days of week, N columns = weeks)
  function buildHeatGrid() {
    if (heatmapDays.length === 0) return [];

    const weeks: HeatmapDay[][] = [];
    let currentWeek: HeatmapDay[] = [];

    // Pad start to align to Sunday
    const firstDayOfWeek = new Date(heatmapDays[0].date + "T00:00:00").getDay();
    for (let i = 0; i < firstDayOfWeek; i++) {
      currentWeek.push({ date: "", total: -1, actions: {} });
    }

    for (const day of heatmapDays) {
      currentWeek.push(day);
      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
    }
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        currentWeek.push({ date: "", total: -1, actions: {} });
      }
      weeks.push(currentWeek);
    }

    return weeks;
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

  const heatGrid = buildHeatGrid();
  const weekLabels = ["S", "M", "T", "W", "T", "F", "S"];
  const totalActivity = heatmapDays.reduce((s, d) => s + d.total, 0);
  const activeDays = heatmapDays.filter((d) => d.total > 0).length;

  return (
    <div className="page timeline-page">
      <h2>Timeline</h2>
      <p>Chronological history of memory changes.</p>

      {/* Heatmap */}
      {heatmapDays.length > 0 && (
        <div className="heatmap-section">
          <div className="heatmap-header">
            <span className="heatmap-title">Activity (12 weeks)</span>
            <span className="heatmap-summary">{totalActivity} events across {activeDays} active days</span>
          </div>
          <div className="heatmap-grid-wrapper">
            <div className="heatmap-day-labels">
              {weekLabels.map((label, i) => (
                <span key={i} className="heatmap-day-label">{i % 2 === 1 ? label : ""}</span>
              ))}
            </div>
            <div className="heatmap-grid">
              {heatGrid.map((week, wi) => (
                <div key={wi} className="heatmap-week">
                  {week.map((day, di) => (
                    <div
                      key={di}
                      className={`heatmap-cell${day.total < 0 ? " heatmap-empty" : ""}`}
                      style={{ backgroundColor: day.total >= 0 ? heatColor(day.total) : "transparent" }}
                      title={day.date ? `${day.date}: ${day.total} events` : ""}
                      onMouseEnter={() => day.total >= 0 ? setHoveredDay(day) : null}
                      onMouseLeave={() => setHoveredDay(null)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          {hoveredDay && (
            <div className="heatmap-tooltip">
              <strong>{hoveredDay.date}</strong> - {hoveredDay.total} event{hoveredDay.total !== 1 ? "s" : ""}
              {Object.entries(hoveredDay.actions).length > 0 && (
                <span className="heatmap-tooltip-actions">
                  {Object.entries(hoveredDay.actions).map(([action, count]) => (
                    <span key={action} style={{ color: ACTION_COLORS[action] || "#6b7280" }}>
                      {action}: {count}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
          <div className="heatmap-legend">
            <span className="heatmap-legend-label">Less</span>
            <div className="heatmap-legend-cell" style={{ backgroundColor: "var(--color-surface)" }} />
            <div className="heatmap-legend-cell" style={{ backgroundColor: "rgba(109, 109, 255, 0.2)" }} />
            <div className="heatmap-legend-cell" style={{ backgroundColor: "rgba(109, 109, 255, 0.4)" }} />
            <div className="heatmap-legend-cell" style={{ backgroundColor: "rgba(109, 109, 255, 0.6)" }} />
            <div className="heatmap-legend-cell" style={{ backgroundColor: "rgba(109, 109, 255, 0.85)" }} />
            <span className="heatmap-legend-label">More</span>
          </div>
        </div>
      )}

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
