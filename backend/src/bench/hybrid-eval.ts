/**
 * RecallOS Hybrid Retrieval Eval
 *
 * A LongMemEval-compatible evaluation harness for the verbatim evidence lane.
 * Measures how well searchVerbatim() retrieves the single relevant event from
 * a controlled dataset of noise events, across five categories that mirror the
 * LongMemEval benchmark structure.
 *
 * Categories (mirroring LongMemEval paper):
 *   single_session_preference  – preference stated once, recalled later
 *   multi_session_preference   – older preference buried in more noise
 *   assistant_recall           – what the assistant recommended
 *   temporal_history           – time-anchored recall ("last week")
 *   episodic_search            – specific past event ("when did I visit X?")
 *   noisy_haystack             – hard cases: 40+ irrelevant events
 *
 * Metrics per case (binary relevance: 1 relevant document per case):
 *   Recall@5   = 1 if relevant event is in top-5 results
 *   Recall@10  = 1 if relevant event is in top-10 results
 *   NDCG@5     = 1/log2(rank+1) if rank ≤ 5, else 0
 *   NDCG@10    = 1/log2(rank+1) if rank ≤ 10, else 0
 *   MRR        = 1/rank (0 if not found in top-10)
 *
 * Semantic signal (embedding cosine) is absent in this harness because no
 * OpenAI API key is configured.  The eval measures the BM25 + temporal +
 * preference + role signals — the fair baseline.  Add an OpenAI key to
 * provider_settings and rerun to observe the semantic uplift.
 *
 * Run with: npx tsx src/bench/hybrid-eval.ts (from backend/)
 */

import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { initDatabase, runSql } from "../db/index.js";
import { classifyQuery } from "../modules/query-classifier.js";
import { searchVerbatim } from "../modules/verbatim-retriever.js";
import type { RetrievalOptions } from "../modules/verbatim-retriever.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type Category =
  | "single_session_preference"
  | "multi_session_preference"
  | "assistant_recall"
  | "temporal_history"
  | "episodic_search"
  | "noisy_haystack";

interface EvalCase {
  id: string;
  category: Category;
  description: string;
  relevantContent: string;
  relevantRole: "user" | "assistant";
  relevantDaysAgo: number;
  noiseCount: number;
  query: string;
  isAssistantQuery?: boolean;
  useTemporalAnchor?: boolean;  // derive anchor from classifyQuery(query)
}

interface CaseResult {
  case_id: string;
  category: Category;
  description: string;
  query: string;
  relevant_rank: number | null;
  recall_at_5: number;
  recall_at_10: number;
  ndcg_at_5: number;
  ndcg_at_10: number;
  mrr: number;
  top_snippet: string;
}

// ─── Noise pool ───────────────────────────────────────────────────────────────
// 50 diverse, realistic conversation events that are semantically unrelated to
// the test queries. Used to fill the search index with irrelevant documents.

