import { useState, useEffect, useCallback } from "react";
import "./Projects.css";

type ProjectStatus = "planning" | "active" | "completed" | "cancelled";

interface Project {
  id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: ProjectStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  conversation_count?: number;
  memory_count?: number;
}

const EMPTY_FORM = {
  name: "",
  description: "",
  start_date: "",
  end_date: "",
  status: "planning" as ProjectStatus,
  notes: "",
};

function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to load projects");
      const data: Project[] = await res.json();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  function openNewForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setError(null);
  }

  function openEditForm(project: Project) {
    setEditingId(project.id);
    setForm({
      name: project.name,
      description: project.description ?? "",
      start_date: project.start_date ?? "",
      end_date: project.end_date ?? "",
      status: project.status,
      notes: project.notes ?? "",
    });
    setShowForm(true);
    setError(null);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
  }

  async function saveProject(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }

    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      status: form.status,
      notes: form.notes.trim() || null,
    };

    try {
      const url = editingId ? `/api/projects/${editingId}` : "/api/projects";
      const method = editingId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save project");
      }
      await fetchProjects();
      closeForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save project");
    }
  }

  async function removeProject(id: string) {
    if (!confirm("Delete this project? Conversations and memories linked to it will be kept but unlinked.")) return;
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete project");
      fetchProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete project");
    }
  }

  function formatDate(date: string | null) {
    if (!date) return "\u2014";
    try {
      const [y, m, d] = date.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString();
    } catch {
      return date;
    }
  }

  if (loading) {
    return (
      <div className="projects-page">
        <div className="projects-header">
          <h2>Projects</h2>
        </div>
        <div className="projects-empty">Loading...</div>
      </div>
    );
  }

  return (
    <div className="projects-page">
      <div className="projects-header">
        <h2>Projects</h2>
        <button className="projects-new-btn" onClick={openNewForm}>
          + New Project
        </button>
      </div>

      {error && <div className="projects-error">{error}</div>}

      {showForm && (
        <form className="project-form" onSubmit={saveProject}>
          <h3>{editingId ? "Edit Project" : "New Project"}</h3>
          <div className="form-row">
            <label>
              Name *
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="My Project"
                required
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Description
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Brief description of the project"
              />
            </label>
          </div>
          <div className="form-row two-col">
            <label>
              Start date
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              />
            </label>
            <label>
              End date
              <input
                type="date"
                value={form.end_date}
                onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Status
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as ProjectStatus })}
              >
                <option value="planning">Planning</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Notes
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Any notes about this project..."
                rows={3}
              />
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={closeForm}>
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              {editingId ? "Save Changes" : "Create Project"}
            </button>
          </div>
        </form>
      )}

      {projects.length === 0 ? (
        <div className="projects-empty">
          No projects yet. Create one to scope memories and conversations to a specific project.
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map((project) => (
            <div key={project.id} className={`project-card status-${project.status}`}>
              <div className="project-card-header">
                <h3>{project.name}</h3>
                <span className={`status-badge status-${project.status}`}>{project.status}</span>
              </div>
              {project.description && <div className="project-description">{project.description}</div>}
              <div className="project-dates">
                {formatDate(project.start_date)} &rarr; {formatDate(project.end_date)}
              </div>
              {project.notes && <div className="project-notes">{project.notes}</div>}
              <div className="project-stats">
                <span>{project.conversation_count ?? 0} conversations</span>
                <span>{project.memory_count ?? 0} memories</span>
              </div>
              <div className="project-actions">
                <button className="btn-link" onClick={() => openEditForm(project)}>
                  Edit
                </button>
                <button className="btn-link danger" onClick={() => removeProject(project.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Projects;
