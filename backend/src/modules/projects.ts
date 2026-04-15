import { v4 as uuidv4 } from "uuid";
import { queryOne, queryAll, runSql } from "../db/index.js";

export type ProjectStatus = "planning" | "active" | "completed" | "cancelled";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: ProjectStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  status?: ProjectStatus;
  notes?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  status?: ProjectStatus;
  notes?: string | null;
}

export function listProjects(): Project[] {
  return queryAll(
    `SELECT p.*,
            (SELECT COUNT(*) FROM conversations WHERE project_id = p.id) AS conversation_count,
            (SELECT COUNT(*) FROM memory_items WHERE project_id = p.id AND status = 'active') AS memory_count
     FROM projects p
     ORDER BY
       CASE status
         WHEN 'active' THEN 1
         WHEN 'planning' THEN 2
         WHEN 'completed' THEN 3
         WHEN 'cancelled' THEN 4
       END,
       p.updated_at DESC`
  ) as unknown as Project[];
}

export function getProject(id: string): Project | undefined {
  return queryOne(
    "SELECT * FROM projects WHERE id = ?",
    [id]
  ) as unknown as Project | undefined;
}

export function createProject(input: CreateProjectInput): Project {
  const id = uuidv4();
  runSql(
    `INSERT INTO projects (id, name, description, start_date, end_date, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.description ?? null,
      input.start_date ?? null,
      input.end_date ?? null,
      input.status ?? "planning",
      input.notes ?? null,
    ]
  );
  return getProject(id)!;
}

export function updateProject(id: string, input: UpdateProjectInput): Project | undefined {
  const existing = getProject(id);
  if (!existing) return undefined;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    fields.push("name = ?");
    values.push(input.name);
  }
  if (input.description !== undefined) {
    fields.push("description = ?");
    values.push(input.description);
  }
  if (input.start_date !== undefined) {
    fields.push("start_date = ?");
    values.push(input.start_date);
  }
  if (input.end_date !== undefined) {
    fields.push("end_date = ?");
    values.push(input.end_date);
  }
  if (input.status !== undefined) {
    fields.push("status = ?");
    values.push(input.status);
  }
  if (input.notes !== undefined) {
    fields.push("notes = ?");
    values.push(input.notes);
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = datetime('now')");
  values.push(id);

  runSql(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`, values);
  return getProject(id);
}

export function deleteProject(id: string): void {
  // Orphan the conversations that referenced this project (keep the chat history)
  runSql("UPDATE conversations SET project_id = NULL WHERE project_id = ?", [id]);
  // Orphan memory items that were scoped to this project
  runSql(
    "UPDATE memory_items SET project_id = NULL, scope = 'global' WHERE project_id = ?",
    [id]
  );
  runSql("DELETE FROM projects WHERE id = ?", [id]);
}
