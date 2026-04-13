import { useState, useEffect, useRef } from "react";
import { Bell } from "lucide-react";
import "./NotificationBell.css";

interface Notification {
  id: string;
  type: "conflict" | "decay" | "health" | "info";
  title: string;
  message: string;
  link?: string;
  timestamp: number;
}

function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("recallos-dismissed-notifs");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    checkNotifications();
    const interval = setInterval(checkNotifications, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  async function checkNotifications() {
    const notifs: Notification[] = [];

    try {
      // Check conflicts
      const conflictRes = await fetch("/api/memory/conflicts?status=pending");
      if (conflictRes.ok) {
        const data = await conflictRes.json();
        const count = Array.isArray(data) ? data.length : data.pending_count || 0;
        if (count > 0) {
          notifs.push({
            id: "conflicts",
            type: "conflict",
            title: `${count} pending conflict${count !== 1 ? "s" : ""}`,
            message: "Memory items with the same key have different values.",
            link: "/memory",
            timestamp: Date.now(),
          });
        }
      }
    } catch {
      // ignore
    }

    try {
      // Check decay candidates
      const decayRes = await fetch("/api/memory/decay");
      if (decayRes.ok) {
        const data = await decayRes.json();
        const count = data.candidates?.length || 0;
        if (count > 0) {
          notifs.push({
            id: "decay",
            type: "decay",
            title: `${count} stale candidate${count !== 1 ? "s" : ""}`,
            message: "Some items may be outdated and could be cleaned up.",
            link: "/health",
            timestamp: Date.now(),
          });
        }
      }
    } catch {
      // ignore
    }

    try {
      // Check duplicates
      const dupRes = await fetch("/api/memory/duplicates?threshold=0.6");
      if (dupRes.ok) {
        const data = await dupRes.json();
        const count = data.groups?.length || 0;
        if (count > 0) {
          notifs.push({
            id: "duplicates",
            type: "health",
            title: `${count} duplicate group${count !== 1 ? "s" : ""}`,
            message: "Consider merging duplicate memory items.",
            link: "/health",
            timestamp: Date.now(),
          });
        }
      }
    } catch {
      // ignore
    }

    setNotifications(notifs);
  }

  function dismiss(id: string) {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    localStorage.setItem("recallos-dismissed-notifs", JSON.stringify([...next]));
  }

  function clearAll() {
    const allIds = new Set(notifications.map((n) => n.id));
    setDismissed(allIds);
    localStorage.setItem("recallos-dismissed-notifs", JSON.stringify([...allIds]));
    setOpen(false);
  }

  const visible = notifications.filter((n) => !dismissed.has(n.id));
  const count = visible.length;

  return (
    <div className="notif-bell-container" ref={panelRef}>
      <button
        className={`notif-bell-btn${count > 0 ? " has-notifs" : ""}`}
        onClick={() => setOpen(!open)}
        title={`${count} notification${count !== 1 ? "s" : ""}`}
      >
        <Bell size={16} />
        {count > 0 && <span className="notif-count">{count}</span>}
      </button>

      {open && (
        <div className="notif-panel">
          <div className="notif-panel-header">
            <span>Notifications</span>
            {visible.length > 0 && (
              <button className="notif-clear-all" onClick={clearAll}>
                Clear all
              </button>
            )}
          </div>
          {visible.length === 0 ? (
            <div className="notif-empty">No new notifications</div>
          ) : (
            <div className="notif-list">
              {visible.map((n) => (
                <div key={n.id} className={`notif-item notif-${n.type}`}>
                  <div className="notif-item-content">
                    <span className="notif-item-title">{n.title}</span>
                    <span className="notif-item-message">{n.message}</span>
                  </div>
                  <button
                    className="notif-dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismiss(n.id);
                    }}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
