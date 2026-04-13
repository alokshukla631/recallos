#!/usr/bin/env node
import { Command } from "commander";
import { get, post, del, fetchRaw } from "./api.js";
import fs from "fs";

const program = new Command();

program
  .name("recallos")
  .description("RecallOS CLI - manage memory, trips, and chat from the terminal")
  .version("0.1.0");

// ── Health ──────────────────────────────────────────────────────────────────

program
  .command("health")
  .description("Check if the RecallOS backend is running")
  .action(async () => {
    try {
      const data = await get("/health");
      console.log("Backend is running:", data.status);
    } catch {
      console.error("Backend is not reachable at", process.env.RECALLOS_API || "http://localhost:3001");
      process.exit(1);
    }
  });

// ── Memory ──────────────────────────────────────────────────────────────────

const memory = program.command("memory").description("Manage memory items");

memory
  .command("list")
  .description("List active memory items")
  .option("-s, --status <status>", "Filter by status (active, stale, superseded, all)", "active")
  .option("-t, --type <type>", "Filter by type (preference, constraint, fact, goal, override)")
  .option("--scope <scope>", "Filter by scope (global, trip)")
  .action(async (opts) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.type) params.set("type", opts.type);
    if (opts.scope) params.set("scope", opts.scope);
    const items = await get(`/api/memory?${params}`);
    if (items.length === 0) {
      console.log("No memory items found.");
      return;
    }
    console.log(`\n  ${items.length} memory items:\n`);
    for (const item of items) {
      const conf = Math.round((item.confidence ?? 0) * 100);
      console.log(`  [${item.type}] ${item.key}`);
      console.log(`    ${item.value}`);
      console.log(`    scope=${item.scope}  confidence=${conf}%  status=${item.status}`);
      console.log();
    }
  });

memory
  .command("create <key> <value>")
  .description("Create a memory item directly")
  .option("-t, --type <type>", "Type: fact, preference, constraint, goal, override", "fact")
  .option("-s, --scope <scope>", "Scope: global, domain, project, trip, session", "global")
  .option("-d, --domain <domain>", "Domain (e.g. travel, coding, health)")
  .action(async (key, value, opts) => {
    const body: any = { key, value, type: opts.type, scope: opts.scope };
    if (opts.domain) body.domain = opts.domain;
    const item = await post("/api/memory", body);
    console.log(`Created: [${item.type}] ${item.key}`);
    console.log(`  ${item.value}`);
    console.log(`  id=${item.id}  scope=${item.scope}  confidence=${Math.round(item.confidence * 100)}%`);
  });

memory
  .command("search <query>")
  .description("Search memory items using BM25 full-text search")
  .action(async (query) => {
    const items = await get(`/api/memory/search?q=${encodeURIComponent(query)}`);
    if (items.length === 0) {
      console.log("No results found.");
      return;
    }
    console.log(`\n  ${items.length} results for "${query}":\n`);
    for (const item of items) {
      const score = item.search_score?.toFixed(3) ?? "?";
      console.log(`  [${item.type}] ${item.key}  (score: ${score})`);
      console.log(`    ${item.value}`);
      console.log();
    }
  });

memory
  .command("delete <id>")
  .description("Mark a memory item as stale (soft delete)")
  .action(async (id) => {
    await del(`/api/memory/${id}`);
    console.log("Memory item marked as stale.");
  });

memory
  .command("audit")
  .description("Show recent memory audit log")
  .option("-n, --limit <n>", "Number of entries to show", "20")
  .action(async (opts) => {
    const entries = await get(`/api/memory/audit/recent?limit=${opts.limit}`);
    if (entries.length === 0) {
      console.log("No audit entries.");
      return;
    }
    console.log(`\n  Recent audit log (${entries.length} entries):\n`);
    for (const entry of entries) {
      const time = new Date(entry.created_at).toLocaleString();
      const key = entry.memory_key ?? entry.memory_item_id?.slice(0, 8);
      console.log(`  ${time}  [${entry.action}]  ${key}`);
      if (entry.details) console.log(`    ${entry.details}`);
    }
  });

