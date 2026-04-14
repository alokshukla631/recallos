import { useState, useEffect } from "react";
import "./Analytics.css";

interface AnalyticsData {
  weekly_growth: Array<{ week: string; created: number }>;
  most_confirmed: Array<{ key: string; confirmations: number }>;
  by_status: Array<{ status: string; count: number }>;
  avg_confidence_by_type: Array<{ type: string; avg_confidence: number; count: number }>;
  pinned_by_domain: Array<{ domain: string; count: number }>;
  age_stats: { oldest: string | null; newest: string | null; total: number };
  most_linked: Array<{ key: string; type: string; link_count: number }>;
  total_snapshots: number;
}

const STATUS_COLORS: Record<string, string> = {
  active: "#22c55e",
  stale: "#f59e0b",
  superseded: "#6b7280",
};

const TYPE_COLORS: Record<string, string> = {
  preference: "#3b82f6",
  constraint: "#ef4444",
  fact: "#22c55e",
  goal: "#a855f7",
  override: "#f97316",
};

function Analytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/memory/stats/analytics")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="analytics-page">
        <h2>Analytics</h2>
        <p className="muted">Loading...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="analytics-page">
        <h2>Analytics</h2>
        <p className="muted">Could not load analytics. Is the backend running?</p>
      </div>
    );
  }

  const totalByStatus = data.by_status.reduce((sum, s) => sum + s.count, 0);
  const maxWeekly = Math.max(1, ...data.weekly_growth.map((w) => w.created));

  return (
    <div className="analytics-page">
      <h2>Analytics</h2>
      <p>Memory usage patterns, growth trends, and quality metrics.</p>

      {/* Summary cards */}
      <div className="analytics-summary">
        <div className="analytics-card">
          <span className="analytics-card-value">{data.age_stats.total}</span>
          <span className="analytics-card-label">Active memories</span>
        </div>
        <div className="analytics-card">
          <span className="analytics-card-value">{totalByStatus}</span>
          <span className="analytics-card-label">Total all statuses</span>
        </div>
        <div className="analytics-card">
          <span className="analytics-card-value">{data.total_snapshots}</span>
          <span className="analytics-card-label">Context snapshots</span>
        </div>
        {data.age_stats.oldest && (
          <div className="analytics-card">
            <span className="analytics-card-value">
              {daysBetween(data.age_stats.oldest)}d
            </span>
            <span className="analytics-card-label">Memory span</span>
          </div>
        )}
      </div>

      <div className="analytics-grid">
        {/* Weekly Growth */}
        {data.weekly_growth.length > 0 && (
          <div className="analytics-section analytics-wide">
            <h3>Weekly Growth</h3>
            <div className="growth-chart">
              {data.weekly_growth.map((w) => (
                <div key={w.week} className="growth-bar-col" title={`${w.week}: ${w.created} created`}>
                  <div className="growth-bar-wrapper">
                    <div
                      className="growth-bar"
                      style={{ height: `${(w.created / maxWeekly) * 100}%` }}
                    />
                  </div>
                  <span className="growth-bar-count">{w.created}</span>
                  <span className="growth-bar-label">{w.week.replace(/^\d{4}-/, "")}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Status Breakdown */}
        {data.by_status.length > 0 && (
          <div className="analytics-section">
            <h3>By Status</h3>
            <div className="status-donut-container">
              <svg viewBox="0 0 100 100" className="status-donut">
                {(() => {
                  let offset = 0;
                  return data.by_status.map((s) => {
                    const pct = totalByStatus > 0 ? (s.count / totalByStatus) * 100 : 0;
                    const el = (
                      <circle
                        key={s.status}
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke={STATUS_COLORS[s.status] || "#6b7280"}
                        strokeWidth="16"
                        strokeDasharray={`${pct * 2.51} ${251 - pct * 2.51}`}
                        strokeDashoffset={-offset * 2.51}
                        transform="rotate(-90 50 50)"
                      />
                    );
                    offset += pct;
                    return el;
                  });
                })()}
              </svg>
              <div className="status-legend">
                {data.by_status.map((s) => (
                  <div key={s.status} className="status-legend-item">
                    <span className="legend-dot" style={{ background: STATUS_COLORS[s.status] || "#6b7280" }} />
                    <span>{s.status}</span>
                    <span className="legend-count">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Confidence by Type */}
        {data.avg_confidence_by_type.length > 0 && (
          <div className="analytics-section">
            <h3>Avg Confidence by Type</h3>
            <div className="confidence-type-list">
              {data.avg_confidence_by_type.map((t) => (
                <div key={t.type} className="confidence-type-row">
                  <span className="confidence-type-label">{t.type}</span>
                  <div className="confidence-type-bar-track">
                    <div
                      className="confidence-type-bar-fill"
                      style={{
                        width: `${t.avg_confidence * 100}%`,
                        backgroundColor: TYPE_COLORS[t.type] || "#6b7280",
                      }}
                    />
                  </div>
                  <span className="confidence-type-pct">
                    {(t.avg_confidence * 100).toFixed(0)}%
                  </span>
                  <span className="confidence-type-count">({t.count})</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Most Confirmed */}
        {data.most_confirmed.length > 0 && (
          <div className="analytics-section">
            <h3>Most Confirmed</h3>
            <div className="ranked-list">
              {data.most_confirmed.map((m, i) => (
                <div key={m.key} className="ranked-item">
                  <span className="ranked-num">{i + 1}</span>
                  <span className="ranked-key">{m.key}</span>
                  <span className="ranked-value">{m.confirmations}x</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Most Linked */}
        {data.most_linked.length > 0 && (
          <div className="analytics-section">
            <h3>Most Linked</h3>
            <div className="ranked-list">
              {data.most_linked.map((m, i) => (
                <div key={m.key} className="ranked-item">
                  <span className="ranked-num">{i + 1}</span>
                  <span className="ranked-key">{m.key}</span>
                  <span className="ranked-type">[{m.type}]</span>
                  <span className="ranked-value">{m.link_count} links</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pinned by Domain */}
        {data.pinned_by_domain.length > 0 && (
          <div className="analytics-section">
            <h3>Pinned by Domain</h3>
            <div className="ranked-list">
              {data.pinned_by_domain.map((p) => (
                <div key={p.domain} className="ranked-item">
                  <span className="ranked-key">{p.domain}</span>
                  <span className="ranked-value">{p.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Age info */}
      {data.age_stats.oldest && (
        <div className="analytics-age-bar">
          <span>
            Oldest memory: {new Date(data.age_stats.oldest).toLocaleDateString()}
          </span>
          <span>
            Newest memory: {data.age_stats.newest ? new Date(data.age_stats.newest).toLocaleDateString() : "n/a"}
          </span>
        </div>
      )}
    </div>
  );
}

function daysBetween(isoDate: string): number {
  try {
    const d = new Date(isoDate.replace(" ", "T") + (isoDate.includes("Z") ? "" : "Z"));
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  } catch {
    return 0;
  }
}

export default Analytics;
