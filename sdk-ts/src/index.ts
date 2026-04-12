/**
 * RecallOS TypeScript SDK
 *
 * Zero-dependency client for the RecallOS REST API.
 * Works in Node 18+, Deno, Bun, and modern browsers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryItem {
  id: string;
  key: string;
  type: string;
  value: string;
  scope: string;
  domain: string | null;
  confidence: number;
  status: string;
  trip_id: string | null;
  source_event_id: string | null;
  superseded_by: string | null;
  last_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Trip {
  id: string;
  name: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  memory_item_id: string;
  action: string;
  detail: string | null;
  created_at: string;
  memory_key?: string;
  memory_value?: string;
  memory_type?: string;
}

export interface ImportanceFactors {
  confidence_score: number;
  recency_score: number;
  link_score: number;
  tag_score: number;
  age_bonus: number;
  total: number;
}

export interface DecayCandidate {
  id: string;
  key: string;
  value: string;
  type: string;
  reason: string;
  importance: number;
  created_at: string;
  last_confirmed_at: string | null;
}

export interface DecayResult {
  marked: number;
  items: DecayCandidate[];
}

export interface CompareResult {
  snapshot_a: SnapshotSummary;
  snapshot_b: SnapshotSummary;
  diff: {
    added: MemoryItemSummary[];
    removed: MemoryItemSummary[];
    kept_count: number;
    total_changes: number;
  };
}

export interface SnapshotSummary {
  id: string;
  event_id: string;
  provider: string;
  created_at: string;
  included_count: number;
  omitted_count: number;
}

export interface MemoryItemSummary {
  id: string;
  key: string;
  type: string;
  value: string;
  scope: string;
  domain?: string;
}

export interface MemoryLink {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  strength: number;
  note: string | null;
  created_at: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  created_at: string;
}

export interface RecallOSOptions {
  baseUrl?: string;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class RecallOS {
  private baseUrl: string;
  private timeout: number;

  constructor(options: RecallOSOptions = {}) {
    this.baseUrl = (options.baseUrl || "http://localhost:3001").replace(/\/$/, "");
    this.timeout = options.timeout || 30000;
  }

  // -- Internal helpers -----------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    options: { params?: Record<string, string>; body?: unknown } = {}
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    if (options.params) {
      const qs = new URLSearchParams(options.params).toString();
      if (qs) url += `?${qs}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method,
        headers: options.body ? { "Content-Type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(
          (errBody as Record<string, string>).error || `HTTP ${res.status} ${res.statusText}`
        );
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return (await res.json()) as T;
      }
      return (await res.text()) as unknown as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body: body || {} });
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  private del<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  // -- Health ---------------------------------------------------------------

  /** Check if the backend is running. */
  health(): Promise<{ status: string }> {
    return this.get("/health");
  }

  // -- Memory ---------------------------------------------------------------

  /** List memory items with optional filters. */
  listMemory(filters?: {
    status?: string;
    type?: string;
    scope?: string;
    trip_id?: string;
  }): Promise<MemoryItem[]> {
    const params: Record<string, string> = {};
    if (filters?.status) params.status = filters.status;
    if (filters?.type) params.type = filters.type;
    if (filters?.scope) params.scope = filters.scope;
    if (filters?.trip_id) params.trip_id = filters.trip_id;
    return this.get("/api/memory", params);
  }

  /** Get a single memory item. */
  getMemory(id: string): Promise<MemoryItem> {
    return this.get(`/api/memory/${id}`);
  }

  /** Get comprehensive detail for a memory item (importance, tags, links, audit). */
  getMemoryDetail(id: string): Promise<MemoryItem & {
    importance: ImportanceFactors;
    tags: Array<{ tag: string }>;
    links: MemoryLink[];
    audit: AuditEntry[];
    superseded_by_item: { id: string; key: string; value: string } | null;
    supersedes: Array<{ id: string; key: string; value: string }>;
    context_appearances: number;
  }> {
    return this.get(`/api/memory/${id}/detail`);
  }

  /** Search memory using BM25 full-text ranking. */
  searchMemory(query: string): Promise<MemoryItem[]> {
    return this.get("/api/memory/search", { q: query });
  }

  /** Update a memory item (value, status, scope, etc). */
  updateMemory(id: string, fields: Partial<Pick<MemoryItem, "value" | "status" | "scope" | "confidence">>): Promise<MemoryItem> {
    return this.put(`/api/memory/${id}`, fields);
  }

  /** Soft-delete a memory item. */
  deleteMemory(id: string): Promise<{ message: string }> {
    return this.del(`/api/memory/${id}`);
  }

  /** Manually reconfirm a memory item as still valid. */
  reconfirm(id: string): Promise<{ message: string; last_confirmed_at: string }> {
    return this.post(`/api/memory/${id}/reconfirm`);
  }

  /** Merge two memory items. Source gets superseded, target keeps the result. */
  merge(sourceId: string, targetId: string, mergedValue?: string): Promise<{ message: string; target: MemoryItem }> {
    const body: Record<string, string> = { source_id: sourceId, target_id: targetId };
    if (mergedValue) body.merged_value = mergedValue;
    return this.post("/api/memory/merge", body);
  }

  // -- Importance -----------------------------------------------------------

  /** Get memory items ranked by importance score. */
  importanceRanking(limit = 20): Promise<Array<{ id: string; key: string; value: string; importance: number }>> {
    return this.get("/api/memory/importance", { limit: String(limit) });
  }

  /** Get the importance score breakdown for a single item. */
  importanceBreakdown(id: string): Promise<ImportanceFactors> {
    return this.get(`/api/memory/${id}/importance`);
  }

  // -- Decay ----------------------------------------------------------------

  /** Preview which items would be marked stale by decay rules. */
  decayPreview(config?: {
    maxAgeDays?: number;
    maxStaleDays?: number;
    minImportance?: number;
  }): Promise<{ count: number; candidates: DecayCandidate[] }> {
    const params: Record<string, string> = {};
    if (config?.maxAgeDays !== undefined) params.max_age_days = String(config.maxAgeDays);
    if (config?.maxStaleDays !== undefined) params.max_stale_days = String(config.maxStaleDays);
    if (config?.minImportance !== undefined) params.min_importance = String(config.minImportance);
    return this.get("/api/memory/decay", params);
  }

  /** Apply decay rules and mark stale items. */
  decayApply(config?: {
    maxAgeDays?: number;
    maxStaleDays?: number;
    minImportance?: number;
  }): Promise<DecayResult> {
    const body: Record<string, number> = {};
    if (config?.maxAgeDays !== undefined) body.max_age_days = config.maxAgeDays;
    if (config?.maxStaleDays !== undefined) body.max_stale_days = config.maxStaleDays;
    if (config?.minImportance !== undefined) body.min_importance = config.minImportance;
    return this.post("/api/memory/decay", body);
  }

  // -- Tags -----------------------------------------------------------------

  /** List all tags in use. */
  listTags(): Promise<Array<{ tag: string; count: number }>> {
    return this.get("/api/memory/tags");
  }

  /** Add a tag to a memory item. */
  addTag(memoryId: string, tag: string): Promise<string[]> {
    return this.post(`/api/memory/${memoryId}/tags`, { tag });
  }

  /** Remove a tag from a memory item. */
  removeTag(memoryId: string, tag: string): Promise<{ message: string }> {
    return this.del(`/api/memory/${memoryId}/tags/${encodeURIComponent(tag)}`);
  }

  // -- Links ----------------------------------------------------------------

  /** Get all links for a memory item. */
  getLinks(memoryId: string): Promise<MemoryLink[]> {
    return this.get(`/api/memory/${memoryId}/links`);
  }

  /** Create a link between two memory items. */
  createLink(
    sourceId: string,
    targetId: string,
    relation: string,
    strength = 1.0,
    note?: string
  ): Promise<MemoryLink> {
    const body: Record<string, unknown> = { target_id: targetId, relation, strength };
    if (note) body.note = note;
    return this.post(`/api/memory/${sourceId}/links`, body);
  }

  /** Remove a link. */
  deleteLink(linkId: string): Promise<{ message: string }> {
    return this.del(`/api/memory/links/${linkId}`);
  }

  // -- Graph ----------------------------------------------------------------

  /** Get graph data (nodes + edges) for memory visualization. */
  graph(): Promise<{
    nodes: Array<{
      id: string;
      key: string;
      type: string;
      value: string;
      scope: string;
      domain: string | null;
      pinned: boolean;
      importance: number;
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      relation: string;
      strength: number;
    }>;
    stats: { node_count: number; edge_count: number; implicit_edge_count: number };
  }> {
    return this.get("/api/memory/graph");
  }

  // -- Stats ----------------------------------------------------------------

  /** Get full memory statistics. */
  memoryStats(): Promise<Record<string, unknown>> {
    return this.get("/api/memory/stats");
  }

  /** Get memory retention analytics (weekly survival rates). */
  retentionStats(): Promise<Record<string, unknown>> {
    return this.get("/api/memory/stats/retention");
  }

  // -- Audit ----------------------------------------------------------------

  /** Get recent audit log entries. */
  auditLog(limit = 20): Promise<AuditEntry[]> {
    return this.get("/api/memory/audit/recent", { limit: String(limit) });
  }

  /** Get audit log for a specific memory item. */
  auditForItem(memoryId: string): Promise<AuditEntry[]> {
    return this.get(`/api/memory/audit/${memoryId}`);
  }

  // -- Bulk import ----------------------------------------------------------

  /** Import memory from a list of natural-language statements. */
  bulkImport(statements: string[], tripId?: string): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { statements };
    if (tripId) body.trip_id = tripId;
    return this.post("/api/memory/bulk", body);
  }

  // -- Session cleanup ------------------------------------------------------

  /** Get session memory stats. */
  sessionStats(): Promise<Record<string, unknown>> {
    return this.get("/api/memory/session/stats");
  }

  /** Expire old session memory items. */
  sessionCleanup(ttlHours = 24): Promise<{ expired_count: number; ttl_hours: number }> {
    return this.post("/api/memory/session/cleanup", { ttl_hours: ttlHours });
  }

  // -- Context snapshots ----------------------------------------------------

  /** List context compilation snapshots. */
  listSnapshots(eventId?: string): Promise<Record<string, unknown>[]> {
    const params: Record<string, string> = {};
    if (eventId) params.event_id = eventId;
    return this.get("/api/context/snapshots", params);
  }

  /** Get a specific snapshot with parsed JSON fields. */
  getSnapshot(id: string): Promise<Record<string, unknown>> {
    return this.get(`/api/context/snapshots/${id}`);
  }

  /** Compare two context compilation snapshots. */
  compareSnapshots(snapshotA: string, snapshotB: string): Promise<CompareResult> {
    return this.get("/api/context/snapshots/compare", { a: snapshotA, b: snapshotB });
  }

  /** Run the pipeline without calling a provider, return timing. */
  benchmark(message: string, tripId?: string): Promise<Record<string, unknown>> {
    const body: Record<string, string> = { message };
    if (tripId) body.trip_id = tripId;
    return this.post("/api/context/benchmark", body);
  }

  // -- Chat -----------------------------------------------------------------

  /** Send a chat message through the full pipeline (non-streaming). */
  chat(
    message: string,
    provider: string,
    conversationId?: string,
    tripId?: string
  ): Promise<Record<string, unknown>> {
    const body: Record<string, string> = { message, provider };
    if (conversationId) body.conversation_id = conversationId;
    if (tripId) body.trip_id = tripId;
    return this.post("/api/chat", body);
  }

  /** List all conversations. */
  listConversations(): Promise<Record<string, unknown>[]> {
    return this.get("/api/chat/conversations");
  }

  /** Delete a conversation. */
  deleteConversation(id: string): Promise<{ message: string }> {
    return this.del(`/api/chat/conversations/${id}`);
  }

  // -- Trips ----------------------------------------------------------------

  /** List all trips. */
  listTrips(): Promise<Trip[]> {
    return this.get("/api/trips");
  }

  /** Create a new trip. */
  createTrip(
    name: string,
    destination?: string,
    startDate?: string,
    endDate?: string
  ): Promise<Trip> {
    const body: Record<string, string> = { name };
    if (destination) body.destination = destination;
    if (startDate) body.start_date = startDate;
    if (endDate) body.end_date = endDate;
    return this.post("/api/trips", body);
  }

  /** Delete a trip. */
  deleteTrip(id: string): Promise<{ message: string }> {
    return this.del(`/api/trips/${id}`);
  }

  // -- Passport -------------------------------------------------------------

  /** Export all memory and trips as a portable JSON passport. */
  exportPassport(): Promise<Record<string, unknown>> {
    return this.get("/api/passport/export");
  }

  /** Import memory and trips from a passport JSON. */
  importPassport(passport: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("/api/passport/import", passport);
  }

  /** Export memory as human-readable Markdown. */
  exportPassportMarkdown(): Promise<string> {
    return this.get("/api/passport/export/markdown");
  }

  // -- Webhooks -------------------------------------------------------------

  /** List all configured webhooks. */
  listWebhooks(): Promise<Webhook[]> {
    return this.get("/api/settings/webhooks");
  }

  /** Register a new webhook. */
  addWebhook(url: string, events: string[] = ["*"]): Promise<Webhook> {
    return this.post("/api/settings/webhooks", { url, events });
  }

  /** Delete a webhook. */
  deleteWebhook(id: string): Promise<{ message: string }> {
    return this.del(`/api/settings/webhooks/${id}`);
  }

  // -- Scraper --------------------------------------------------------------

  /** List available log sources and their status. */
  scraperSources(): Promise<Record<string, unknown>[]> {
    return this.get("/api/scraper/sources");
  }

  /** Run the scraper on all available sources. */
  scraperRun(): Promise<Record<string, unknown>> {
    return this.post("/api/scraper/run");
  }

  // -- Settings -------------------------------------------------------------

  /** List configured providers. */
  listProviders(): Promise<Array<{ provider: string; is_default: boolean }>> {
    return this.get("/api/settings/providers");
  }

  /** Get MCP server config. */
  mcpConfig(): Promise<Record<string, unknown>> {
    return this.get("/api/settings/mcp/config");
  }
}

export default RecallOS;