memory
  .command("tags")
  .description("List all tags in use")
  .action(async () => {
    const tags = await get("/api/memory/tags");
    if (tags.length === 0) {
      console.log("No tags in use.");
      return;
    }
    console.log("\n  Tags:\n");
    for (const t of tags) {
      console.log(`  ${t.tag} (${t.count} items)`);
    }
  });

memory
  .command("bulk <file>")
  .description("Bulk import memory from a file (one statement per line)")
  .option("-t, --trip <id>", "Scope all imported memory to a trip")
  .action(async (file, opts) => {
    const content = fs.readFileSync(file, "utf-8");
    const statements = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 5);
    if (statements.length === 0) {
      console.log("No valid statements found in file.");
      return;
    }
    console.log(`Importing ${statements.length} statements...`);
    const body: any = { statements };
    if (opts.trip) body.trip_id = opts.trip;
    const result = await post("/api/memory/bulk", body);
    console.log(`Done: ${result.extracted} extracted, ${result.added} added, ${result.duplicates} duplicates`);
  });

memory
  .command("pin <id>")
  .description("Pin a memory item (always included in context)")
  .action(async (id) => {
    await post(`/api/memory/${id}/pin`, {});
    console.log("Memory item pinned. It will always be included in context.");
  });

memory
  .command("unpin <id>")
  .description("Unpin a memory item")
  .action(async (id) => {
    await post(`/api/memory/${id}/unpin`, {});
    console.log("Memory item unpinned.");
  });

memory
  .command("reconfirm <id>")
  .description("Reconfirm a memory item as still valid")
  .action(async (id) => {
    const result = await post(`/api/memory/${id}/reconfirm`, {});
    console.log(`Reconfirmed. Last confirmed: ${result.last_confirmed_at}`);
  });

memory
  .command("decay")
  .description("Preview or apply memory decay (mark stale items)")
  .option("--apply", "Actually mark items as stale (default: preview only)")
  .option("--max-age <days>", "Max age in days for unconfirmed items")
  .option("--max-stale <days>", "Max days since last confirmation")
  .option("--min-importance <score>", "Minimum importance score to keep")
  .action(async (opts) => {
    if (opts.apply) {
      const body: any = {};
      if (opts.maxAge) body.max_age_days = parseInt(opts.maxAge);
      if (opts.maxStale) body.max_stale_days = parseInt(opts.maxStale);
      if (opts.minImportance) body.min_importance = parseInt(opts.minImportance);
      const result = await post("/api/memory/decay", body);
      console.log(`Marked ${result.marked} items as stale.`);
      for (const item of result.items || []) {
        console.log(`  [${item.type}] ${item.key} (importance: ${item.importance}) - ${item.reason}`);
      }
    } else {
      const params = new URLSearchParams();
      if (opts.maxAge) params.set("max_age_days", opts.maxAge);
      if (opts.maxStale) params.set("max_stale_days", opts.maxStale);
      if (opts.minImportance) params.set("min_importance", opts.minImportance);
      const result = await get(`/api/memory/decay?${params}`);
      if (result.count === 0) {
        console.log("No stale items found. Memory is healthy.");
        return;
      }
      console.log(`\n  ${result.count} items would be marked stale:\n`);
      for (const item of result.candidates) {
        console.log(`  [${item.type}] ${item.key} (importance: ${item.importance})`);
        console.log(`    Reason: ${item.reason}`);
        console.log();
      }
      console.log("  Run with --apply to mark them stale.");
    }
  });

