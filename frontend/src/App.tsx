import { useState, useEffect } from "react";
import { NavLink, Routes, Route } from "react-router-dom";
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

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/trips", label: "Trips", icon: Plane },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/timeline", label: "Timeline", icon: Clock },
  { to: "/links", label: "Links", icon: Link2 },
  { to: "/scraper", label: "Scraper", icon: ScanSearch },
  { to: "/debug", label: "Context Debug", icon: Bug },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("recallos-theme") as "dark" | "light") || "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("recallos-theme", theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>RecallOS</h1>
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
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
