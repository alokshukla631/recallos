import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useToast } from "../components/Toast";
import ActivityHeatmap from "../components/ActivityHeatmap";
import "./Dashboard.css";

interface HealthInfo {
  status: string;
  version?: string;
  uptime_seconds?: number;
  database?: { size_human: string };
  counts?: { active_memories: number; pinned_memories: number; providers: number };
}

interface Stats {
  totals: { active: number; stale: number; superseded: number };
  by_type: Array<{ type: string; count: number }>;
  by_scope: Array<{ scope: string; count: number }>;
  by_domain: Array<{ domain: string; count: number }>;
  confidence: { high: number; medium: number; low: number };
  recent: {
    created_last_7d: number;
    audit_last_7d: Array<{ action: string; count: number }>;
  };
  timeline: { oldest_active: string | null; newest_active: string | null };
  links: number;
  trips: number;
  conversations: number;
  pending_conflicts: number;
  pinned: number;
}

interface RetentionData {
  overall: { total_created: number; total_active: number; retention_pct: number };
  weekly: Array<{ week: string; created: number; survived: number; retention_pct: number }>;
}

interface AuditEntry {
  action: string;
  memory_key: string | null;
  memory_item_id: string;
  details: string | null;
  created_at: string;
}

const TYPE_COLORS: Record<string, string> = {
  preference: "#3b82f6",
  constraint: "#ef4444",
  fact: "#22c55e",
  goal: "#a855f7",
  override: "#f97316",
};

const DOMAIN_COLORS: Record<string, string> = {
  travel: "#06b6d4",
  coding: "#10b981",
  work: "#f59e0b",
  health: "#ef4444",
  finance: "#8b5cf6",
  learning: "#3b82f6",
  writing: "#ec4899",
  personal: "#6b7280",
  communication: "#14b8a6",
};

interface SparkDay {
  date: string;
  total: number;
}

interface DuplicateGroup {
  key: string;
  items: Array<{ id: string; value: string; scope: string }>;
}

interface Suggestion {
  type: string;
  message: string;
  memory_id?: string;
  key?: string;
}