memory
  .command("importance")
  .description("Show memory items ranked by importance score")
  .option("-n, --limit <n>", "Number of items to show", "10")
  .action(async (opts) => {
    const items = await get(`/api/memory/importance?limit=${opts.limit}`);
    if (items.length === 0) {
      console.log("No active memory items.");
      return;
    }
    console.log(`\n  Top ${items.length} by importance:\n`);
    for (const item of items) {
      console.log(`  ${item.importance.toString().padStart(3)} | ${item.key}: ${item.value.slice(0, 60)}`);
    }
  });

memory
  .command("duplicates")
  .description("Find likely duplicate memory items")
  .option("--threshold <n>", "Similarity threshold 0-1 (default: 0.6)", "0.6")
  .action(async (opts) => {
    const result = await get(`/api/memory/duplicates?threshold=${opts.threshold}`);
    if (result.count === 0) {
      console.log("No duplicates found.");
      return;
    }
    console.log(`\n  ${result.count} duplicate groups found:\n`);
    for (const group of result.groups) {
      console.log(`  [${group.type}] ${group.key} (${Math.round(group.similarity * 100)}% similar)`);
      console.log(`    ${group.reason}`);
      for (const item of group.items) {
        console.log(`    - ${item.value.slice(0, 60)} (${item.scope}, conf: ${Math.round(item.confidence * 100)}%)`);
      }
      console.log();
    }
  });

memory
  .command("conflicts")
  .description("List pending memory conflicts")
  .option("-s, --status <status>", "Filter: pending, all", "pending")
  .action(async (opts) => {
    const result = await get(`/api/memory/conflicts?status=${opts.status}`);
    if (result.conflicts.length === 0) {
      console.log("No conflicts found.");
      return;
    }
    console.log(`\n  ${result.pending_count} pending conflict${result.pending_count !== 1 ? "s" : ""}:\n`);
    for (const c of result.conflicts) {
      console.log(`  [${c.status}] ${c.key}`);
      console.log(`    Old: ${c.existing_value.slice(0, 80)}`);
      console.log(`    New: ${c.new_value.slice(0, 80)}`);
      console.log(`    ID: ${c.id}\n`);
    }
  });

memory
  .command("resolve <conflictId> <resolution>")
  .description("Resolve a conflict: keep_new, keep_old, or merged")
  .option("-v, --value <value>", "Merged value (required for 'merged' resolution)")
  .action(async (conflictId, resolution, opts) => {
    if (!["keep_new", "keep_old", "merged"].includes(resolution)) {
      console.error("Resolution must be: keep_new, keep_old, or merged");
      process.exit(1);
    }
    const body: Record<string, string> = { resolution };
    if (opts.value) body.merged_value = opts.value;
    const result = await post(`/api/memory/conflicts/${conflictId}/resolve`, body);
    console.log(`Conflict resolved: ${result.resolution}`);
  });

