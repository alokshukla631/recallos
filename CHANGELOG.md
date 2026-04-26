# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and this project
follows [Semantic Versioning](https://semver.org/) where practical.

## [0.2.0] - 2026-04-25

This release is mostly about the retriever. RecallOS now reaches **0.978 R@5
on LongMemEval-s** (500-question full set) with zero tuning carried over from
training data — and **0.777 session-level R@5 on LoCoMo** out of the box for
cross-benchmark generalization.

### Added

#### Retrieval

- **Hybrid 5-signal retriever**: BM25 + temporal + preference + role + semantic
  scores combined per-event. See
  [`docs/07-retrieval-technique.md`](docs/07-retrieval-technique.md) for the
  full writeup including signal weights and interaction terms.
- **Local semantic embeddings** via `@xenova/transformers` (MiniLM-L6, 384-dim).
  No external API calls; batched encoding with a configurable per-call cap for
  memory safety on small machines.
- **Session-level ranking** using max-plus-discounted-rest aggregation over a
  session's top events instead of flat top-3 sum. Lifts session-level R@5 on
  LongMemEval-s without hurting turn-level numbers.
- **BM25-gated temporal boost**: temporal signal only fires when BM25 confirms
  topical overlap. Stops "yesterday I cooked pasta" from outranking the
  on-topic event from three weeks ago.
- **Preference query expansion** across 10+ anchor domains (music, food,
  cooking, gardening, exercise, travel, reading, work, hobbies, pets) with
  word-boundary-safe plural handling.
- **Role-aware reranking** for question-word destoplisting (who/what/when/etc.
  no longer dilute the BM25 signal in short queries).

#### Benchmarks

- **LongMemEval-s runner** (`backend/src/bench/longmemeval.ts`) with the
  official 500-question dataset. Result: **R@5 = 0.978** vs the published
  MemPalace baseline of 0.966.
- **LoCoMo runner** (`backend/src/bench/locomo.ts`) for cross-benchmark
  generalization. Result: **0.777 session-level / 0.518 turn-level R@5**, with
  zero LoCoMo-specific tuning.
- **End-to-end QA scoring** via an Anthropic Sonnet judge (`--qa` flag).
  Result: **0.900 accuracy** on 50 single-session-user questions.
- **Ablation harness** (`backend/src/bench/ablation.ts`) with a
  `DISABLE_SIGNALS` env var read at module load. Stratified 60-question
  ablation results checked into the technique note.
- **Regression guard** (`backend/src/bench/regression-guard.ts`) pinning the
  ranks of 13 hand-picked canary questions across all 6 LongMemEval categories.
  Runs in ≈5 minutes; suitable for pre-merge CI.
- **`--stratified` flag** on the LongMemEval and ablation runners for
  category-balanced sampling (`floor(LIMIT / numCategories)` per category).
- **`--ids <list>`** for targeted regression replay of specific question IDs.
- **`--start N`** flag plus `run-chunks.sh` helper for memory-safe chunked
  runs over the full 500-question set.
- **Per-question try/catch + periodic flush** so a single failure doesn't lose
  the run; line-buffered progress for tailable logs.
- **Provider key auto-load** from `recallos.db.provider_settings` for `--qa`
  judge runs (`backend/src/bench/load-provider-env.ts`).
- **`bench:guard` script** wired into `bench:all` for one-command verification.

#### Project

- **`LICENSE`** file (MIT). The README claimed "free, open-source" without
  one before this release.
- **`docs/07-retrieval-technique.md`** — full technique writeup covering the
  5 signals, 4 interaction terms, and stratified ablation table.

### Changed

- **Preference vocabulary** broadened across 6 additional domains; plural
  word-boundary matches fixed (caught a class of expansion misses found via
  per-question rank diffs).
- **Temporal classifier** now covers LongMemEval-style markers including
  "N days/weeks/months ago", "last <dayname>", and "past month".
- **Webhook ordering** is now deterministic under same-millisecond
  registration (previously flaky on 2 e2e tests).
- **Versions bumped to 0.2.0** across root, `backend`, `frontend`, `cli`,
  `sdk-ts`, and `sdk-python`.

### Fixed

- **Gardening anchor** narrowed to drop generic cooking verbs that were
  pulling unrelated "I cooked X" events into preference queries.
- **Embeddings batching** memory blow-up on small machines, via a
  configurable per-call cap.

### Tooling

- **Module-level test coverage** added for passport, suggestions, perf, and
  webhooks.
- **End-to-end pipeline tests** including adversarial scenarios.
- **LME judge parser unit tests** (14 offline tests) for the QA scoring path.
- **`analyze-jsonl`** and **`diff-jsonl`** helpers for post-hoc LongMemEval
  aggregation and per-question rank-diff inspection.

## [0.1.0] - 2026-02

Initial public release.

- Local-first chat app with memory and context compilation
- BM25 ranking for memory retrieval
- Conversation titles, sidebar, history browsing
- Trip management (CRUD)
- Duplicate detection and re-confirm
- Entity extraction (dates, destinations, amounts, durations)
- SSE streaming chat responses
- Memory Passport: portable JSON export/import
- Memory audit log
- Context Debug page with compilation trace
- Full-text BM25 search on memory page
- User-defined tags
- CLI (`recallos-cli`): memory, trips, passport, chat, providers
- One-command desktop runner for Windows and Mac/Linux

[0.2.0]: https://github.com/alokshukla631/recallos/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alokshukla631/recallos/releases/tag/v0.1.0