function Dashboard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [retention, setRetention] = useState<RetentionData | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [sparkData, setSparkData] = useState<SparkDay[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchStats(), fetchAudit(), fetchRetention(), fetchHealth(), fetchSparkline(), fetchInsights()]).finally(() => setLoading(false));
  }, []);

  async function fetchStats() {
    try {
      const res = await fetch("/api/memory/stats");
      if (!res.ok) return;
      setStats(await res.json());
    } catch {
      // ignore
    }
  }

  async function fetchAudit() {
    try {
      const res = await fetch("/api/memory/audit/recent?limit=10");
      if (!res.ok) return;
      setAudit(await res.json());
    } catch {
      // ignore
    }
  }

  async function fetchRetention() {
    try {
      const res = await fetch("/api/memory/stats/retention");
      if (!res.ok) return;
      setRetention(await res.json());
    } catch {
      // ignore
    }
  }

  async function fetchHealth() {
    try {
      const res = await fetch("/health");
      if (!res.ok) return;
      setHealth(await res.json());
    } catch {
      // ignore
    }
  }

  async function fetchSparkline() {
    try {
      const res = await fetch("/api/memory/audit/heatmap?weeks=2");
      if (!res.ok) return;
      const data = await res.json();
      setSparkData(data.days || []);
    } catch {
      // ignore
    }
  }

  async function fetchInsights() {
    try {
      const [dupRes, sugRes] = await Promise.all([
        fetch("/api/memory/duplicates?threshold=0.6"),
        fetch("/api/memory/suggestions"),
      ]);
      if (dupRes.ok) {
        const dupData = await dupRes.json();
        setDuplicates(dupData.groups || []);
      }
      if (sugRes.ok) {
        const sugData = await sugRes.json();
        setSuggestions(Array.isArray(sugData) ? sugData.slice(0, 5) : []);
      }
    } catch {
      // ignore
    }
  }

  async function handleExportJSON() {
    try {
      const res = await fetch("/api/passport/export");
      if (!res.ok) throw new Error("Export failed");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `recallos-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Memory exported", "success");
    } catch {
      toast("Export failed", "error");
    }
  }

  function formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hrs}h ${remainMins}m`;
  }

  if (loading) {
    return (
      <div className="dashboard-page">
        <h2>Dashboard</h2>
        <p className="muted">Loading...</p>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="dashboard-page">
        <h2>Dashboard</h2>
        <p className="muted">Could not load stats. Is the backend running?</p>
      </div>
    );
  }

  const totalMemory = stats.totals.active + stats.totals.stale + stats.totals.superseded;

  return (
    <div className="dashboard-page">
      <h2>Dashboard</h2>
      <p>Overview of your memory, activity, and system health.</p>

      {/* System status bar */}
      {health && (
        <div className="system-status-bar">
          <span className="status-dot" />
          <span className="status-item">v{health.version || "?"}</span>
          {health.uptime_seconds !== undefined && (
            <span className="status-item">Up {formatUptime(health.uptime_seconds)}</span>
          )}
          {health.database?.size_human && (
            <span className="status-item">DB: {health.database.size_human}</span>
          )}
          {health.counts?.pinned_memories !== undefined && health.counts.pinned_memories > 0 && (
            <span className="status-item">{health.counts.pinned_memories} pinned</span>
          )}
          {health.counts?.providers !== undefined && (
            <span className="status-item">{health.counts.providers} provider{health.counts.providers !== 1 ? "s" : ""}</span>
          )}
        </div>
      )}

      {/* Top stats row */}
      <div className="stats-grid">
        <div className="big-stat-card">
          <span className="big-stat-value">{stats.totals.active}</span>
          <span className="big-stat-label">Active memories</span>
        </div>
        <div className="big-stat-card">
          <span className="big-stat-value">{stats.conversations}</span>
          <span className="big-stat-label">Conversations</span>
        </div>
        <div className="big-stat-card">
          <span className="big-stat-value">{stats.trips}</span>
          <span className="big-stat-label">Trips</span>
        </div>
        <div className="big-stat-card">
          <span className="big-stat-value">{stats.links}</span>
          <span className="big-stat-label">Links</span>
        </div>
        <div className="big-stat-card">
          <span className="big-stat-value">{stats.recent.created_last_7d}</span>
          <span className="big-stat-label">Created (7d)</span>
        </div>
        <div className="big-stat-card">
          <span className="big-stat-value">{totalMemory}</span>
          <span className="big-stat-label">Total all-time</span>
        </div>
        {stats.pinned > 0 && (
          <div className="big-stat-card">
            <span className="big-stat-value" style={{ color: "#f59e0b" }}>{stats.pinned}</span>
            <span className="big-stat-label">Pinned</span>
          </div>
        )}
        {stats.pending_conflicts > 0 && (
          <div className="big-stat-card">
            <span className="big-stat-value" style={{ color: "#ef4444" }}>{stats.pending_conflicts}</span>
            <span className="big-stat-label">Conflicts</span>
          </div>
        )}
      </div>

      {/* Activity heatmap */}
      <ActivityHeatmap weeks={12} />

      <div className="dashboard-columns">
        {/* Left column */}
        <div className="dashboard-col">
          {/* By type */}
          <div className="dash-section">
            <h3>By Type</h3>
            <div className="bar-chart">
              {stats.by_type.map((t) => (
                <div key={t.type} className="bar-row">
                  <span className="bar-label">{t.type}</span>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{
                        width: `${Math.max(4, (t.count / stats.totals.active) * 100)}%`,
                        backgroundColor: TYPE_COLORS[t.type] || "#6b7280",
                      }}
                    />
                  </div>
                  <span className="bar-count">{t.count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* By domain */}
          {stats.by_domain.length > 0 && (
            <div className="dash-section">
              <h3>By Domain</h3>
              <div className="bar-chart">
                {stats.by_domain.map((d) => (
                  <div key={d.domain} className="bar-row">
                    <span className="bar-label">{d.domain}</span>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          width: `${Math.max(4, (d.count / stats.totals.active) * 100)}%`,
                          backgroundColor: DOMAIN_COLORS[d.domain] || "#6b7280",
                        }}
                      />
                    </div>
                    <span className="bar-count">{d.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Confidence distribution */}
          <div className="dash-section">
            <h3>Confidence</h3>
            <div className="confidence-bars">
              <div className="conf-bar">
                <span className="conf-label">High (80%+)</span>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{
                      width: `${Math.max(4, (stats.confidence.high / Math.max(1, stats.totals.active)) * 100)}%`,
                      backgroundColor: "#22c55e",
                    }}
                  />
                </div>
                <span className="bar-count">{stats.confidence.high}</span>
              </div>
              <div className="conf-bar">
                <span className="conf-label">Medium (50-80%)</span>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{
                      width: `${Math.max(4, (stats.confidence.medium / Math.max(1, stats.totals.active)) * 100)}%`,
                      backgroundColor: "#f59e0b",
                    }}
                  />
                </div>
                <span className="bar-count">{stats.confidence.medium}</span>
              </div>
              <div className="conf-bar">
                <span className="conf-label">Low (&lt;50%)</span>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{
                      width: `${Math.max(4, (stats.confidence.low / Math.max(1, stats.totals.active)) * 100)}%`,
                      backgroundColor: "#ef4444",
                    }}
                  />
                </div>
                <span className="bar-count">{stats.confidence.low}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="dashboard-col">
          {/* By scope */}
          <div className="dash-section">
            <h3>By Scope</h3>
            <div className="scope-pills">
              {stats.by_scope.map((s) => (
                <span key={s.scope} className="scope-pill">
                  {s.scope}: {s.count}
                </span>
              ))}
            </div>
          </div>

          {/* Retention */}
          {retention && retention.weekly.length > 0 && (
            <div className="dash-section">
              <h3>Memory Retention</h3>
              <div className="retention-summary">
                <span className="retention-pct">{retention.overall.retention_pct}%</span>
                <span className="retention-label">
                  overall ({retention.overall.total_active} of {retention.overall.total_created} survived)
                </span>
              </div>
              <div className="retention-chart">
                {retention.weekly.map((w) => (
                  <div key={w.week} className="retention-bar-col" title={`Week ${w.week}: ${w.survived}/${w.created} (${w.retention_pct}%)`}>
                    <div className="retention-bar-bg">
                      <div
                        className="retention-bar-fill"
                        style={{ height: `${w.retention_pct}%` }}
                      />
                    </div>
                    <span className="retention-bar-label">{w.retention_pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent activity */}
          <div className="dash-section">
            <h3>Recent Activity</h3>
            {audit.length === 0 ? (
              <p className="muted">No recent activity.</p>
            ) : (
              <div className="activity-feed">
                {audit.map((entry, i) => (
                  <div key={i} className="activity-item">
                    <span className={`activity-action action-${entry.action}`}>
                      {entry.action}
                    </span>
                    <span className="activity-key">
                      {entry.memory_key || entry.memory_item_id?.slice(0, 8)}
                    </span>
                    <span className="activity-time">
                      {formatRelative(entry.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <Link to="/memory" className="dash-link">
              View all memory
            </Link>
          </div>

          {/* Activity sparkline */}
          {sparkData.length > 0 && (
            <div className="dash-section">
              <h3>Activity (14 days)</h3>
              <div className="sparkline-container">
                <svg viewBox={`0 0 ${sparkData.length * 8} 40`} className="sparkline-svg">
                  {(() => {
                    const max = Math.max(1, ...sparkData.map((d) => d.total));
                    const points = sparkData.map((d, i) => {
                      const x = i * 8 + 4;
                      const y = 38 - (d.total / max) * 34;
                      return `${x},${y}`;
                    }).join(" ");
                    const areaPoints = `0,38 ${points} ${(sparkData.length - 1) * 8 + 4},38`;
                    return (
                      <>
                        <polygon points={areaPoints} fill="rgba(109, 109, 255, 0.1)" />
                        <polyline points={points} fill="none" stroke="rgba(109, 109, 255, 0.7)" strokeWidth="1.5" />
                        {sparkData.map((d, i) => (
                          d.total > 0 && (
                            <circle
                              key={i}
                              cx={i * 8 + 4}
                              cy={38 - (d.total / max) * 34}
                              r="2"
                              fill="rgba(109, 109, 255, 0.9)"
                            />
                          )
                        ))}
                      </>
                    );
                  })()}
                </svg>
                <div className="sparkline-labels">
                  <span>{sparkData[0]?.date.slice(5)}</span>
                  <span>{sparkData[sparkData.length - 1]?.date.slice(5)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Quick actions */}
          <div className="dash-section">
            <h3>Quick Actions</h3>
            <div className="quick-actions">
              <button className="quick-action-btn" onClick={() => navigate("/chat")}>Start chat</button>
              <button className="quick-action-btn" onClick={() => navigate("/memory")}>Browse memory</button>
              <button className="quick-action-btn" onClick={() => navigate("/graph")}>View graph</button>
              <button className="quick-action-btn" onClick={() => navigate("/health")}>Health check</button>
              <button className="quick-action-btn" onClick={handleExportJSON}>Export JSON</button>
              <button className="quick-action-btn" onClick={() => window.open("/api/docs", "_blank")}>API docs</button>
            </div>
          </div>
        </div>
      </div>

      {/* Insights section */}
      {(duplicates.length > 0 || suggestions.length > 0) && (
        <div className="insights-section">
          <h3>Insights</h3>
          <div className="insights-grid">
            {duplicates.length > 0 && (
              <div className="insight-card insight-duplicates">
                <h4>Possible Duplicates ({duplicates.length})</h4>
                <div className="insight-list">
                  {duplicates.slice(0, 5).map((group, i) => (
                    <div key={i} className="insight-item">
                      <span className="insight-key">{group.key}</span>
                      <span className="insight-detail">{group.items.length} items with same key</span>
                    </div>
                  ))}
                </div>
                <Link to="/memory" className="dash-link">Review in Memory</Link>
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="insight-card insight-suggestions">
                <h4>Suggestions</h4>
                <div className="insight-list">
                  {suggestions.map((s, i) => (
                    <div key={i} className="insight-item">
                      <span className={`insight-type insight-type-${s.type}`}>{s.type}</span>
                      <span className="insight-message">{s.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const date = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z"));
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return "";
  }
}

export default Dashboard;
