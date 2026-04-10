# Milestone 3: Generalization to a Full Context Runtime

## What this milestone proves

That the engine works for any type of task, not just travel planning. The same core (storage, extraction, conflict resolution, compilation) handles coding, writing, research, health, finance, and anything else.

## What was built

### M3-1: MCP Server

RecallOS now runs as an MCP server that any compatible AI tool (Claude Desktop, Cursor, VS Code, etc.) can connect to. The server exposes:

- **9 tools**: search_memory, get_context, get_context_packet, record_memory, add_memory, list_memory, list_trips, delete_memory
- **6 resources**: memory://items, memory://preferences, memory://constraints, memory://overrides, memory://trips, memory://trips/{id}
- **3 prompts**: with_my_context, trip_planning, memory_summary

The MCP server runs as a stdio process that shares the same SQLite database as the main backend. No HTTP overhead.

### M3-2: Multi-domain memory extraction

The extraction pipeline now recognizes patterns across 8 domains:

- **Travel**: trips, flights, hotels, destinations, visa, luggage
- **Coding**: languages, frameworks, tools, IDEs, databases, deployment
- **Work**: meetings, projects, deadlines, teams, presentations
- **Health**: allergies, diet, medications, exercise, conditions
- **Finance**: budgets, salary, investments, expenses, loans
- **Learning**: courses, exams, certifications, training
- **Writing**: tone, style, voice, grammar preferences
- **Communication**: timezone, availability, schedule

Each extracted memory candidate is tagged with its detected domain.

### M3-3: Domain-agnostic context compilation with recency decay

The context compiler now:

- Detects all relevant domains from both the message and the included memory items
- Reports the primary domain and all secondary domains
- Applies a recency boost with a 7-day half-life so newer memories rank higher
- Uses a combined score: BM25 + recency boost

The trace table in the Context Debug page shows BM25, Recency, and Final Score for every memory item considered.

### M3-4: Hierarchical memory scoping

Memory scope expanded from 2 levels (global, trip) to 5:

| Scope | Precedence | Use case |
|-------|-----------|----------|
| global | Lowest | Applies everywhere ("I prefer dark mode") |
| domain | Low | Applies to a domain ("In coding, I use TypeScript") |
| trip | Medium | Applies to a specific trip/journey |
| project | Medium | Applies to a specific project or codebase |
| session | Highest | Applies only to the current conversation |

Narrower scopes override broader ones. The schema migration is automatic - existing databases are upgraded transparently.

### M3-5: Memory relationships and cross-domain links

Memory items can now be linked to each other with typed relationships:

- **related_to**: general association
- **depends_on**: one item requires another
- **conflicts_with**: items that contradict each other
- **refines**: one item adds detail to another
- **derived_from**: one item was extracted from another

Links have configurable strength (0.0 to 1.0). The context compiler traverses links from high-scoring "anchor" items and boosts related items, enabling cross-domain context. For example, linking a work schedule fact to a travel preference lets the compiler include the schedule when planning a trip.

REST API endpoints for link CRUD: GET/POST `/:id/links`, DELETE `/links/:linkId`.

### M3-6: Multi-domain entity extraction

The entity extractor now recognizes:

- **Dates**: ISO, month-day, relative ("tomorrow", "next week", "in 3 days")
- **Destinations**: 300+ cities and countries
- **Amounts**: Multi-currency ($, EUR, GBP, JPY, INR, etc.) with k/m multipliers
- **Durations**: "3 days", "two weeks", "a month"
- **Technologies**: 60+ frameworks, databases, cloud platforms, tools (React, PostgreSQL, AWS, Docker, etc.)
- **Programming languages**: TypeScript, Python, Rust, Go, Java, etc.

### M3-7: Dashboard improvements

The Memory page now shows:

- Domain column with color-coded badges
- Scope filter expanded to all 5 levels
- Color-coded scope badges
- Domain stats breakdown row
- Updated search placeholder for multi-domain use

## Architecture after M3

```
User --> Any MCP Client (Claude Desktop, Cursor, VS Code)
           |
           v
    RecallOS MCP Server (stdio)
           |
           v
    SQLite Database (recallos.db)
           |
    +------+------+------+------+
    |      |      |      |      |
  Extract  Reconcile  Compile  Rank
  (multi-  (5-level   (multi-  (BM25 +
  domain)  scope)     domain)  recency)
```

## What changed from M1/M2

| Feature | M1/M2 | M3 |
|---------|-------|-----|
| Domains | Travel only | 8 domains (travel, coding, work, health, finance, learning, writing, communication) |
| Scopes | global, trip | global, domain, trip, project, session |
| Ranking | BM25 only | BM25 + recency decay + link boost |
| Entities | Dates, destinations, amounts, durations | + 60 technologies, programming languages |
| Interface | REST API, CLI, Docker | + MCP server for any AI tool |
| Memory links | None | 5 relation types with strength |
| Domain detection | "travel" or "general" | Multi-domain scoring from message and memory |