memory
  .command("inspect <id>")
  .description("Show full detail for a memory item (importance, tags, links, audit)")
  .action(async (id) => {
    const detail = await get(`/api/memory/${id}/detail`);
    console.log(`\n  ${detail.key}`);
    console.log(`  ${"=".repeat(detail.key.length)}`);
    console.log(`  Type: ${detail.type}  |  Scope: ${detail.scope}  |  Status: ${detail.status}`);
    if (detail.domain) console.log(`  Domain: ${detail.domain}`);
    console.log(`  Pinned: ${detail.pinned ? "yes" : "no"}  |  Confidence: ${Math.round(detail.confidence * 100)}%`);
    console.log(`\n  Value:\n    ${detail.value}`);
    console.log(`\n  Importance: ${detail.importance.total}/100`);
    console.log(`    Confidence: ${detail.importance.confidence_score}/30`);
    console.log(`    Recency: ${detail.importance.recency_score}/25`);
    console.log(`    Links: ${detail.importance.link_score}/20`);
    console.log(`    Tags: ${detail.importance.tag_score}/15`);
    console.log(`    Age bonus: ${detail.importance.age_bonus}/10`);
    if (detail.tags.length > 0) {
      console.log(`\n  Tags: ${detail.tags.map((t: any) => t.tag).join(", ")}`);
    }
    if (detail.links.length > 0) {
      console.log(`\n  Links (${detail.links.length}):`);
      for (const link of detail.links) {
        const target = link.source_id === id ? link.target_id : link.source_id;
        console.log(`    ${link.relation} -> ${target.slice(0, 8)}${link.note ? ` (${link.note})` : ""}`);
      }
    }
    console.log(`\n  Context appearances: ${detail.context_appearances}`);
    console.log(`  Created: ${new Date(detail.created_at).toLocaleString()}`);
    if (detail.last_confirmed_at) {
      console.log(`  Last confirmed: ${new Date(detail.last_confirmed_at).toLocaleString()}`);
    }
    if (detail.audit.length > 0) {
      console.log(`\n  Audit history (${detail.audit.length}):`);
      for (const entry of detail.audit.slice(0, 10)) {
        const time = new Date(entry.created_at).toLocaleString();
        console.log(`    ${time}  [${entry.action}]  ${entry.details || ""}`);
      }
    }
    if (detail.superseded_by_item) {
      console.log(`\n  Superseded by: ${detail.superseded_by_item.key} (${detail.superseded_by_item.id.slice(0, 8)})`);
    }
    if (detail.supersedes.length > 0) {
      console.log(`\n  Supersedes:`);
      for (const s of detail.supersedes) {
        console.log(`    ${s.key} (${s.id.slice(0, 8)})`);
      }
    }
    console.log();
  });

memory
  .command("batch <action>")
  .description("Batch operations: pin, unpin, delete, reconfirm")
  .argument("<ids...>", "Memory item IDs")
  .action(async (action, ids) => {
    if (!["pin", "unpin", "delete", "reconfirm"].includes(action)) {
      console.error("Action must be one of: pin, unpin, delete, reconfirm");
      process.exit(1);
    }
    const result = await post("/api/memory/batch", { ids, action });
    console.log(`${action}: ${result.affected} of ${result.total_requested} items affected.`);
  });

memory
  .command("import <file>")
  .description("Import memory items from a JSON file")
  .action(async (file) => {
    try {
      const text = fs.readFileSync(file, "utf-8");
      const data = JSON.parse(text);
      const items = Array.isArray(data) ? data : data.items || [data];
      const result = await post("/api/memory/import", { items });
      console.log(`Imported: ${result.imported} items`);
      if (result.skipped > 0) console.log(`Skipped: ${result.skipped}`);
      if (result.errors && result.errors.length > 0) {
        console.log("Errors:");
        for (const err of result.errors) console.log(`  - ${err}`);
      }
    } catch (err: any) {
      console.error("Import failed:", err.message || err);
      process.exit(1);
    }
  });

memory
  .command("export [file]")
  .description("Export all active memory items to JSON")
  .option("-s, --status <status>", "Filter by status", "active")
  .action(async (file, opts) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    const items = await get(`/api/memory?${params}`);
    const json = JSON.stringify(items, null, 2);
    if (file) {
      fs.writeFileSync(file, json, "utf-8");
      console.log(`Exported ${items.length} items to ${file}`);
    } else {
      console.log(json);
    }
  });

// ── Trips ───────────────────────────────────────────────────────────────────

const trips = program.command("trips").description("Manage trips");

trips
  .command("list")
  .description("List all trips")
  .action(async () => {
    const list = await get("/api/trips");
    if (list.length === 0) {
      console.log("No trips.");
      return;
    }
    console.log(`\n  ${list.length} trips:\n`);
    for (const t of list) {
      const dates = [t.start_date, t.end_date].filter(Boolean).join(" to ") || "no dates";
      console.log(`  ${t.name}  [${t.status}]`);
      if (t.destination) console.log(`    Destination: ${t.destination}`);
      console.log(`    ${dates}`);
      console.log(`    Conversations: ${t.conversation_count ?? 0}  Memories: ${t.memory_count ?? 0}`);
      console.log();
    }
  });

