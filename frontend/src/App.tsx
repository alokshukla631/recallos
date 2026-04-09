import { NavLink, Routes, Route } from "react-router-dom";
import {
  MessageSquare,
  Brain,
  Bug,
  Settings as SettingsIcon,
  Plane,
} from "lucide-react";
import Chat from "./pages/Chat";
import Memory from "./pages/Memory";
import ContextDebug from "./pages/ContextDebug";
import Settings from "./pages/Settings";
import Trips from "./pages/Trips";

const navItems = [
  { to: "/", label: "Chat", icon: MessageSquare },
  { to: "/trips", label: "Trips", icon: Plane },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/debug", label: "Context Debug", icon: Bug },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function App() {
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
      </aside>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<Chat />} />
          <Route path="/trips" element={<Trips />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/debug" element={<ContextDebug />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
