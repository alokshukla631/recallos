import { useState, useEffect, useRef } from "react";
import "./ContextDebug.css";

interface Snapshot {
  id: number;
  event_id: string;
  provider: string;
  compiled_context_json: any;
  included_memory_ids: number[] | string;
  omitted_memory_ids: number[] | string;
  created_at: string;
}

interface SnapshotDetail extends Snapshot {
  prompt_preview?: string;
  rationale_json?: any;
}

interface CompareResult {
  snapshot_a: { id: string; event_id: string; provider: string; created_at: string; included_count: number; omitted_count: number };
  snapshot_b: { id: string; event_id: string; provider: string; created_at: string; included_count: number; omitted_count: number };
  diff: {
    added: { id: string; key: string; type: string; value: string; scope: string; domain?: string }[];
    removed: { id: string; key: string; type: string; value: string; scope: string; domain?: string }[];
    kept_count: number;
    total_changes: number;
  };
}

interface VerbatimSnippet {
  id: string;
  event_id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  context_window: string;
  created_at: string;
  bm25_score: number;
  temporal_boost: number;
  preference_boost: number;
  role_boost: number;
  semantic_score: number;
  final_score: number;
  score_reason: string;
}

interface QueryClassification {
  type: string;
  verbatimWeight: number;
  structuredWeight: number;
  signals: string[];
  temporalAnchor?: { reference: string; windowDays: number };
}

interface VerbatimSearchResult {
  query: string;
  classification: QueryClassification;
  snippets: VerbatimSnippet[];
  count: number;
}

type ActiveTab = "snapshots" | "evidence";

function parseJsonField(val: any): any {
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

function ScoreBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="score-bar-wrap">
      <div className="score-bar-track">
        <div className="score-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="score-bar-val">{value.toFixed(3)}</span>
    </div>
  );
}

