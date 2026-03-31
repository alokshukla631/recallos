import { useState, useEffect } from "react";
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

function parseJsonField(val: any): any {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

function ContextDebug() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SnapshotDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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

  const getIdCount = (val: any): number => {
    const parsed = parseJsonField(val);
    if (Array.isArray(parsed)) return parsed.length;
    return 0;
  };

  return (
    <div className="page debug-page">
      <h2>Context Debug</h2>
      <p>Inspect context compilation snapshots and decisions.</p>

      {error && <div className="debug-error">{error}</div>}

      <div className="debug-split">
        {/* Left: snapshot list */}
        <div className="debug-list">
          <div className="debug-list-header">Snapshots</div>

          {loading && <div className="debug-loading">Loading...</div>}

          {!loading && snapshots.length === 0 && (
            <div className="debug-empty">No snapshots found.</div>
          )}

          {snapshots.map((snap) => (
            <button
              key={snap.id}
              className={`snapshot-item${selectedId === snap.id ? " selected" : ""}`}
              onClick={() => handleSelect(snap.id)}
            >
              <div className="snapshot-item-top">
                <span className="snapshot-event">
                  {snap.event_id || `#${snap.id}`}
                </span>
                <span className="snapshot-provider">{snap.provider}</span>
              </div>
              <div className="snapshot-item-bottom">
                <span className="snapshot-time">
                  {new Date(snap.created_at).toLocaleString()}
                </span>
                <span className="snapshot-counts">
                  {getIdCount(snap.included_memory_ids)} incl /{" "}
                  {getIdCount(snap.omitted_memory_ids)} omit
                </span>
              </div>
            </button>
          ))}
        </div>

        {/* Right: detail pane */}
        <div className="debug-detail">
          {!selectedId && (
            <div className="debug-detail-empty">
              Select a snapshot to view details.
            </div>
          )}

          {detailLoading && <div className="debug-loading">Loading detail...</div>}

          {detail && !detailLoading && (
            <div className="snapshot-detail">
              <div className="detail-header">
                <h3>{detail.event_id || `Snapshot #${detail.id}`}</h3>
                <span className="detail-provider">{detail.provider}</span>
                <span className="detail-time">
                  {new Date(detail.created_at).toLocaleString()}
                </span>
              </div>

              {/* Prompt preview */}
              {detail.prompt_preview && (
                <div className="detail-section">
                  <h4>Compiled Context (Prompt Preview)</h4>
                  <pre className="detail-pre">{detail.prompt_preview}</pre>
                </div>
              )}

              {/* Included IDs */}
              <div className="detail-section">
                <h4>
                  Included Memory IDs (
                  {(() => {
                    const arr = parseJsonField(detail.included_memory_ids);
                    return Array.isArray(arr) ? arr.length : 0;
                  })()}
                  )
                </h4>
                <div className="id-list">
                  {(() => {
                    const arr = parseJsonField(detail.included_memory_ids);
                    if (Array.isArray(arr) && arr.length > 0) {
                      return arr.map((id: number, i: number) => (
                        <span key={i} className="id-chip included">
                          {id}
                        </span>
                      ));
                    }
                    return <span className="debug-muted">None</span>;
                  })()}
                </div>
              </div>

              {/* Omitted IDs */}
              <div className="detail-section">
                <h4>
                  Omitted Memory IDs (
                  {(() => {
                    const arr = parseJsonField(detail.omitted_memory_ids);
                    return Array.isArray(arr) ? arr.length : 0;
                  })()}
                  )
                </h4>
                <div className="id-list">
                  {(() => {
                    const arr = parseJsonField(detail.omitted_memory_ids);
                    if (Array.isArray(arr) && arr.length > 0) {
                      return arr.map((id: number, i: number) => (
                        <span key={i} className="id-chip omitted">
                          {id}
                        </span>
                      ));
                    }
                    return <span className="debug-muted">None</span>;
                  })()}
                </div>
              </div>

              {/* Rationale */}
              {detail.rationale_json && (
                <div className="detail-section">
                  <h4>Rationale</h4>
                  <pre className="detail-pre">
                    {JSON.stringify(
                      parseJsonField(detail.rationale_json),
                      null,
                      2
                    )}
                  </pre>
                </div>
              )}

              {/* Compiled context JSON */}
              {detail.compiled_context_json && (
                <div className="detail-section">
                  <h4>Compiled Context JSON</h4>
                  <pre className="detail-pre">
                    {JSON.stringify(
                      parseJsonField(detail.compiled_context_json),
                      null,
                      2
                    )}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ContextDebug;
