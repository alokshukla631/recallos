import { useState, useEffect } from "react";
import "./Health.css";

interface DuplicateGroup {
  key: string;
  type: string;
  similarity: number;
  reason: string;
  items: Array<{
    id: string;
    value: string;
    scope: string;
    confidence: number;
    pinned: number;
    created_at: string;
  }>;
}

interface DecayCandidate {
  id: string;
  key: string;
  value: string;
  type: string;
  reason: string;
  importance: number;
}

interface ImportanceItem {
  id: string;
  key: string;
  value: string;
  importance: number;
}

interface Suggestion {
  type: string;
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
}

interface AgeBucket {
  label: string;
  count: number;
  color: string;
}

function Health() {
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [decayCandidates, setDecayCandidates] = useState<DecayCandidate[]>([]);
  const [topItems, setTopItems] = useState<ImportanceItem[]>([]);
  const [bottomItems, setBottomItems] = useState<ImportanceItem[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [conflictCount, setConflictCount] = useState(0);
  const [ageBuckets, setAgeBuckets] = useState<AgeBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  function runHealthCheck() {
    const isRefresh = !loading;
    if (isRefresh) setRefreshing(true);
    Promise.all([
      fetchDuplicates(),
      fetchDecay(),
      fetchImportance(),
      fetchSuggestions(),
      fetchConflictCount(),
      fetchAgeDistribution(),
    ]).finally(() => {
      setLoading(false);
      setRefreshing(false);
      setLastChecked(new Date());
    });
  }

  useEffect(() => {
    runHealthCheck();
  }, []);

  async function fetchDuplicates() {
    try {
      const res = await fetch("/api/memory/duplicates?threshold=0.5");
      if (!res.ok) return;
      const data = await res.json();
      setDuplicates(data.groups || []);
    } catch {
      // ignore
    }
  }

  async function fetchDecay() {
    try {
      const res = await fetch("/api/memory/decay");
      if (!res.ok) return;
      const data = await res.json();
      setDecayCandidates(data.candidates || []);
    } catch {
      // ignore
    }
  }

  async function fetchSuggestions() {
    try {
      const res = await fetch("/api/memory/suggestions");
      if (!res.ok) return;
      setSuggestions(await res.json());
    } catch {
      // ignore
    }
  }

  async function fetchConflictCount() {
    try {
      const res = await fetch("/api/memory/conflicts?status=pending");
      if (!res.ok) return;
      const data = await res.json();
      setConflictCount(data.pending_count ?? (Array.isArray(data) ? data.length : 0));
    } catch {
      // ignore
    }
  }

  async function fetchAgeDistribution() {
    try {
      const res = await fetch("/api/memory?limit=500&status=active");
      if (!res.ok) return;
      const data = await res.json();
      const items: Array<{ created_at: string }> = Array.isArray(data) ? data : (data.items || []);
      const now = Date.now();
      const buckets = {
        "< 1 hour": 0,
        "1-24 hours": 0,
        "1-7 days": 0,
        "1-4 weeks": 0,
        "1-3 months": 0,
        "3+ months": 0,
      };
      const colors: Record<string, string> = {
        "< 1 hour": "#22c55e",
        "1-24 hours": "#3b82f6",
        "1-7 days": "#a855f7",
        "1-4 weeks": "#f59e0b",
        "1-3 months": "#f97316",
        "3+ months": "#ef4444",
      };
      for (const item of items) {
        const ageMs = now - new Date(item.created_at).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        if (ageHours < 1) buckets["< 1 hour"]++;
        else if (ageHours < 24) buckets["1-24 hours"]++;
        else if (ageHours < 24 * 7) buckets["1-7 days"]++;
        else if (ageHours < 24 * 28) buckets["1-4 weeks"]++;
        else if (ageHours < 24 * 90) buckets["1-3 months"]++;
        else buckets["3+ months"]++;
      }
      setAgeBuckets(
        Object.entries(buckets).map(([label, count]) => ({
          label,
          count,
          color: colors[label],
        }))
      );
    } catch {
      // ignore
    }
  }

  async function fetchImportance() {
    try {
      const res = await fetch("/api/memory/importance?limit=50");
      if (!res.ok) return;
      const items: ImportanceItem[] = await res.json();
      setTopItems(items.slice(0, 10));
      setBottomItems(items.slice(-10).reverse());
    } catch {
      // ignore
    }
  }

  async function mergeDuplicate(keepId: string, removeId: string) {
    try {
      const res = await fetch("/api/memory/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: removeId, target_id: keepId }),
      });
      if (!res.ok) throw new Error("Merge failed");
      setActionMsg("Merged successfully");
      fetchDuplicates();
    } catch {
      setActionMsg("Merge failed");
    }
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function applyDecay() {
    try {
      const res = await fetch("/api/memory/decay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setActionMsg(`Marked ${data.marked} items as stale`);
      setDecayCandidates([]);
    } catch {
      setActionMsg("Decay failed");
    }
    setTimeout(() => setActionMsg(null), 3000);
  }

  if (loading) {
    return (
      <div className="page health-page">
        <h2>Memory Health</h2>
        <p className="muted">Analyzing...</p>
      </div>
    );
  }

  const healthScore = Math.max(
    0,
    100 - duplicates.length * 10 - decayCandidates.length * 5 - conflictCount * 8
  );

  return (
    <div className="page health-page">
      <div className="health-header">
        <div>
          <h2>Memory Health</h2>
          <p>Detect issues and keep your memory clean and efficient.</p>
        </div>
        <div className="health-header-right">
          {lastChecked && (
            <span className="health-last-checked">
              Last checked: {lastChecked.toLocaleTimeString()}
            </span>
          )}
          <button
            className="btn btn-secondary health-refresh-btn"
            onClick={runHealthCheck}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {actionMsg && <div className="health-action-msg">{actionMsg}</div>}

      {/* Health score */}
      <div className="health-score-card">
        <div className="health-score-number" data-level={healthScore >= 80 ? "good" : healthScore >= 50 ? "warn" : "bad"}>
          {healthScore}
        </div>
        <div className="health-score-label">
          <span className="health-score-title">Health Score</span>
          <span className="health-score-detail">
            {duplicates.length} duplicate groups, {decayCandidates.length} stale candidates
            {conflictCount > 0 ? `, ${conflictCount} pending conflicts` : ""}
          </span>
        </div>
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="suggestions-bar">
          {suggestions.slice(0, 4).map((s, i) => (
            <div key={i} className={`suggestion-card priority-${s.priority}`}>
              <div className="suggestion-title">{s.title}</div>
              <div className="suggestion-desc">{s.description}</div>
            </div>
          ))}
        </div>
      )}

      <div className="health-columns">
        {/* Duplicates */}
        <div className="health-section">
          <h3>Potential Duplicates ({duplicates.length})</h3>
          {duplicates.length === 0 ? (
            <p className="muted">No duplicates found.</p>
          ) : (
            <div className="duplicate-list">
              {duplicates.slice(0, 10).map((group, gi) => (
                <div key={gi} className="duplicate-group">
                  <div className="duplicate-header">
                    <span className="duplicate-key">{group.key}</span>
                    <span className="duplicate-sim">{Math.round(group.similarity * 100)}% similar</span>
                  </div>
                  <div className="duplicate-reason">{group.reason}</div>
                  <div className="duplicate-items">
                    {group.items.map((item, ii) => (
                      <div key={item.id} className="duplicate-item">
                        <span className="duplicate-value">{item.value.slice(0, 80)}</span>
                        <div className="duplicate-actions">
                          <span className="duplicate-meta">{item.scope} | conf: {Math.round(item.confidence * 100)}%</span>
                          {group.items.length === 2 && ii === 1 && (
                            <button
                              className="btn-small btn-merge"
                              onClick={() => mergeDuplicate(group.items[0].id, item.id)}
                            >
                              Keep first
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Decay */}
        <div className="health-section">
          <h3>Stale Candidates ({decayCandidates.length})</h3>
          {decayCandidates.length === 0 ? (
            <p className="muted">No stale items. Memory is fresh.</p>
          ) : (
            <>
              <div className="decay-candidates">
                {decayCandidates.slice(0, 8).map((c) => (
                  <div key={c.id} className="decay-card">
                    <div className="decay-card-top">
                      <span className="decay-card-key">{c.key}</span>
                      <span className="decay-card-score">{c.importance}</span>
                    </div>
                    <div className="decay-card-reason">{c.reason}</div>
                  </div>
                ))}
              </div>
              <button className="btn btn-danger" onClick={applyDecay}>
                Mark All as Stale ({decayCandidates.length})
              </button>
            </>
          )}
        </div>
      </div>

      {/* Conflict warning */}
      {conflictCount > 0 && (
        <div className="health-section conflict-warning-section">
          <h3>Pending Conflicts ({conflictCount})</h3>
          <p className="conflict-warning-text">
            There {conflictCount === 1 ? "is" : "are"} {conflictCount} unresolved
            conflict{conflictCount !== 1 ? "s" : ""} between memory items with the same key
            but different values. Resolve them on the Memory page.
          </p>
          <div className="conflict-warning-bar">
            <div
              className="conflict-warning-fill"
              style={{ width: `${Math.min(conflictCount * 20, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Memory age distribution */}
      {ageBuckets.length > 0 && (
        <div className="health-section age-section">
          <h3>Memory Age Distribution</h3>
          <div className="age-chart">
            {(() => {
              const maxCount = Math.max(...ageBuckets.map((b) => b.count), 1);
              return ageBuckets.map((bucket) => (
                <div key={bucket.label} className="age-bar-group">
                  <div className="age-bar-container">
                    <div
                      className="age-bar-fill"
                      style={{
                        height: `${(bucket.count / maxCount) * 100}%`,
                        background: bucket.color,
                      }}
                    />
                  </div>
                  <span className="age-bar-count">{bucket.count}</span>
                  <span className="age-bar-label">{bucket.label}</span>
                </div>
              ));
            })()}
          </div>
          <div className="age-total">
            {ageBuckets.reduce((sum, b) => sum + b.count, 0)} total active items
          </div>
        </div>
      )}

      {/* Importance distribution */}
      <div className="health-section importance-section">
        <h3>Importance Distribution</h3>
        <div className="importance-columns">
          <div className="importance-col">
            <h4>Most Important</h4>
            {topItems.map((item) => (
              <div key={item.id} className="importance-row">
                <span className="importance-bar-fill" style={{ width: `${item.importance}%` }} />
                <span className="importance-key">{item.key}</span>
                <span className="importance-value">{item.importance}</span>
              </div>
            ))}
          </div>
          <div className="importance-col">
            <h4>Least Important</h4>
            {bottomItems.map((item) => (
              <div key={item.id} className="importance-row low">
                <span className="importance-bar-fill" style={{ width: `${item.importance}%` }} />
                <span className="importance-key">{item.key}</span>
                <span className="importance-value">{item.importance}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Health;