const NOISE_POOL: Array<{ role: "user" | "assistant"; content: string }> = [
  { role: "user",      content: "Can you help me plan a road trip along the California coast?" },
  { role: "assistant", content: "Sure! I'd suggest starting from San Francisco and driving south on Highway 1." },
  { role: "user",      content: "What are the best hiking trails in Patagonia?" },
  { role: "assistant", content: "The W Trek in Torres del Paine is considered the classic Patagonia hike." },
  { role: "user",      content: "I need to book a table at a restaurant for my anniversary dinner." },
  { role: "assistant", content: "I'd recommend making a reservation at least two weeks in advance for special occasions." },
  { role: "user",      content: "Help me write a cover letter for a product manager role." },
  { role: "assistant", content: "A strong PM cover letter should highlight your experience with cross-functional teams." },
  { role: "user",      content: "What's the best way to learn piano as an adult?" },
  { role: "assistant", content: "Consistent daily practice of 20-30 minutes beats infrequent long sessions." },
  { role: "user",      content: "How do I fix a memory leak in my Node.js application?" },
  { role: "assistant", content: "Use the --inspect flag and Chrome DevTools heap snapshot to identify leaking objects." },
  { role: "user",      content: "What plants grow well in low-light indoor environments?" },
  { role: "assistant", content: "Pothos, snake plants, and ZZ plants thrive with minimal light." },
  { role: "user",      content: "Can you explain the difference between ETF and mutual funds?" },
  { role: "assistant", content: "ETFs trade on exchanges like stocks; mutual funds are priced once per day at NAV." },
  { role: "user",      content: "I'm looking for a good mystery novel recommendation." },
  { role: "assistant", content: "Try The Secret History by Donna Tartt — it's a literary mystery with rich characters." },
  { role: "user",      content: "How do I set up a CI/CD pipeline for my Django project?" },
  { role: "assistant", content: "GitHub Actions with a standard Django test workflow is a solid starting point." },
  { role: "user",      content: "What are some good destinations for a solo trip in Southeast Asia?" },
  { role: "assistant", content: "Chiang Mai is a great base — low cost, great food, and good infrastructure for solo travel." },
  { role: "user",      content: "How long does it take to learn Mandarin as a native English speaker?" },
  { role: "assistant", content: "The FSI estimates 2,200 hours for professional working proficiency in Mandarin." },
  { role: "user",      content: "What's the best way to negotiate a salary offer?" },
  { role: "assistant", content: "Always negotiate after you have the offer letter; ask for 10-15% above the initial offer." },
  { role: "user",      content: "I want to start a podcast. What equipment do I need?" },
  { role: "assistant", content: "A good USB microphone like the Blue Yeti and free Audacity software is enough to start." },
  { role: "user",      content: "How do I calculate compound interest manually?" },
  { role: "assistant", content: "The formula is A = P(1 + r/n)^(nt) where P is principal, r is rate, n is compounds/year." },
  { role: "user",      content: "What's the difference between machine learning and deep learning?" },
  { role: "assistant", content: "Deep learning is a subset of ML using neural networks with many layers." },
  { role: "user",      content: "I need to repair a hole in my drywall. What's the easiest way?" },
  { role: "assistant", content: "For small holes, use a patch kit with mesh tape and joint compound, then sand smooth." },
  { role: "user",      content: "What's a good workout routine for someone new to the gym?" },
  { role: "assistant", content: "Start with a 3-day full-body routine: squats, deadlifts, bench press, and rows." },
  { role: "user",      content: "Help me understand the difference between a Roth IRA and a traditional IRA." },
  { role: "assistant", content: "Roth contributions are after-tax but grow tax-free; traditional contributions may be pre-tax." },
  { role: "user",      content: "I'm redecorating my living room. What color palette works with dark wood floors?" },
  { role: "assistant", content: "Warm neutrals like cream, taupe, and sage complement dark wood floors beautifully." },
  { role: "user",      content: "What are the best ways to reduce food waste at home?" },
  { role: "assistant", content: "Plan meals for the week, store produce correctly, and keep a 'use first' shelf in the fridge." },
  { role: "user",      content: "How do I prepare for a technical coding interview at a top tech company?" },
  { role: "assistant", content: "Focus on LeetCode medium/hard problems across arrays, trees, graphs, and dynamic programming." },
  { role: "user",      content: "I want to get into surfing. What board should I start with?" },
  { role: "assistant", content: "A longboard (9+ feet) or a foam board gives beginners the most stability." },
  { role: "user",      content: "What's the difference between a trademark, copyright, and patent?" },
  { role: "assistant", content: "Trademarks protect brands, copyrights protect creative works, patents protect inventions." },
  { role: "user",      content: "How do I get my dog to stop barking at strangers?" },
  { role: "assistant", content: "Counter-conditioning — pair strangers with high-value treats — is the most effective approach." },
  { role: "user",      content: "What's the best way to pack a suitcase to avoid wrinkles?" },
  { role: "assistant", content: "Rolling clothes and using packing cubes minimizes wrinkles and maximizes space." },
  { role: "user",      content: "Can you help me draft a LinkedIn profile summary?" },
  { role: "assistant", content: "Lead with your impact, not your job title, and end with what you're looking for next." },
  { role: "user",      content: "I'm thinking of adopting a second cat. Is it hard to introduce them?" },
  { role: "assistant", content: "Slow introductions over 1-2 weeks — starting with scent swapping — work best." },
  { role: "user",      content: "What's the most efficient way to study for an exam?" },
  { role: "assistant", content: "Spaced repetition and active recall outperform re-reading by a wide margin." },
];

