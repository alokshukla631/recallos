import { v4 as uuidv4 } from "uuid";
import { queryOne, queryAll, runSql } from "../db/index.js";

export type TripStatus = "planning" | "active" | "completed" | "cancelled";

export interface Trip {
  id: string;
  name: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  status: TripStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTripInput {
  name: string;
  destination?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  status?: TripStatus;
  notes?: string | null;
}

export interface UpdateTripInput {
  name?: string;
  destination?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  status?: TripStatus;
  notes?: string | null;
}

export function listTrips(): Trip[] {
  return queryAll(
    `SELECT t.*,
            (SELECT COUNT(*) FROM conversations WHERE trip_id = t.id) AS conversation_count,
            (SELECT COUNT(*) FROM memory_items WHERE trip_id = t.id AND status = 'active') AS memory_count
     FROM trips t
     ORDER BY
       CASE status
         WHEN 'active' THEN 1
         WHEN 'planning' THEN 2
         WHEN 'completed' THEN 3
         WHEN 'cancelled' THEN 4
       END,
       t.updated_at DESC`
  ) as unknown as Trip[];
}

export function getTrip(id: string): Trip | undefined {
  return queryOne(
    "SELECT * FROM trips WHERE id = ?",
    [id]
  ) as unknown as Trip | undefined;
}

export function createTrip(input: CreateTripInput): Trip {
  const id = uuidv4();
  runSql(
    `INSERT INTO trips (id, name, destination, start_date, end_date, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.destination ?? null,
      input.start_date ?? null,
      input.end_date ?? null,
      input.status ?? "planning",
      input.notes ?? null,
    ]
  );
  return getTrip(id)!;
}

export function updateTrip(id: string, input: UpdateTripInput): Trip | undefined {
  const existing = getTrip(id);
  if (!existing) return undefined;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    fields.push("name = ?");
    values.push(input.name);
  }
  if (input.destination !== undefined) {
    fields.push("destination = ?");
    values.push(input.destination);
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

  runSql(`UPDATE trips SET ${fields.join(", ")} WHERE id = ?`, values);
  return getTrip(id);
}

export function deleteTrip(id: string): void {
  // Orphan the conversations that referenced this trip (keep the chat history)
  runSql("UPDATE conversations SET trip_id = NULL WHERE trip_id = ?", [id]);
  // Orphan memory items that were scoped to this trip
  runSql(
    "UPDATE memory_items SET trip_id = NULL, scope = 'global' WHERE trip_id = ?",
    [id]
  );
  runSql("DELETE FROM trips WHERE id = ?", [id]);
}
