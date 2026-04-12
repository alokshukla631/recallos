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

function Health() {
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [decayCandidates, setDecayCandidates] = useState<DecayCandidate[]>([]);
  const [topItems, setTopItems] = useState<ImportanceItem[]>([]);
  const [bottomItems, setBottomItems] = useState<ImportanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchDuplicates(), fetchDecay(), fetchImportance()]).finally(() =>
      setLoading(false)
    );
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
    100 - duplicates.length * 10 - decayCandidates.length * 5
  );

  return (
    <div className="page health-page">
      <h2>Memory Health</h2>
      <p>Detect issues and keep your memory clean and efficient.</p>

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
          </span>
        </div>
      </div>

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
