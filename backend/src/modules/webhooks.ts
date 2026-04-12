/**
 * Webhook notifications for memory events.
 *
 * Users can configure a webhook URL via the API. When memory events occur
 * (created, superseded, conflict, bulk import), the webhook is called with
 * a JSON payload describing the event.
 */

import { queryOne, queryAll, runSql } from "../db/index.js";
import { v4 as uuidv4 } from "uuid";

export interface WebhookConfig {
  id: string;
  url: string;
  events: string[]; // e.g. ["created", "superseded", "conflict", "stale"]
  active: boolean;
  created_at: string;
}

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** Recent delivery log (in-memory, capped at 100 entries). */
const deliveryLog: Array<{
  id: string;
  webhook_id: string;
  event: string;
  url: string;
  status: "success" | "failed";
  status_code: number | null;
  error: string | null;
  timestamp: string;
}> = [];

const MAX_LOG_SIZE = 100;

/**
 * Send a webhook notification for a memory event.
 * Non-blocking: fires and forgets. Errors are logged but don't break the pipeline.
 */
export async function fireWebhook(event: string, data: Record<string, unknown>): Promise<void> {
  const hooks = queryAll(
    "SELECT * FROM webhooks WHERE active = 1"
  ) as unknown as WebhookConfig[];

  if (hooks.length === 0) return;

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  for (const hook of hooks) {
    // Check if this hook is subscribed to this event type
    let subscribedEvents: string[];
    try {
      subscribedEvents = typeof hook.events === "string"
        ? JSON.parse(hook.events)
        : hook.events;
    } catch {
      subscribedEvents = ["*"];
    }

    if (!subscribedEvents.includes("*") && !subscribedEvents.includes(event)) {
      continue;
    }

    // Fire and log
    const logEntry = {
      id: uuidv4(),
      webhook_id: hook.id,
      event,
      url: hook.url,
      status: "success" as "success" | "failed",
      status_code: null as number | null,
      error: null as string | null,
      timestamp: payload.timestamp,
    };

    fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    }).then((res) => {
      logEntry.status_code = res.status;
      if (!res.ok) {
        logEntry.status = "failed";
        logEntry.error = `HTTP ${res.status}`;
      }
    }).catch((err) => {
      logEntry.status = "failed";
      logEntry.error = err?.message || "Network error";
    }).finally(() => {
      deliveryLog.unshift(logEntry);
      if (deliveryLog.length > MAX_LOG_SIZE) {
        deliveryLog.length = MAX_LOG_SIZE;
      }
    });
  }
}

/**
 * Get recent webhook delivery log entries.
 */
export function getDeliveryLog(limit: number = 50) {
  return deliveryLog.slice(0, limit);
}

/**
 * Register a new webhook.
 */
export function registerWebhook(url: string, events: string[] = ["*"]): WebhookConfig {
  const id = uuidv4();
  const now = new Date().toISOString();
  runSql(
    "INSERT INTO webhooks (id, url, events, active, created_at) VALUES (?, ?, ?, 1, ?)",
    [id, url, JSON.stringify(events), now]
  );
  return { id, url, events, active: true, created_at: now };
}

/**
 * List all webhooks.
 */
export function listWebhooks(): WebhookConfig[] {
  const rows = queryAll("SELECT * FROM webhooks ORDER BY created_at DESC") as any[];
  return rows.map((r) => ({
    ...r,
    events: typeof r.events === "string" ? JSON.parse(r.events) : r.events,
    active: !!r.active,
  }));
}

/**
 * Delete a webhook.
 */
export function deleteWebhook(id: string): boolean {
  const existing = queryOne("SELECT id FROM webhooks WHERE id = ?", [id]);
  if (!existing) return false;
  runSql("DELETE FROM webhooks WHERE id = ?", [id]);
  return true;
}

/**
 * Toggle a webhook active/inactive.
 */
export function toggleWebhook(id: string, active: boolean): boolean {
  const existing = queryOne("SELECT id FROM webhooks WHERE id = ?", [id]);
  if (!existing) return false;
  runSql("UPDATE webhooks SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
  return true;
}