trips
  .command("create <name>")
  .description("Create a new trip")
  .option("-d, --destination <dest>", "Destination")
  .option("--start <date>", "Start date (YYYY-MM-DD)")
  .option("--end <date>", "End date (YYYY-MM-DD)")
  .action(async (name, opts) => {
    const trip = await post("/api/trips", {
      name,
      destination: opts.destination,
      start_date: opts.start,
      end_date: opts.end,
    });
    console.log(`Trip created: ${trip.name} (${trip.id})`);
  });

trips
  .command("delete <id>")
  .description("Delete a trip")
  .action(async (id) => {
    await del(`/api/trips/${id}`);
    console.log("Trip deleted.");
  });

// ── Passport ────────────────────────────────────────────────────────────────

const passport = program.command("passport").description("Export or import memory passport");

passport
  .command("export [file]")
  .description("Export memory to a JSON passport file")
  .action(async (file) => {
    const res = await fetchRaw("/api/passport/export");
    if (!res.ok) throw new Error("Export failed");
    const data = await res.json();
    const outPath = file || `recallos-passport-${new Date().toISOString().slice(0, 10)}.json`;
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`Exported ${data.stats.memory_items} memories, ${data.stats.trips} trips to ${outPath}`);
  });

passport
  .command("export-md [file]")
  .description("Export memory as a human-readable Markdown file")
  .action(async (file) => {
    const res = await fetchRaw("/api/passport/export/markdown");
    if (!res.ok) throw new Error("Export failed");
    const md = await res.text();
    const outPath = file || `recallos-memory-${new Date().toISOString().slice(0, 10)}.md`;
    fs.writeFileSync(outPath, md);
    console.log(`Exported memory to ${outPath}`);
  });

passport
  .command("import <file>")
  .description("Import memory from a JSON passport file")
  .action(async (file) => {
    const content = fs.readFileSync(file, "utf-8");
    const passport = JSON.parse(content);
    const result = await post("/api/passport/import", passport);
    console.log(`Import complete:`);
    console.log(`  Memories: ${result.memories_created} created, ${result.memories_skipped} skipped`);
    console.log(`  Trips: ${result.trips_created} created, ${result.trips_skipped} skipped`);
  });

// ── Providers ───────────────────────────────────────────────────────────────

const providers = program.command("providers").description("Manage AI providers");

providers
  .command("list")
  .description("List configured providers")
  .action(async () => {
    const list = await get("/api/settings/providers");
    if (list.length === 0) {
      console.log("No providers configured. Add one with: recallos providers add <name> <api-key>");
      return;
    }
    for (const p of list) {
      const def = p.is_default ? " (default)" : "";
      console.log(`  ${p.provider}${def}`);
    }
  });

// ── MCP ────────────────────────────────────────────────────────────────────

const mcp = program.command("mcp").description("MCP server configuration");

mcp
  .command("config")
  .description("Show the MCP config entry to paste into Claude Desktop")
  .action(async () => {
    const data = await get("/api/settings/mcp/config");
    console.log("\n  MCP config entry for Claude Desktop:\n");
    console.log(`  Config path: ${data.claude_desktop_config_path || "unknown"}\n`);
    console.log("  Add this under \"mcpServers\" in your config:\n");
    console.log(`  "recallos": ${JSON.stringify(data.config, null, 4)}`);
    console.log("\n  Or run: recallos mcp install\n");
  });

mcp
  .command("install")
  .description("Auto-install the MCP config into Claude Desktop")
  .action(async () => {
    const result = await post("/api/settings/mcp/install", {});
    if (result.installed) {
      console.log(`MCP config installed at: ${result.config_path}`);
      console.log("Restart Claude Desktop to connect.");
    } else {
      console.error("Failed to install MCP config.");
    }
  });

