import { useState } from "react";
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

  return (
    <div className="batch-bar">
      <span className="batch-count">{selectedIds.length} selected</span>
      <div className="batch-actions">
        <button className="batch-btn batch-pin" onClick={() => runBatch("pin")} disabled={running}>Pin</button>
        <button className="batch-btn batch-unpin" onClick={() => runBatch("unpin")} disabled={running}>Unpin</button>
        <button className="batch-btn batch-reconfirm" onClick={() => runBatch("reconfirm")} disabled={running}>Reconfirm</button>
        <button className="batch-btn batch-delete" onClick={() => runBatch("delete")} disabled={running}>Delete</button>
      </div>
      <button className="batch-clear" onClick={onClear}>Clear selection</button>
    </div>
  );
}

export default BatchBar;
