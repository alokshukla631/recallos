import { useEffect } from "react";
import "./ShortcutHelp.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { section: "Navigation", items: [
    { keys: "Ctrl+1", desc: "Dashboard" },
    { keys: "Ctrl+2", desc: "Chat" },
    { keys: "Ctrl+3", desc: "Memory" },
    { keys: "Ctrl+4", desc: "Timeline" },
    { keys: "Ctrl+5", desc: "Settings" },
  ]},
  { section: "Actions", items: [
    { keys: "Ctrl+K", desc: "Open command palette" },
    { keys: "Ctrl+T", desc: "Toggle dark/light theme" },
    { keys: "?", desc: "Show this shortcut reference" },
    { keys: "Esc", desc: "Close modal / clear selection" },
  ]},
  { section: "Memory Table", items: [
    { keys: "Click checkbox", desc: "Select single item" },
    { keys: "Shift+Click", desc: "Select range of items" },
    { keys: "Header click", desc: "Sort by column" },
  ]},
];

function ShortcutHelp({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="shortcut-overlay" onClick={onClose}>
      <div className="shortcut-panel" onClick={(e) => e.stopPropagation()}>
        <div className="shortcut-header">
          <h3>Keyboard Shortcuts</h3>
          <button className="shortcut-close" onClick={onClose}>Esc</button>
        </div>
        <div className="shortcut-body">
          {SHORTCUTS.map((section) => (
            <div key={section.section} className="shortcut-section">
              <h4>{section.section}</h4>
              <div className="shortcut-list">
                {section.items.map((item) => (
                  <div key={item.keys} className="shortcut-row">
                    <kbd className="shortcut-key">{item.keys}</kbd>
                    <span className="shortcut-desc">{item.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ShortcutHelp;