// ── Scraper ────────────────────────────────────────────────────────────────

const scraper = program.command("scraper").description("Scrape chat logs from local AI tools");

scraper
  .command("sources")
  .description("List available log sources and their status")
  .action(async () => {
    const sources = await get("/api/scraper/sources");
    for (const s of sources) {
      const status = s.available ? "available" : "not found";
      const scraped = s.lastScraped ? `last scraped: ${new Date(s.lastScraped).toLocaleString()}` : "never scraped";
      console.log(`  ${s.name}: ${status} (${scraped})`);
      if (s.path) console.log(`    path: ${s.path}`);
    }
  });

scraper
  .command("run")
  .description("Scrape all available sources for new conversations")
  .action(async () => {
    console.log("Scraping local AI tool logs...");
    const data = await post("/api/scraper/run", {});
    console.log(`Scraped at: ${data.scraped_at}\n`);
    for (const r of data.results) {
      console.log(`  ${r.source}:`);
      console.log(`    Messages found: ${r.messagesFound}`);
      console.log(`    New messages: ${r.messagesNew}`);
      console.log(`    Memory extracted: ${r.memoryExtracted}`);
      if (r.errors.length > 0) {
        console.log(`    Errors: ${r.errors.join(", ")}`);
      }
    }
  });

// ── Session ────────────────────────────────────────────────────────────────

const session = program.command("session").description("Manage session-scoped memory");

session
  .command("stats")
  .description("Show session memory stats (active, stale, oldest)")
  .action(async () => {
    const stats = await get("/api/memory/session/stats");
    console.log(`\n  Session memory stats:\n`);
    console.log(`  Active:  ${stats.active}`);
    console.log(`  Stale:   ${stats.stale}`);
    if (stats.oldest_active) {
      console.log(`  Oldest:  ${new Date(stats.oldest_active).toLocaleString()}`);
    } else {
      console.log(`  Oldest:  none`);
    }
  });

session
  .command("cleanup")
  .description("Expire session memory items older than TTL")
  .option("--ttl <hours>", "Time-to-live in hours (default: 24)", "24")
  .action(async (opts) => {
    const result = await post("/api/memory/session/cleanup", { ttl_hours: opts.ttl });
    console.log(`Expired ${result.expired_count} session items (TTL: ${result.ttl_hours}h)`);
  });

// ── Chat ────────────────────────────────────────────────────────────────────

program
  .command("chat <message>")
  .description("Send a single message and print the response")
  .option("-p, --provider <provider>", "Provider to use (openai, anthropic)")
  .option("-c, --conversation <id>", "Continue an existing conversation")
  .option("-t, --trip <id>", "Scope to a trip")
  .action(async (message, opts) => {
    let provider = opts.provider;
    if (!provider) {
      const provs = await get("/api/settings/providers");
      const def = provs.find((p: any) => p.is_default);
      provider = def?.provider ?? provs[0]?.provider;
      if (!provider) {
        console.error("No providers configured. Add one in Settings or use --provider.");
        process.exit(1);
      }
    }

    const body: any = { message, provider };
    if (opts.conversation) body.conversation_id = opts.conversation;
    if (opts.trip) body.trip_id = opts.trip;

    const data = await post("/api/chat", body);
    console.log(`\n${data.assistant_message?.content ?? "(no response)"}\n`);
    if (data.memory_extracted > 0) {
      console.log(`  Memory: ${data.memory_extracted} extracted, ${data.memory_reconciled?.added ?? 0} added, ${data.memory_reconciled?.duplicates ?? 0} re-confirmed`);
    }
    if (data.context) {
      console.log(`  Context: ${data.context.included_count} items included, ${data.context.omitted_count} omitted`);
    }
    console.log(`  Conversation: ${data.conversation_id}`);
  });

// ── Run ─────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
