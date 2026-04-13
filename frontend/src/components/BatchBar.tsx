import { useState, useRef } from "react";
import { useToast } from "./Toast";
import "./BatchBar.css";

interface Props {
  selectedIds: string[];
  onClear: () => void;
  onDone: () => void;
}

function BatchBar({ selectedIds, onClear, onDone }: Props) {
  const { toast } = useToast();
  const [running, setRunning] = useState(false);
  const [showTagInput, setShowTagInput] = useState(false);
  const [batchTag, setBatchTag] = useState("");
  const tagInputRef = useRef<HTMLInputElement>(null);

  if (selectedIds.length === 0) return null;

  async function runBatch(action: string) {
    setRunning(true);
    try {
      const res = await fetch("/api/memory/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds, action }),
      });
      if (!res.ok) throw new Error("Batch operation failed");
      const data = await res.json();
      toast(`${action}: ${data.affected} item${data.affected !== 1 ? "s" : ""} updated`, "success");
      onClear();
      onDone();
    } catch (err: any) {
      toast(err.message || "Batch failed", "error");
    } finally {
      setRunning(false);
    }
  }

  async function batchAddTag() {
    const tag = batchTag.trim().toLowerCase();
    if (!tag) return;
    setRunning(true);
    try {
      let added = 0;
      for (const id of selectedIds) {
        const res = await fetch(`/api/memory/${id}/tags`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tag }),
        });
        if (res.ok) added++;
      }
      toast(`Tagged ${added} item${added !== 1 ? "s" : ""} with "${tag}"`, "success");
      setBatchTag("");
      setShowTagInput(false);
      onDone();
    } catch (err: any) {
      toast(err.message || "Batch tag failed", "error");
    } finally {
      setRunning(false);
    }
  }

  async function exportSelected() {
    try {
      const details = await Promise.all(
        selectedIds.map(async (id) => {
          const res = await fetch(`/api/memory/${id}/detail`);
          if (!res.ok) return null;
          return res.json();
        })
      );
      const valid = details.filter(Boolean);
      const blob = new Blob([JSON.stringify(valid, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `recallos-export-${selectedIds.length}-items.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`Exported ${valid.length} item${valid.length !== 1 ? "s" : ""}`, "success");
    } catch (err: any) {
      toast(err.message || "Export failed", "error");
    }
  }

  return (
    <div className="batch-bar">
      <span className="batch-count">{selectedIds.length} selected</span>
      <div className="batch-actions">
        <button className="batch-btn batch-pin" onClick={() => runBatch("pin")} disabled={running}>Pin</button>
        <button className="batch-btn batch-unpin" onClick={() => runBatch("unpin")} disabled={running}>Unpin</button>
        <button className="batch-btn batch-reconfirm" onClick={() => runBatch("reconfirm")} disabled={running}>Reconfirm</button>
        <button
          className="batch-btn batch-tag"
          onClick={() => {
            setShowTagInput(!showTagInput);
            setTimeout(() => tagInputRef.current?.focus(), 50);
          }}
          disabled={running}
        >
          Tag
        </button>
        <button className="batch-btn batch-export" onClick={exportSelected} disabled={running}>Export</button>
        <button className="batch-btn batch-delete" onClick={() => runBatch("delete")} disabled={running}>Delete</button>
      </div>
      {showTagInput && (
        <div className="batch-tag-input">
          <input
            ref={tagInputRef}
            type="text"
            placeholder="Tag name..."
            value={batchTag}
            onChange={(e) => setBatchTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") batchAddTag(); }}
          />
          <button className="batch-btn batch-tag-apply" onClick={batchAddTag} disabled={!batchTag.trim() || running}>
            Apply
          </button>
        </div>
      )}
      <button className="batch-clear" onClick={onClear}>Clear selection</button>
    </div>
  );
}

export default BatchBar;
