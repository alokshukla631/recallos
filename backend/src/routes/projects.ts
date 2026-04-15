import { Router, Request, Response } from "express";
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  type ProjectStatus,
} from "../modules/projects.js";

const router = Router();

const VALID_STATUSES: ProjectStatus[] = ["planning", "active", "completed", "cancelled"];

function isValidStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && VALID_STATUSES.includes(value as ProjectStatus);
}

// GET / - list all projects
router.get("/", (_req: Request, res: Response) => {
  try {
    res.json(listProjects());
  } catch (err) {
    console.error("GET /api/projects error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id - get a single project
router.get("/:id", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const project = getProject(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project);
  } catch (err) {
    console.error("GET /api/projects/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / - create a new project
router.post("/", (req: Request, res: Response) => {
  try {
    const { name, description, start_date, end_date, status, notes } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    if (status !== undefined && !isValidStatus(status)) {
      res.status(400).json({
        error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      });
      return;
    }

    const project = createProject({
      name: name.trim(),
      description: description ?? null,
      start_date: start_date ?? null,
      end_date: end_date ?? null,
      status: status ?? "planning",
      notes: notes ?? null,
    });

    res.status(201).json(project);
  } catch (err) {
    console.error("POST /api/projects error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id - update a project
router.patch("/:id", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const existing = getProject(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { name, description, start_date, end_date, status, notes } = req.body;

    if (status !== undefined && !isValidStatus(status)) {
      res.status(400).json({
        error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      });
      return;
    }

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }

    const updated = updateProject(id, {
      name: name?.trim(),
      description,
      start_date,
      end_date,
      status,
      notes,
    });

    res.json(updated);
  } catch (err) {
    console.error("PATCH /api/projects/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id - delete a project (orphans conversations and memories)
router.delete("/:id", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const project = getProject(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    deleteProject(id);
    res.json({ message: "Project deleted" });
  } catch (err) {
    console.error("DELETE /api/projects/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