function ContextDebug() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("snapshots");

  // ── Snapshots tab state ──────────────────────────────────────────────────────
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SnapshotDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [compareA, setCompareA] = useState<string | null>(null);
  const [compareB, setCompareB] = useState<string | null>(null);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  // ── Evidence Lane tab state ──────────────────────────────────────────────────
  const [evidenceQuery, setEvidenceQuery] = useState("");
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceResult, setEvidenceResult] = useState<VerbatimSearchResult | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [expandedSnippet, setExpandedSnippet] = useState<string | null>(null);
  const evidenceInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/context/snapshots");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setSnapshots(Array.isArray(data) ? data : []);
      } catch (err: any) {
        setError(err.message || "Failed to fetch snapshots");
        setSnapshots([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSelect = async (id: number) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/context/snapshots/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDetail(data);
    } catch (err: any) {
      setError(err.message || "Failed to fetch snapshot detail");
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCompareSelect = (id: string) => {
    if (!compareA) {
      setCompareA(id);
    } else if (!compareB && id !== compareA) {
      setCompareB(id);
    } else {
      setCompareA(id);
      setCompareB(null);
      setCompareResult(null);
    }
  };

  const runCompare = async () => {
    if (!compareA || !compareB) return;
    setCompareLoading(true);
    setCompareResult(null);
    try {
      const res = await fetch(`/api/context/snapshots/compare?a=${compareA}&b=${compareB}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCompareResult(await res.json());
    } catch (err: any) {
      setError(err.message || "Comparison failed");
    } finally {
      setCompareLoading(false);
    }
  };

  const exitCompareMode = () => {
    setCompareMode(false);
    setCompareA(null);
    setCompareB(null);
    setCompareResult(null);
  };

  const getIdCount = (val: any): number => {
    const parsed = parseJsonField(val);
    if (Array.isArray(parsed)) return parsed.length;
    return 0;
  };

  // ── Evidence Lane handlers ───────────────────────────────────────────────────
  const runEvidenceSearch = async () => {
    const q = evidenceQuery.trim();
    if (!q) return;
    setEvidenceLoading(true);
    setEvidenceError(null);
    setEvidenceResult(null);
    setExpandedSnippet(null);
    try {
      const res = await fetch("/api/context/verbatim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, max_results: 10 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEvidenceResult(await res.json());
    } catch (err: any) {
      setEvidenceError(err.message || "Search failed");
    } finally {
      setEvidenceLoading(false);
    }
  };

  const handleEvidenceKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") runEvidenceSearch();
  };

  const typeColor: Record<string, string> = {
    assistant_recall:       "#6d6dff",
    temporal_history:       "#f59e0b",
    preference_profile:     "#22c55e",
    episodic_search:        "#06b6d4",
    planning:               "#a855f7",
    balanced:               "#94a3b8",
  };

  return (
    <div className="page debug-page">
      <h2>Context Debug</h2>

      {/* Tab bar */}
      <div className="debug-tabs">
        <button
          className={`debug-tab${activeTab === "snapshots" ? " active" : ""}`}
          onClick={() => setActiveTab("snapshots")}
        >
          Snapshots
        </button>
        <button
          className={`debug-tab${activeTab === "evidence" ? " active" : ""}`}
          onClick={() => {
            setActiveTab("evidence");
            setTimeout(() => evidenceInputRef.current?.focus(), 50);
          }}
        >
          Evidence Lane
        </button>
      </div>

      {error && <div className="debug-error">{error}</div>}

      {/* ── SNAPSHOTS TAB ─────────────────────────────────────────────────────── */}
      {activeTab === "snapshots" && (
        <>
          <div className="debug-top-bar">
            <p>Inspect context compilation snapshots and decisions.</p>
            <button
              className={`btn ${compareMode ? "btn-danger" : "btn-secondary"}`}
              onClick={compareMode ? exitCompareMode : () => setCompareMode(true)}
            >
              {compareMode ? "Exit Compare" : "Compare Snapshots"}
            </button>
          </div>

          {compareMode && (
            <div className="compare-banner">
              <span className="compare-instructions">
                {!compareA ? "Select the first snapshot (A)" : !compareB ? "Select the second snapshot (B)" : "Ready to compare"}
              </span>
              {compareA && <span className="compare-selection">A: {compareA.slice(0, 8)}</span>}
              {compareB && <span className="compare-selection">B: {compareB.slice(0, 8)}</span>}
              {compareA && compareB && (
                <button className="btn btn-primary" onClick={runCompare} disabled={compareLoading}>
                  {compareLoading ? "Comparing..." : "Compare"}
                </button>
              )}
            </div>
          )}

          {compareResult && (
            <div className="compare-results">
              <div className="compare-header">
                <div className="compare-side">
                  <span className="compare-label">A</span>
                  <span className="compare-meta">{compareResult.snapshot_a.provider} - {new Date(compareResult.snapshot_a.created_at).toLocaleString()}</span>
                  <span className="compare-stat">{compareResult.snapshot_a.included_count} included</span>
                </div>
                <div className="compare-arrow">vs</div>
                <div className="compare-side">
                  <span className="compare-label">B</span>
                  <span className="compare-meta">{compareResult.snapshot_b.provider} - {new Date(compareResult.snapshot_b.created_at).toLocaleString()}</span>
                  <span className="compare-stat">{compareResult.snapshot_b.included_count} included</span>
                </div>
              </div>
              <div className="compare-summary">
                <span className="compare-stat-added">+{compareResult.diff.added.length} added</span>
                <span className="compare-stat-removed">-{compareResult.diff.removed.length} removed</span>
                <span className="compare-stat-kept">{compareResult.diff.kept_count} unchanged</span>
              </div>
              {compareResult.diff.added.length > 0 && (
                <div className="compare-section">
                  <h4>Added in B (not in A)</h4>
                  <div className="compare-items">
                    {compareResult.diff.added.map((item) => (
                      <div key={item.id} className="compare-item added">
                        <span className="compare-item-key">{item.key}</span>
                        <span className="compare-item-type">{item.type}</span>
                        <span className="compare-item-value">{item.value}</span>
                        {item.domain && <span className="compare-item-domain">{item.domain}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {compareResult.diff.removed.length > 0 && (
                <div className="compare-section">
                  <h4>Removed from A (not in B)</h4>
                  <div className="compare-items">
                    {compareResult.diff.removed.map((item) => (
                      <div key={item.id} className="compare-item removed">
                        <span className="compare-item-key">{item.key}</span>
                        <span className="compare-item-type">{item.type}</span>
                        <span className="compare-item-value">{item.value}</span>
                        {item.domain && <span className="compare-item-domain">{item.domain}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {compareResult.diff.total_changes === 0 && (
                <div className="compare-no-changes">No differences found between these snapshots.</div>
              )}
            </div>
          )}

          <div className="debug-split">
            <div className="debug-list">
              <div className="debug-list-header">Snapshots</div>
              {loading && <div className="debug-loading">Loading...</div>}
              {!loading && snapshots.length === 0 && (
                <div className="debug-empty">No snapshots found.</div>
              )}
              {snapshots.map((snap) => (
                <button
                  key={snap.id}
                  className={`snapshot-item${selectedId === snap.id ? " selected" : ""}${compareMode && (compareA === String(snap.id) || compareB === String(snap.id)) ? " compare-selected" : ""}`}
                  onClick={() => compareMode ? handleCompareSelect(String(snap.id)) : handleSelect(snap.id)}
                >
                  <div className="snapshot-item-top">
                    <span className="snapshot-event">{snap.event_id || `#${snap.id}`}</span>
                    <span className="snapshot-provider">{snap.provider}</span>
                  </div>
                  <div className="snapshot-item-bottom">
                    <span className="snapshot-time">{new Date(snap.created_at).toLocaleString()}</span>
                    <span className="snapshot-counts">
                      {getIdCount(snap.included_memory_ids)} incl / {getIdCount(snap.omitted_memory_ids)} omit
                    </span>
                  </div>
                </button>
              ))}
            </div>

            <div className="debug-detail">
              {!selectedId && <div className="debug-detail-empty">Select a snapshot to view details.</div>}
              {detailLoading && <div className="debug-loading">Loading detail...</div>}
              {detail && !detailLoading && (
                <div className="snapshot-detail">
                  <div className="detail-header">
                    <h3>{detail.event_id || `Snapshot #${detail.id}`}</h3>
                    <span className="detail-provider">{detail.provider}</span>
                    <span className="detail-time">{new Date(detail.created_at).toLocaleString()}</span>
                  </div>
                  {detail.prompt_preview && (
                    <div className="detail-section">
                      <h4>Compiled Context (Prompt Preview)</h4>
                      <pre className="detail-pre">{detail.prompt_preview}</pre>
                    </div>
                  )}
                  {(() => {
                    const rationaleObj = parseJsonField(detail.rationale_json);
                    const trace = rationaleObj?.trace;
                    if (!Array.isArray(trace) || trace.length === 0) {
                      return (
                        <>
                          <div className="detail-section">
                            <h4>Included ({getIdCount(detail.included_memory_ids)}) / Omitted ({getIdCount(detail.omitted_memory_ids)})</h4>
                            <div className="id-list">
                              {(() => {
                                const arr = parseJsonField(detail.included_memory_ids);
                                if (Array.isArray(arr) && arr.length > 0) {
                                  return arr.map((id: string, i: number) => (
                                    <span key={i} className="id-chip included">{String(id).slice(0, 8)}</span>
                                  ));
                                }
                                return <span className="debug-muted">None</span>;
                              })()}
                            </div>
                          </div>
                          {rationaleObj && (
                            <div className="detail-section">
                              <h4>Rationale</h4>
                              <pre className="detail-pre">{JSON.stringify(rationaleObj, null, 2)}</pre>
                            </div>
                          )}
                        </>
                      );
                    }
                    const included = trace.filter((t: any) => t.decision === "included");
                    const omitted  = trace.filter((t: any) => t.decision === "omitted");
                    return (
                      <div className="detail-section">
                        <h4>Compilation Trace ({included.length} included, {omitted.length} omitted)</h4>
                        <table className="trace-table">
                          <thead>
                            <tr>
                              <th>Decision</th><th>Key</th><th>Type</th><th>Value</th>
                              <th>Domain</th><th>BM25</th><th>Recency</th><th>Domain+</th>
                              <th>Score</th><th>Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {trace.map((t: any, i: number) => (
                              <tr key={i} className={t.decision === "included" ? "trace-included" : "trace-omitted"}>
                                <td><span className={`trace-badge ${t.decision}`}>{t.decision}</span></td>
                                <td className="trace-key">{t.key}</td>
                                <td>{t.type}</td>
                                <td className="trace-value">{t.value}</td>
                                <td>{t.domain || "general"}</td>
                                <td className="trace-score">{(t.bm25_score ?? 0).toFixed(3)}</td>
                                <td className="trace-score">{(t.recency_boost ?? 0).toFixed(3)}</td>
                                <td className="trace-score">{(t.domain_boost ?? 0).toFixed(3)}</td>
                                <td className="trace-score">{(t.final_score ?? t.bm25_score ?? 0).toFixed(3)}</td>
                                <td className="trace-reason">{t.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                  {detail.compiled_context_json && (
                    <div className="detail-section">
                      <h4>Compiled Context JSON</h4>
                      <pre className="detail-pre">{JSON.stringify(parseJsonField(detail.compiled_context_json), null, 2)}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── EVIDENCE LANE TAB ────────────────────────────────────────────────── */}
      {activeTab === "evidence" && (
        <div className="evidence-pane">
          <p className="evidence-description">
            Search raw conversation history with the five-signal scoring pipeline.
            Results show BM25, temporal proximity, preference-evidence, role, and semantic boosts.
          </p>

          <div className="evidence-search-row">
            <input
              ref={evidenceInputRef}
              className="evidence-input"
              type="text"
              placeholder="e.g. what laptop did you recommend? / what are my dietary preferences?"
              value={evidenceQuery}
              onChange={(e) => setEvidenceQuery(e.target.value)}
              onKeyDown={handleEvidenceKey}
            />
            <button
              className="btn btn-primary"
              onClick={runEvidenceSearch}
              disabled={evidenceLoading || !evidenceQuery.trim()}
            >
              {evidenceLoading ? "Searching…" : "Search"}
            </button>
          </div>

          {evidenceError && <div className="debug-error">{evidenceError}</div>}

          {evidenceResult && (
            <>
              {/* Classification chip */}
              <div className="evidence-meta-row">
                <span
                  className="evidence-type-chip"
                  style={{ background: (typeColor[evidenceResult.classification.type] ?? "#94a3b8") + "22",
                           borderColor: typeColor[evidenceResult.classification.type] ?? "#94a3b8",
                           color: typeColor[evidenceResult.classification.type] ?? "#94a3b8" }}
                >
                  {evidenceResult.classification.type}
                </span>
                <span className="evidence-meta-stat">
                  verbatim {(evidenceResult.classification.verbatimWeight * 100).toFixed(0)}%
                </span>
                <span className="evidence-meta-stat">
                  structured {(evidenceResult.classification.structuredWeight * 100).toFixed(0)}%
                </span>
                {evidenceResult.classification.temporalAnchor && (
                  <span className="evidence-temporal-chip">
                    ⏱ {evidenceResult.classification.temporalAnchor.reference} ±{evidenceResult.classification.temporalAnchor.windowDays}d
                  </span>
                )}
                <span className="evidence-meta-count">{evidenceResult.count} snippet{evidenceResult.count !== 1 ? "s" : ""}</span>
              </div>

              {evidenceResult.count === 0 && (
                <div className="evidence-empty">No relevant past conversations found for this query.</div>
              )}

              <div className="evidence-list">
                {evidenceResult.snippets.map((s, i) => {
                  const isExpanded = expandedSnippet === s.id;
                  const d = new Date(s.created_at);
                  const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

                  return (
                    <div key={s.id} className={`evidence-card${isExpanded ? " expanded" : ""}`}>
                      <div className="evidence-card-header" onClick={() => setExpandedSnippet(isExpanded ? null : s.id)}>
                        <div className="evidence-card-left">
                          <span className="evidence-rank">#{i + 1}</span>
                          <span className={`evidence-role ${s.role}`}>{s.role}</span>
                          <span className="evidence-date">{dateStr}</span>
                        </div>
                        <div className="evidence-card-right">
                          <span className="evidence-final-score">{s.final_score.toFixed(3)}</span>
                          <span className="evidence-expand-btn">{isExpanded ? "▲" : "▼"}</span>
                        </div>
                      </div>

                      <div className="evidence-card-preview">
                        {s.content.slice(0, 140)}{s.content.length > 140 ? "…" : ""}
                      </div>

                      {isExpanded && (
                        <div className="evidence-card-detail">
                          {/* Score breakdown */}
                          <div className="evidence-score-grid">
                            <div className="evidence-score-row">
                              <span className="evidence-score-label">BM25</span>
                              <ScoreBar value={s.bm25_score} max={1} color="#6d6dff" />
                            </div>
                            <div className="evidence-score-row">
                              <span className="evidence-score-label">Temporal</span>
                              <ScoreBar value={s.temporal_boost} max={0.4} color="#f59e0b" />
                            </div>
                            <div className="evidence-score-row">
                              <span className="evidence-score-label">Preference</span>
                              <ScoreBar value={s.preference_boost} max={0.25} color="#22c55e" />
                            </div>
                            <div className="evidence-score-row">
                              <span className="evidence-score-label">Role</span>
                              <ScoreBar value={s.role_boost} max={0.3} color="#ec4899" />
                            </div>
                            <div className="evidence-score-row">
                              <span className="evidence-score-label">Semantic</span>
                              <ScoreBar value={s.semantic_score} max={0.35} color="#06b6d4" />
                            </div>
                            <div className="evidence-score-row evidence-score-total">
                              <span className="evidence-score-label">Total</span>
                              <ScoreBar value={s.final_score} max={2} color="#94a3b8" />
                            </div>
                          </div>

                          <div className="evidence-score-reason">{s.score_reason}</div>

                          {/* Context window */}
                          <div className="evidence-context-label">Context window (±1 turns)</div>
                          <pre className="evidence-context-pre">{s.context_window}</pre>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default ContextDebug;
