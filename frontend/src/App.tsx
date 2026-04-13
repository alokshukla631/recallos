import { useState, useEffect, useCallback } from "react";
import { NavLink, Routes, Route, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  MessageSquare,
  Brain,
  Bug,
  Settings as SettingsIcon,
  Plane,
  ScanSearch,
  Link2,
  Sun,
  Moon,
  Clock,
  HeartPulse,
  Network,
} from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Chat from "./pages/Chat";
import Memory from "./pages/Memory";
import Links from "./pages/Links";
import Timeline from "./pages/Timeline";
import ContextDebug from "./pages/ContextDebug";
import Settings from "./pages/Settings";
import Trips from "./pages/Trips";
import Scraper from "./pages/Scraper";
import Health from "./pages/Health";
import Graph from "./pages/Graph";
import CommandPalette from "./components/CommandPalette";
import ShortcutHelp from "./components/ShortcutHelp";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/trips", label: "Trips", icon: Plane },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/timeline", label: "Timeline", icon: Clock },
  { to: "/links", label: "Links", icon: Link2 },
  { to: "/scraper", label: "Scraper", icon: ScanSearch },
  { to: "/graph", label: "Graph", icon: Network },
  { to: "/health", label: "Health", icon: HeartPulse },
  { to: "/debug", label: "Context Debug", icon: Bug },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function App() {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [conflictCount, setConflictCount] = useState(0);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("recallos-theme") as "dark" | "light") || "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("recallos-theme", theme);
  }, [theme]);

  // Poll for pending conflicts every 30s
  useEffect(() => {
    async function checkConflicts() {
      try {
        const res = await fetch("/api/memory/conflicts?status=pending");
        if (res.ok) {
          const data = await res.json();
          setConflictCount(data.pending_count || 0);
        }
      } catch { /* ignore */ }
    }
    checkConflicts();
    const interval = setInterval(checkConflicts, 30000);
    return () => clearInterval(interval);
  }, []);

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  // Global keyboard shortcuts (Ctrl/Cmd + key)
  const handleKeyboard = useCallback((e: KeyboardEvent) => {
    // Don't fire when typing in inputs
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    // ? key (no modifier) opens shortcut help
    if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setShortcutHelpOpen((p) => !p);
      return;
    }

    if (!e.ctrlKey && !e.metaKey) return;

    switch (e.key) {
      case "1": e.preventDefault(); navigate("/"); break;
      case "2": e.preventDefault(); navigate("/chat"); break;
      case "3": e.preventDefault(); navigate("/memory"); break;
      case "4": e.preventDefault(); navigate("/timeline"); break;
      case "5": e.preventDefault(); navigate("/settings"); break;
      case "k": e.preventDefault(); setPaletteOpen((p) => !p); break;
      case "t": e.preventDefault(); toggleTheme(); break;
    }
  }, [navigate]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [handleKeyboard]);

  return (
    <div className="app">
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutHelp open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>RecallOS</h1>
          <button className="palette-trigger" onClick={() => setPaletteOpen(true)} title="Command palette (Ctrl+K)">
            <span>Ctrl+K</span>
          </button>
        </div>
        <nav className="sidebar-nav">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `nav-link${isActive ? " active" : ""}`
              }
            >
              <Icon size={18} />
              <span>{label}</span>
              {to === "/memory" && conflictCount > 0 && (
                <span className="nav-badge">{conflictCount}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className="theme-toggle" onClick={toggleTheme}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/trips" element={<Trips />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/timeline" element={<Timeline />} />
          <Route path="/debug" element={<ContextDebug />} />
          <Route path="/links" element={<Links />} />
          <Route path="/scraper" element={<Scraper />} />
          <Route path="/graph" element={<Graph />} />
          <Route path="/health" element={<Health />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
