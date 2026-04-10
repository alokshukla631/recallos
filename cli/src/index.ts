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
