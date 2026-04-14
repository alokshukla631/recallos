import { useState, useEffect } from "react";
import "./Analytics.css";

interface QualityData {
  score: number;
  grade: string;
  total_active: number;
  breakdown: {
    low_confidence: number;
    never_confirmed: number;
    no_tags: number;
    no_links: number;
    duplicate_keys: number;
    short_values: number;
    stale_count: number;
    tagged_pct: number;
    linked_pct: number;
  };
  issues: Array<{ type: string; severity: string; message: string; count: number }>;
  recommendations: Array<{ action: string; description: string; priority: string }>;
}

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

const GRADE_COLORS: Record<string, string> = {
  A: "#22c55e",
  B: "#3b82f6",
  C: "#f59e0b",
  D: "#f97316",
  F: "#ef4444",
};

const SEVERITY_COLORS: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#6b7280",
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#3b82f6",
};

function Analytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [quality, setQuality] = useState<QualityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fixStatus, setFixStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([
      fetch("/api/memory/stats/analytics").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/memory/stats/quality").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([analyticsData, qualityData]) => {
        setData(analyticsData);
        setQuality(qualityData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function runFix(action: string) {
    setFixStatus((s) => ({ ...s, [action]: "running" }));
    try {
      if (action === "reconfirm") {
        // Get low-confidence active items and batch reconfirm them
        const res = await fetch("/api/memory?status=active");
        if (!res.ok) throw new Error("Failed");
        const items = await res.json();
        const lowConf = items.filter((i: any) => i.confidence < 0.5).map((i: any) => i.id);
        if (lowConf.length > 0) {
          const batchRes = await fetch("/api/memory/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: lowConf.slice(0, 50), action: "reconfirm" }),
          });
          if (!batchRes.ok) throw new Error("Failed");
          const result = await batchRes.json();
          setFixStatus((s) => ({ ...s, [action]: `Reconfirmed ${result.affected} items` }));
        } else {
          setFixStatus((s) => ({ ...s, [action]: "No items to reconfirm" }));
        }
      } else if (action === "clean_stale") {
        const res = await fetch("/api/memory/decay", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (!res.ok) throw new Error("Failed");
        const result = await res.json();
        setFixStatus((s) => ({ ...s, [action]: `Marked ${result.marked} items stale` }));
      } else if (action === "confirm_old") {
        const res = await fetch("/api/memory?status=active");
        if (!res.ok) throw new Error("Failed");
        const items = await res.json();
        const old = items
          .filter((i: any) => !i.last_confirmed_at && daysBetween(i.created_at) > 7)
          .map((i: any) => i.id);
        if (old.length > 0) {
          const batchRes = await fetch("/api/memory/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: old.slice(0, 50), action: "reconfirm" }),
          });
          if (!batchRes.ok) throw new Error("Failed");
          const result = await batchRes.json();
          setFixStatus((s) => ({ ...s, [action]: `Confirmed ${result.affected} items` }));
        } else {
          setFixStatus((s) => ({ ...s, [action]: "No items to confirm" }));
        }
      } else if (action === "session-cleanup") {
        const res = await fetch("/api/memory/session/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ttl_hours: 24 }),
        });
        if (!res.ok) throw new Error("Failed");
        const result = await res.json();
        setFixStatus((s) => ({ ...s, [action]: `Expired ${result.expired_count} session items` }));
      } else {
        setFixStatus((s) => ({ ...s, [action]: "Action not available yet" }));
      }
      // Refresh quality data
      setTimeout(async () => {
        const qRes = await fetch("/api/memory/stats/quality");
        if (qRes.ok) setQuality(await qRes.json());
      }, 500);
    } catch {
      setFixStatus((s) => ({ ...s, [action]: "Failed" }));
    }
    setTimeout(() => setFixStatus((s) => { const n = { ...s }; delete n[action]; return n; }), 3000);
  }

  const fixableActions = new Set(["reconfirm", "clean_stale", "confirm_old"]);

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

      {/* Quality Score */}
      {quality && (
        <div className="quality-section">
          <div className="quality-header">
            <div className="quality-score-ring">
              <svg viewBox="0 0 80 80" className="quality-ring-svg">
                <circle cx="40" cy="40" r="34" fill="none" stroke="var(--border)" strokeWidth="6" />
                <circle
                  cx="40" cy="40" r="34"
                  fill="none"
                  stroke={GRADE_COLORS[quality.grade] || "#6b7280"}
                  strokeWidth="6"
                  strokeDasharray={`${quality.score * 2.136} 213.6`}
                  strokeLinecap="round"
                  transform="rotate(-90 40 40)"
                />
              </svg>
              <div className="quality-score-text">
                <span className="quality-grade" style={{ color: GRADE_COLORS[quality.grade] }}>{quality.grade}</span>
                <span className="quality-score-num">{quality.score}/100</span>
              </div>
            </div>
            <div className="quality-breakdown">
              <h3>Memory Quality</h3>
              <div className="quality-metrics">
                <span>{quality.breakdown.tagged_pct}% tagged</span>
                <span>{quality.breakdown.linked_pct}% linked</span>
                <span>{quality.breakdown.low_confidence} low confidence</span>
                <span>{quality.breakdown.duplicate_keys} duplicate keys</span>
              </div>
            </div>
          </div>

          {quality.issues.length > 0 && (
            <div className="quality-issues">
              {quality.issues.map((issue, i) => (
                <div key={i} className="quality-issue">
                  <span className="quality-issue-severity" style={{ color: SEVERITY_COLORS[issue.severity] }}>
                    {issue.severity}
                  </span>
                  <span className="quality-issue-message">{issue.message}</span>
                </div>
              ))}
            </div>
          )}

          {quality.recommendations.length > 0 && (
            <div className="quality-recs">
              <h4>Recommendations</h4>
              {quality.recommendations.map((rec, i) => (
                <div key={i} className="quality-rec">
                  <span className="quality-rec-priority" style={{ background: PRIORITY_COLORS[rec.priority] }}>
                    {rec.priority}
                  </span>
                  <span className="quality-rec-desc">{rec.description}</span>
                  {fixableActions.has(rec.action) && (
                    fixStatus[rec.action] ? (
                      <span className="quality-fix-status">{fixStatus[rec.action]}</span>
                    ) : (
                      <button
                        className="quality-fix-btn"
                        onClick={() => runFix(rec.action)}
                      >
                        Fix
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
