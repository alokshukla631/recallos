/**
 * Memory Passport: export and import memory as portable JSON.
 *
 * The passport format is model-agnostic and human-readable. It contains
 * all active memory items, projects, and conflicts. It does NOT contain
 * conversation history or API keys, keeping the export lightweight and
 * safe to share.
 */
import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";

export interface PassportMemoryItem {
  key: string;
  type: string;
  value: string;
  scope: string;
  project_name: string | null;
  confidence: number;
  authority: string;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
  last_confirmed_at: string | null;
  created_at: string;
}

export interface PassportProject {
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  notes: string | null;
}

export interface PassportConflict {
  key: string;
  resolution: string;
  explanation: string | null;
  created_at: string;
}

export interface Passport {
  format: "recallos-passport-v1";
  exported_at: string;
  stats: {
    memory_items: number;
    projects: number;
    conflicts: number;
  };
  memory_items: PassportMemoryItem[];
  projects: PassportProject[];
  conflicts: PassportConflict[];
}

export interface ExportFilters {
  type?: string;
  scope?: string;
  domain?: string;
  tag?: string;
  pinned?: boolean;
}

/**
 * Export active memory, projects, and unresolved conflicts into a
 * portable JSON passport. Optional filters narrow the export.
 */
export function exportPassport(filters?: ExportFilters): Passport {
  const conditions: string[] = ["mi.status = 'active'"];
  const params: unknown[] = [];

  if (filters?.type) {
    conditions.push("mi.type = ?");
    params.push(filters.type);
  }
  if (filters?.scope) {
    conditions.push("mi.scope = ?");
    params.push(filters.scope);
  }
  if (filters?.domain) {
    conditions.push("mi.domain = ?");
    params.push(filters.domain);
  }
  if (filters?.pinned !== undefined) {
    conditions.push("mi.pinned = ?");
    params.push(filters.pinned ? 1 : 0);
  }

  let sql = `SELECT mi.*, p.name AS project_name
     FROM memory_items mi
     LEFT JOIN projects p ON mi.project_id = p.id
     WHERE ${conditions.join(" AND ")}`;

  if (filters?.tag) {
    sql = `SELECT mi.*, p.name AS project_name
     FROM memory_items mi
     LEFT JOIN projects p ON mi.project_id = p.id
     INNER JOIN memory_tags mt ON mt.memory_item_id = mi.id AND mt.tag = ?
     WHERE ${conditions.join(" AND ")}`;
    params.unshift(filters.tag);
  }

  sql += " ORDER BY mi.created_at ASC";

  const memories = queryAll(sql, params) as unknown as (Record<string, unknown> & { project_name: string | null })[];

  const projects = queryAll(
    `SELECT name, description, start_date, end_date, status, notes
     FROM projects
     ORDER BY created_at ASC`
  ) as unknown as PassportProject[];

  const conflicts = queryAll(
    `SELECT key, resolution, explanation, created_at
     FROM conflicts
     ORDER BY created_at ASC`
  ) as unknown as PassportConflict[];

  const items: PassportMemoryItem[] = memories.map((m) => ({
    key: m.key as string,
    type: m.type as string,
    value: m.value as string,
    scope: m.scope as string,
    project_name: m.project_name ?? null,
    confidence: m.confidence as number,
    authority: m.authority as string,
    status: m.status as string,
    valid_from: (m.valid_from as string) ?? null,
    valid_to: (m.valid_to as string) ?? null,
    last_confirmed_at: (m.last_confirmed_at as string) ?? null,
    created_at: m.created_at as string,
  }));

  return {
    format: "recallos-passport-v1",
    exported_at: new Date().toISOString(),
    stats: {
      memory_items: items.length,
      projects: projects.length,
      conflicts: conflicts.length,
    },
    memory_items: items,
    projects: projects,
    conflicts: conflicts,
  };
}

export interface ImportResult {
  projects_created: number;
  projects_skipped: number;
  memories_created: number;
  memories_skipped: number;
  conflicts_created: number;
}

/**
 * Import a passport into the local database.
 *
 * Strategy:
 *  - Projects are matched by name. If a project with the same name exists, skip it.
 *  - Memory items are matched by key + type + scope. If a match exists with
 *    the same normalized value, skip it. Otherwise, create it as new.
 *  - Conflicts are imported as-is.
 */
/**
 * Export memory as human-readable Markdown.
 * Grouped by type, with metadata as inline annotations.
 */
