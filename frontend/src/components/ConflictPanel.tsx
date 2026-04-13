import { useState, useEffect } from "react";
import { useToast } from "./Toast";
import "./ConflictPanel.css";

interface Conflict {
  id: string;
  existing_id: string;
  new_id: string;
  key: string;
  existing_value: string;
  new_value: string;
  status: string;
  created_at: string;
}

interface Props {
  onResolved: () => void;
}

function ConflictPanel({ onResolved }: Props) {
  const { toast } = useToast();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [mergeInputs, setMergeInputs] = useState<Record<string, string>>({});
  const [showMerge, setShowMerge] = useState<string | null>(null);

  useEffect(() => {
    fetchConflicts();
  }, []);

  async function fetchConflicts() {
    setLoading(true);
    try {
      const res = await fetch("/api/memory/conflicts?status=pending");
      if (!res.ok) throw new Error("Failed to fetch conflicts");
      const data = await res.json();
      setConflicts(data.conflicts || []);
      setPendingCount(data.pending_count || 0);
    } catch {
      setConflicts([]);
    } finally {
      setLoading(false);
    }
  }

  async function resolve(conflictId: string, resolution: string, mergedValue?: string) {
    setResolving(conflictId);
    try {
      const body: Record<string, string> = { resolution };
      if (mergedValue) body.merged_value = mergedValue;
      const res = await fetch(`/api/memory/conflicts/${conflictId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Resolution failed");
      toast(`Conflict resolved: ${resolution.replace("_", " ")}`, "success");
      fetchConflicts();
      onResolved();
    } catch (err: any) {
      toast(err.message || "Failed to resolve", "error");
    } finally {
      setResolving(null);
      setShowMerge(null);
    }
  }

  if (loading) return null;
  if (pendingCount === 0) return null;

  return (
    <div className="conflict-panel">
      <div className="conflict-header">
        <span className="conflict-icon">!</span>
        <h3>{pendingCount} Conflict{pendingCount !== 1 ? "s" : ""} Detected</h3>
      </div>
      <p className="conflict-desc">
        These memory items have the same key but different values. Choose which to keep.
      </p>
      <div className="conflict-list">
        {conflicts.map((c) => (
          <div key={c.id} className="conflict-card">
            <div className="conflict-key">{c.key}</div>
            <div className="conflict-values">
              <div className="conflict-value conflict-old">
                <span className="conflict-label">Existing</span>
                <span className="conflict-text">{c.existing_value}</span>
              </div>
              <div className="conflict-vs">vs</div>
              <div className="conflict-value conflict-new">
                <span className="conflict-label">New</span>
                <span className="conflict-text">{c.new_value}</span>
              </div>
            </div>
            <div className="conflict-actions">
              <button
                className="conflict-btn btn-keep-new"
                onClick={() => resolve(c.id, "keep_new")}
                disabled={resolving === c.id}
              >
                Keep New
              </button>
              <button
                className="conflict-btn btn-keep-old"
                onClick={() => resolve(c.id, "keep_old")}
                disabled={resolving === c.id}
              >
                Keep Old
              </button>
              <button
                className="conflict-btn btn-merge"
                onClick={() => {
                  setShowMerge(showMerge === c.id ? null : c.id);
                  setMergeInputs((prev) => ({
                    ...prev,
                    [c.id]: prev[c.id] || `${c.existing_value}; ${c.new_value}`,
                  }));
                }}
                disabled={resolving === c.id}
              >
                Merge
              </button>
            </div>
            {showMerge === c.id && (
              <div className="conflict-merge-row">
                <input
                  type="text"
                  value={mergeInputs[c.id] || ""}
                  onChange={(e) => setMergeInputs((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  placeholder="Merged value..."
                />
                <button
                  className="conflict-btn btn-apply-merge"
                  onClick={() => resolve(c.id, "merged", mergeInputs[c.id])}
                  disabled={resolving === c.id || !mergeInputs[c.id]?.trim()}
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default ConflictPanel;