// ─── Eval cases ───────────────────────────────────────────────────────────────

const EVAL_CASES: EvalCase[] = [
  // ─── single_session_preference ──────────────────────────────────────────────
  // Preferences stated once in a past session, recalled in a new session.
  {
    id: "ssp_01", category: "single_session_preference",
    description: "Flight seat preference",
    relevantContent: "I always prefer window seats on flights, especially on long-haul routes.",
    relevantRole: "user", relevantDaysAgo: 5, noiseCount: 20,
    query: "what seat do I prefer on flights?",
  },
  {
    id: "ssp_02", category: "single_session_preference",
    description: "Vegetarian diet",
    relevantContent: "I'm vegetarian and never eat meat or fish, though I do eat eggs and dairy.",
    relevantRole: "user", relevantDaysAgo: 10, noiseCount: 20,
    query: "what are my dietary restrictions?",
  },
  {
    id: "ssp_03", category: "single_session_preference",
    description: "Direct flights preference",
    relevantContent: "I really prefer direct flights and avoid connections whenever possible.",
    relevantRole: "user", relevantDaysAgo: 7, noiseCount: 20,
    query: "do I prefer direct or connecting flights?",
  },
  {
    id: "ssp_04", category: "single_session_preference",
    description: "Hotel budget constraint",
    relevantContent: "My budget for hotels is about $150 per night — I don't like spending more than that.",
    relevantRole: "user", relevantDaysAgo: 14, noiseCount: 20,
    query: "what's my hotel budget per night?",
  },
  {
    id: "ssp_05", category: "single_session_preference",
    description: "Spicy food avoidance",
    relevantContent: "I can't stand spicy food — even mild salsa is too hot for me.",
    relevantRole: "user", relevantDaysAgo: 6, noiseCount: 20,
    query: "what foods should I avoid?",
  },
  {
    id: "ssp_06", category: "single_session_preference",
    description: "Programming language preference",
    relevantContent: "I prefer TypeScript over plain JavaScript for any new project I start.",
    relevantRole: "user", relevantDaysAgo: 8, noiseCount: 20,
    query: "which programming language do I prefer?",
  },
  {
    id: "ssp_07", category: "single_session_preference",
    description: "Morning beverage",
    relevantContent: "I love cold brew coffee every morning — can't start the day without it.",
    relevantRole: "user", relevantDaysAgo: 3, noiseCount: 20,
    query: "what do I usually drink in the morning?",
  },
  {
    id: "ssp_08", category: "single_session_preference",
    description: "Dark mode preference",
    relevantContent: "I always use dark mode on every device and app — bright screens hurt my eyes.",
    relevantRole: "user", relevantDaysAgo: 12, noiseCount: 20,
    query: "what UI preference do I have for themes?",
  },

  // ─── multi_session_preference ───────────────────────────────────────────────
  // Older preferences (30-60 days) buried under heavier noise.
  {
    id: "msp_01", category: "multi_session_preference",
    description: "Aisle seat old preference",
    relevantContent: "I always book aisle seats on flights — I hate being stuck in the middle or by the window.",
    relevantRole: "user", relevantDaysAgo: 45, noiseCount: 30,
    query: "what seat type do I book on flights?",
  },
  {
    id: "msp_02", category: "multi_session_preference",
    description: "Budget airline avoidance",
    relevantContent: "I avoid low-cost carriers like Spirit and Ryanair — the hidden fees aren't worth it.",
    relevantRole: "user", relevantDaysAgo: 60, noiseCount: 30,
    query: "what airlines do I avoid?",
  },
  {
    id: "msp_03", category: "multi_session_preference",
    description: "Gluten-free diet",
    relevantContent: "I have celiac disease, so I strictly follow a gluten-free diet.",
    relevantRole: "user", relevantDaysAgo: 50, noiseCount: 30,
    query: "what dietary requirements do I have?",
  },
  {
    id: "msp_04", category: "multi_session_preference",
    description: "Vim editor preference",
    relevantContent: "I switched from VS Code to Neovim six months ago and now I can't go back.",
    relevantRole: "user", relevantDaysAgo: 35, noiseCount: 30,
    query: "what code editor do I use?",
  },
  {
    id: "msp_05", category: "multi_session_preference",
    description: "Early morning schedule",
    relevantContent: "I wake up at 5:30am every day and work best before noon — mornings are my peak hours.",
    relevantRole: "user", relevantDaysAgo: 55, noiseCount: 30,
    query: "when am I most productive during the day?",
  },

  // ─── assistant_recall ───────────────────────────────────────────────────────
  // Recalling what the assistant recommended in a prior session.
  {
    id: "ar_01", category: "assistant_recall",
    description: "Laptop recommendation",
    relevantContent: "I recommend the MacBook Pro M3 Max for your software development work — it handles compilation and virtualization extremely well.",
    relevantRole: "assistant", relevantDaysAgo: 7, noiseCount: 20,
    query: "what laptop did you recommend for my development work?",
    isAssistantQuery: true,
  },
  {
    id: "ar_02", category: "assistant_recall",
    description: "Tokyo neighborhood recommendation",
    relevantContent: "For your Tokyo trip, I'd suggest staying in Shinjuku — it's central, well-connected, and has great nightlife options.",
    relevantRole: "assistant", relevantDaysAgo: 14, noiseCount: 20,
    query: "what neighborhood did you suggest I stay in for Tokyo?",
    isAssistantQuery: true,
  },
  {
    id: "ar_03", category: "assistant_recall",
    description: "Database recommendation",
    relevantContent: "Given your read-heavy workload and need for JSONB support, I recommend PostgreSQL over MySQL for your application.",
    relevantRole: "assistant", relevantDaysAgo: 10, noiseCount: 20,
    query: "what database did you recommend for my app?",
    isAssistantQuery: true,
  },
  {
    id: "ar_04", category: "assistant_recall",
    description: "Best time to visit Kyoto",
    relevantContent: "I'd recommend visiting Kyoto in early November — the autumn foliage peaks then and crowds are smaller than during cherry blossom season.",
    relevantRole: "assistant", relevantDaysAgo: 21, noiseCount: 20,
    query: "when did you say was the best time to visit Kyoto?",
    isAssistantQuery: true,
  },
  {
    id: "ar_05", category: "assistant_recall",
    description: "State management recommendation",
    relevantContent: "For your React app's complexity, I'd go with Zustand over Redux — it's much simpler and handles your use case well.",
    relevantRole: "assistant", relevantDaysAgo: 5, noiseCount: 20,
    query: "what state management library did you recommend for my React project?",
    isAssistantQuery: true,
  },
  {
    id: "ar_06", category: "assistant_recall",
    description: "Python library recommendation",
    relevantContent: "For your data processing pipeline, use Polars instead of Pandas — it's significantly faster for your dataset size.",
    relevantRole: "assistant", relevantDaysAgo: 18, noiseCount: 20,
    query: "which Python library did you suggest for data processing?",
    isAssistantQuery: true,
  },
  {
    id: "ar_07", category: "assistant_recall",
    description: "Jacket recommendation",
    relevantContent: "For Iceland in winter, I recommend the Arc'teryx Atom LT Hoody as your midlayer — it's packable and very warm for the weight.",
    relevantRole: "assistant", relevantDaysAgo: 30, noiseCount: 20,
    query: "what jacket did you recommend for my Iceland trip?",
    isAssistantQuery: true,
  },
  {
    id: "ar_08", category: "assistant_recall",
    description: "Cloud provider recommendation",
    relevantContent: "Given your team's AWS expertise and the existing infrastructure, staying on AWS is the right call — migrating to GCP now would cost more than it saves.",
    relevantRole: "assistant", relevantDaysAgo: 8, noiseCount: 20,
    query: "what cloud provider did you say I should use?",
    isAssistantQuery: true,
  },

  // ─── temporal_history ───────────────────────────────────────────────────────
  // Time-anchored queries. The temporal proximity boost is the key signal here.
  {
    id: "th_01", category: "temporal_history",
    description: "Yesterday recall",
    relevantContent: "I just signed a lease on a new apartment in Brooklyn — move-in is next month.",
    relevantRole: "user", relevantDaysAgo: 1, noiseCount: 20,
    query: "what did I mention yesterday?",
    useTemporalAnchor: true,
  },
  {
    id: "th_02", category: "temporal_history",
    description: "Last week recall",
    relevantContent: "I started a new job at a fintech startup — it's been a stressful but exciting first week.",
    relevantRole: "user", relevantDaysAgo: 7, noiseCount: 20,
    query: "what did I tell you about last week?",
    useTemporalAnchor: true,
  },
  {
    id: "th_03", category: "temporal_history",
    description: "Two weeks ago recall",
    relevantContent: "I completed my first triathlon — it was brutal but I finished in under three hours.",
    relevantRole: "user", relevantDaysAgo: 14, noiseCount: 20,
    query: "what happened two weeks ago?",
    useTemporalAnchor: true,
  },
  {
    id: "th_04", category: "temporal_history",
    description: "Last month recall",
    relevantContent: "I submitted my PhD thesis last month — now waiting for the examination board's response.",
    relevantRole: "user", relevantDaysAgo: 30, noiseCount: 20,
    query: "what was I working on last month?",
    useTemporalAnchor: true,
  },
  {
    id: "th_05", category: "temporal_history",
    description: "Recent recall",
    relevantContent: "I got my annual blood test results back — my vitamin D is low and the doctor recommended supplements.",
    relevantRole: "user", relevantDaysAgo: 3, noiseCount: 20,
    query: "what medical thing did I mention recently?",
    useTemporalAnchor: true,
  },

  // ─── episodic_search ────────────────────────────────────────────────────────
  // Searching for a specific past event by description.
  {
    id: "ep_01", category: "episodic_search",
    description: "Sagrada Familia visit",
    relevantContent: "I visited the Sagrada Familia in Barcelona — the Nativity facade is breathtaking up close.",
    relevantRole: "user", relevantDaysAgo: 20, noiseCount: 20,
    query: "when did I visit the Sagrada Familia?",
  },
  {
    id: "ep_02", category: "episodic_search",
    description: "First marathon",
    relevantContent: "I ran my first marathon in Berlin last autumn — finished in 4:12, way better than I expected.",
    relevantRole: "user", relevantDaysAgo: 90, noiseCount: 20,
    query: "when did I run my first marathon?",
  },
  {
    id: "ep_03", category: "episodic_search",
    description: "Learning Spanish start",
    relevantContent: "I started learning Spanish six months ago using Duolingo and a weekly online tutor.",
    relevantRole: "user", relevantDaysAgo: 30, noiseCount: 20,
    query: "when did I start learning Spanish?",
  },
  {
    id: "ep_04", category: "episodic_search",
    description: "Restaurant order",
    relevantContent: "I ordered the truffle tagliatelle at that Italian place in Notting Hill — absolutely incredible.",
    relevantRole: "user", relevantDaysAgo: 12, noiseCount: 20,
    query: "what did I order at the Italian restaurant in Notting Hill?",
  },
  {
    id: "ep_05", category: "episodic_search",
    description: "Job promotion",
    relevantContent: "I got promoted to Staff Engineer last quarter — comes with a significant pay increase.",
    relevantRole: "user", relevantDaysAgo: 45, noiseCount: 20,
    query: "when did I get promoted?",
  },
  {
    id: "ep_06", category: "episodic_search",
    description: "Cat adoption",
    relevantContent: "I adopted my cat Mochi from a local rescue shelter in January — she's three years old.",
    relevantRole: "user", relevantDaysAgo: 60, noiseCount: 20,
    query: "where did I get my cat Mochi?",
  },
  {
    id: "ep_07", category: "episodic_search",
    description: "AWS certification",
    relevantContent: "I passed the AWS Solutions Architect Professional exam last quarter after three months of studying.",
    relevantRole: "user", relevantDaysAgo: 75, noiseCount: 20,
    query: "what AWS certification did I complete?",
  },
  {
    id: "ep_08", category: "episodic_search",
    description: "Side project launch",
    relevantContent: "I launched my SaaS side project this week — it's a Notion-to-website tool and already has 12 paying users.",
    relevantRole: "user", relevantDaysAgo: 4, noiseCount: 20,
    query: "when did I launch my side project?",
  },

  // ─── noisy_haystack ─────────────────────────────────────────────────────────
  // Hard cases: 40+ irrelevant events, testing signal-to-noise robustness.
  {
    id: "nh_01", category: "noisy_haystack",
    description: "Allergy buried in travel noise",
    relevantContent: "I'm allergic to shellfish — shrimp, lobster, crab all cause an allergic reaction.",
    relevantRole: "user", relevantDaysAgo: 15, noiseCount: 45,
    query: "do I have any food allergies?",
  },
  {
    id: "nh_02", category: "noisy_haystack",
    description: "Preferred airline buried in general noise",
    relevantContent: "I always fly Japan Airlines when going to Asia — their business class is exceptional for the price.",
    relevantRole: "user", relevantDaysAgo: 40, noiseCount: 45,
    query: "what airline do I prefer for Asia flights?",
  },
  {
    id: "nh_03", category: "noisy_haystack",
    description: "Morning routine in lifestyle noise",
    relevantContent: "My morning routine is a 10-minute meditation, 30 minutes of journaling, then a quick run.",
    relevantRole: "user", relevantDaysAgo: 25, noiseCount: 45,
    query: "what does my morning routine look like?",
  },
  {
    id: "nh_04", category: "noisy_haystack",
    description: "Assistant recommendation buried deep",
    relevantContent: "For your investing goals, I recommend a simple three-fund portfolio: total US market, total international, and bonds.",
    relevantRole: "assistant", relevantDaysAgo: 50, noiseCount: 45,
    query: "what investment strategy did you recommend for me?",
    isAssistantQuery: true,
  },
  {
    id: "nh_05", category: "noisy_haystack",
    description: "Tech stack preference in sea of noise",
    relevantContent: "I use Go for backend services and React with TypeScript for the frontend — that's my standard stack.",
    relevantRole: "user", relevantDaysAgo: 35, noiseCount: 45,
    query: "what is my preferred tech stack?",
  },
  {
    id: "nh_06", category: "noisy_haystack",
    description: "Subtle preference via I-tend-to phrasing",
    relevantContent: "I tend to book hotels near public transit — I never rent cars abroad because I find driving stressful.",
    relevantRole: "user", relevantDaysAgo: 20, noiseCount: 45,
    query: "how do I usually get around when traveling?",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function insertConversation(id: string): void {
  runSql(
    `INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at)
     VALUES (?, 'eval-conv', datetime('now'), datetime('now'))`,
    [id]
  );
}

function insertEventAt(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  daysAgo: number
): string {
  const id        = uuidv4();
  const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  runSql(
    `INSERT INTO events (id, conversation_id, role, content, provider, created_at)
     VALUES (?, ?, ?, ?, 'eval', ?)`,
    [id, conversationId, role, content, timestamp]
  );
  return id;
}

function ndcg(rank: number | null, k: number): number {
  if (rank === null || rank > k) return 0;
  return 1 / Math.log2(rank + 1);
}

// ─── Run a single case ────────────────────────────────────────────────────────

async function runCase(ec: EvalCase, tmpDir: string): Promise<CaseResult> {
  const dbFile = path.join(tmpDir, `${ec.id}.db`);
  await initDatabase(dbFile);

  // Three conversations: noise, relevant event, and current (excluded from search)
  const noiseConv   = uuidv4();
  const pastConv    = uuidv4();
  const currentConv = uuidv4();
  insertConversation(noiseConv);
  insertConversation(pastConv);
  insertConversation(currentConv);

  // Insert noise events spread across the last 90 days
  const noiseSlice = NOISE_POOL.slice(0, Math.min(ec.noiseCount, NOISE_POOL.length));
  for (let i = 0; i < noiseSlice.length; i++) {
    const daysAgo = 1 + (i * 90 / noiseSlice.length) | 0;
    insertEventAt(noiseConv, noiseSlice[i].role, noiseSlice[i].content, daysAgo);
  }
  // If noiseCount > NOISE_POOL.length, cycle through pool again with offset timestamps
  for (let i = NOISE_POOL.length; i < ec.noiseCount; i++) {
    const ni = i % NOISE_POOL.length;
    const daysAgo = 1 + ((i * 90 / ec.noiseCount) | 0);
    insertEventAt(noiseConv, NOISE_POOL[ni].role, NOISE_POOL[ni].content, daysAgo);
  }

  // Insert the single relevant event
  const relevantId = insertEventAt(
    pastConv,
    ec.relevantRole,
    ec.relevantContent,
    ec.relevantDaysAgo
  );

  // Build retrieval options
  const classification = classifyQuery(ec.query);
  const options: RetrievalOptions = {
    maxResults:             10,
    excludeConversationId:  currentConv,
    isAssistantQuery:       ec.isAssistantQuery ?? false,
    temporalAnchor:         ec.useTemporalAnchor ? classification.temporalAnchor : undefined,
  };

  const snippets = await searchVerbatim(ec.query, options);

  // Find rank of the relevant event (1-indexed; null = not in top-10)
  const rankIdx       = snippets.findIndex((s) => s.event_id === relevantId);
  const relevantRank  = rankIdx >= 0 ? rankIdx + 1 : null;
  const topSnippet    = snippets[0]?.content.slice(0, 70) ?? "—";

  return {
    case_id:       ec.id,
    category:      ec.category,
    description:   ec.description,
    query:         ec.query,
    relevant_rank: relevantRank,
    recall_at_5:   relevantRank !== null && relevantRank <= 5  ? 1 : 0,
    recall_at_10:  relevantRank !== null && relevantRank <= 10 ? 1 : 0,
    ndcg_at_5:     ndcg(relevantRank, 5),
    ndcg_at_10:    ndcg(relevantRank, 10),
    mrr:           relevantRank !== null ? 1 / relevantRank : 0,
    top_snippet:   topSnippet,
  };
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

function avg(nums: number[]): number {
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function gradeOverall(r5: number): string {
  if (r5 >= 0.95) return "A+";
  if (r5 >= 0.90) return "A";
  if (r5 >= 0.85) return "B+";
  if (r5 >= 0.80) return "B";
  if (r5 >= 0.75) return "C+";
  if (r5 >= 0.70) return "C";
  return "D";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("RecallOS Hybrid Retrieval Eval");
  console.log("══════════════════════════════════════════════════════════════\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recallos-eval-"));

  const results: CaseResult[] = [];
  let totalCases = 0;
  let dotCount   = 0;

  process.stdout.write("Running cases: ");
  for (const ec of EVAL_CASES) {
    const result = await runCase(ec, tmpDir);
    results.push(result);
    totalCases++;
    process.stdout.write(result.recall_at_5 ? "·" : "✗");
    dotCount++;
    if (dotCount % 10 === 0) process.stdout.write(" ");
  }
  console.log("\n");

  // ── Per-category aggregation ────────────────────────────────────────────────
  const categories: Category[] = [
    "single_session_preference",
    "multi_session_preference",
    "assistant_recall",
    "temporal_history",
    "episodic_search",
    "noisy_haystack",
  ];

  const catLabel: Record<Category, string> = {
    single_session_preference: "single_session_preference",
    multi_session_preference:  "multi_session_preference ",
    assistant_recall:          "assistant_recall         ",
    temporal_history:          "temporal_history         ",
    episodic_search:           "episodic_search          ",
    noisy_haystack:            "noisy_haystack           ",
  };

  console.log("Category                       R@5    R@10   NDCG@5  NDCG@10  MRR    Cases");
  console.log("─────────────────────────────────────────────────────────────────────────");

  let allR5: number[] = [], allR10: number[] = [];
  let allN5: number[] = [], allN10: number[] = [];
  let allMrr: number[] = [];

  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    if (catResults.length === 0) continue;

    const r5  = avg(catResults.map((r) => r.recall_at_5));
    const r10 = avg(catResults.map((r) => r.recall_at_10));
    const n5  = avg(catResults.map((r) => r.ndcg_at_5));
    const n10 = avg(catResults.map((r) => r.ndcg_at_10));
    const mrr = avg(catResults.map((r) => r.mrr));

    allR5.push(...catResults.map((r) => r.recall_at_5));
    allR10.push(...catResults.map((r) => r.recall_at_10));
    allN5.push(...catResults.map((r) => r.ndcg_at_5));
    allN10.push(...catResults.map((r) => r.ndcg_at_10));
    allMrr.push(...catResults.map((r) => r.mrr));

    console.log(
      `${catLabel[cat]}  ${fmt(r5)}  ${fmt(r10)}  ${fmt(n5)}   ${fmt(n10)}   ${fmt(mrr)}  ${catResults.length}`
    );
  }

  const overallR5  = avg(allR5);
  const overallR10 = avg(allR10);
  const overallN5  = avg(allN5);
  const overallN10 = avg(allN10);
  const overallMrr = avg(allMrr);

  console.log("─────────────────────────────────────────────────────────────────────────");
  console.log(
    `Overall                        ${fmt(overallR5)}  ${fmt(overallR10)}  ${fmt(overallN5)}   ${fmt(overallN10)}   ${fmt(overallMrr)}  ${totalCases}`
  );

  const grade = gradeOverall(overallR5);
  console.log(`\nGrade: ${grade}  (target: ≥0.85 Recall@5, LongMemEval baseline: ~0.40)\n`);

  // ── Failed cases ────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.recall_at_5 === 0);
  if (failed.length > 0) {
    console.log(`Missed cases (relevant not in top-5):`);
    for (const r of failed) {
      const rankStr = r.relevant_rank ? `rank ${r.relevant_rank}` : "not found";
      console.log(`  [${r.case_id}] ${r.description}`);
      console.log(`    query: "${r.query}"`);
      console.log(`    result: ${rankStr}  |  top snippet: "${r.top_snippet}"`);
    }
    console.log();
  }

  // ── Semantic uplift note ────────────────────────────────────────────────────
  const missedCount = failed.length;
  if (missedCount > 0) {
    console.log(
      `Note: ${missedCount} case(s) failed on BM25 + boosts alone. ` +
      `Configure an OpenAI key in Settings → Providers to enable the\n` +
      `semantic cosine signal, which is expected to recover these cases.\n`
    );
  } else {
    console.log("All cases retrieved successfully with BM25 + boosts. ✓\n");
  }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  process.exit(failed.length > 0 && overallR5 < 0.7 ? 1 : 0);
}

main().catch((err) => {
  console.error("Eval error:", err);
  process.exit(1);
});