export function exportPassportMarkdown(): string {
  const passport = exportPassport();
  const lines: string[] = [];

  lines.push("# RecallOS Memory Export");
  lines.push("");
  lines.push(`Exported: ${passport.exported_at.slice(0, 10)}`);
  lines.push(`Items: ${passport.stats.memory_items} | Projects: ${passport.stats.projects} | Conflicts: ${passport.stats.conflicts}`);
  lines.push("");

  // Group items by type
  const byType = new Map<string, PassportMemoryItem[]>();
  for (const item of passport.memory_items) {
    const group = byType.get(item.type) || [];
    group.push(item);
    byType.set(item.type, group);
  }

  for (const [type, items] of byType) {
    lines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
    lines.push("");
    for (const item of items) {
      const meta: string[] = [];
      meta.push(`scope: ${item.scope}`);
      if (item.project_name) meta.push(`project: ${item.project_name}`);
      meta.push(`confidence: ${item.confidence}`);
      if (item.authority !== "explicit") meta.push(`authority: ${item.authority}`);

      lines.push(`- **${item.key}**: ${item.value}`);
      lines.push(`  _${meta.join(" | ")}_`);
    }
    lines.push("");
  }

  if (passport.projects.length > 0) {
    lines.push("## Projects");
    lines.push("");
    for (const project of passport.projects) {
      const dates = [project.start_date, project.end_date].filter(Boolean).join(" to ");
      lines.push(`- **${project.name}**${project.description ? ` - ${project.description}` : ""}`);
      if (dates) lines.push(`  Dates: ${dates}`);
      lines.push(`  Status: ${project.status}`);
      if (project.notes) lines.push(`  Notes: ${project.notes}`);
    }
    lines.push("");
  }

  if (passport.conflicts.length > 0) {
    lines.push("## Unresolved Conflicts");
    lines.push("");
    for (const c of passport.conflicts) {
      lines.push(`- **${c.key}**: ${c.resolution}${c.explanation ? ` - ${c.explanation}` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function importPassport(passport: Passport): ImportResult {
  if (passport.format !== "recallos-passport-v1") {
    throw new Error(
      `Unknown passport format: ${passport.format}. Expected recallos-passport-v1.`
    );
  }

  const result: ImportResult = {
    projects_created: 0,
    projects_skipped: 0,
    memories_created: 0,
    memories_skipped: 0,
    conflicts_created: 0,
  };

  // Build a name-to-id map for projects
  const projectNameToId = new Map<string, string>();

  // Import projects
  for (const project of passport.projects ?? []) {
    const existing = queryOne(
      "SELECT id FROM projects WHERE name = ?",
      [project.name]
    );
    if (existing) {
      projectNameToId.set(project.name, existing.id as string);
      result.projects_skipped++;
      continue;
    }
    const id = uuidv4();
    runSql(
      `INSERT INTO projects (id, name, description, start_date, end_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        project.name,
        project.description ?? null,
        project.start_date ?? null,
        project.end_date ?? null,
        project.status ?? "planning",
        project.notes ?? null,
      ]
    );
    projectNameToId.set(project.name, id);
    result.projects_created++;
  }

  // Import memory items
  for (const mem of passport.memory_items ?? []) {
    const projectId = mem.project_name ? projectNameToId.get(mem.project_name) ?? null : null;

    // Check for duplicate: same key, type, scope, active
    const existing = queryOne(
      `SELECT id, value FROM memory_items
       WHERE key = ? AND type = ? AND scope = ? AND status = 'active'
       LIMIT 1`,
      [mem.key, mem.type, mem.scope]
    );

    if (existing) {
      const existingValue = (existing.value as string).toLowerCase().trim();
      const newValue = mem.value.toLowerCase().trim();
      if (existingValue === newValue) {
        result.memories_skipped++;
        continue;
      }
    }

    const id = uuidv4();
    runSql(
      `INSERT INTO memory_items
         (id, key, type, value, scope, project_id, confidence, authority, status, valid_from, valid_to, last_confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [
        id,
        mem.key,
        mem.type,
        mem.value,
        mem.scope,
        projectId,
        mem.confidence ?? 0.8,
        mem.authority ?? "explicit",
        mem.valid_from ?? null,
        mem.valid_to ?? null,
        mem.last_confirmed_at ?? null,
      ]
    );
    result.memories_created++;
  }

  // Import conflicts
  for (const conflict of passport.conflicts ?? []) {
    const id = uuidv4();
    runSql(
      `INSERT INTO conflicts (id, key, memory_item_a_id, memory_item_b_id, resolution, explanation)
       VALUES (?, ?, '', '', ?, ?)`,
      [id, conflict.key, conflict.resolution, conflict.explanation ?? null]
    );
    result.conflicts_created++;
  }

  return result;
}
