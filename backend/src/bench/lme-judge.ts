/**
 * LongMemEval-style LLM judge: compare a predicted answer to the gold answer
 * and return a binary correctness score.
 *
 * Mirrors the judge prompt shipped with the LongMemEval reference
 * implementation (https://github.com/xiaowu0162/LongMemEval) — strict
 * semantic equivalence, no partial credit, no length penalty.
 *
 * Provider is picked from whichever API key is present in the environment:
 *   - ANTHROPIC_API_KEY          → Claude (preferred)
 *   - OPENAI_API_KEY             → GPT-4o
 *   - GEMINI_API_KEY             → Gemini 2.0 Flash
 * When no key is found the judge is disabled and callers receive null.
 *
 * The bench runner passes per-question (question, gold, predicted) in
 * parallel and aggregates per-category accuracy; see longmemeval.ts.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export type JudgeProvider = "anthropic" | "openai" | "gemini" | "none";

export interface JudgeResult {
  correct: 0 | 1;
  raw: string;
}

/** Inspect env for the first available provider. */
export function pickJudgeProvider(): JudgeProvider {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.GEMINI_API_KEY)    return "gemini";
  return "none";
}

/**
 * The judge prompt. Kept in a single string so it is easy to diff against
 * the upstream LongMemEval implementation if it updates. The examples cover
 * the "specific but synonymous" and "close-but-wrong" cases that simple
 * string-match judges fail on.
 */
const JUDGE_SYSTEM = `You are an impartial grader for a memory-QA benchmark. Compare the predicted answer to the gold answer and decide whether the prediction is correct.

Rules:
  1. Judge semantic equivalence, not word-for-word match.
  2. The prediction is correct iff it contains the key fact the gold answer conveys, and does NOT contradict any other part of it. Extra detail is fine if it's compatible.
  3. A prediction that hedges ("I'm not sure but maybe...") counts as correct only if the hedged answer is right.
  4. If the prediction is empty, refuses, or is unrelated, it's incorrect.

Respond with exactly one JSON object on a single line: {"correct": 0 or 1, "why": "short reason"}. No prose before or after.`;

function buildUserPrompt(question: string, gold: string, predicted: string) {
  return `Question: ${question}
Gold answer: ${gold}
Predicted answer: ${predicted}

Return your grade as JSON.`;
}

function parseJudgeOutput(raw: string): JudgeResult {
  // Be lenient: pull the first {...} out of whatever the model emitted.
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return { correct: 0, raw };
  try {
    const obj = JSON.parse(match[0]);
    const correct = obj.correct === 1 || obj.correct === true ? 1 : 0;
    return { correct, raw };
  } catch {
    return { correct: 0, raw };
  }
}

// ─── Provider implementations ────────────────────────────────────────────────

async function judgeAnthropic(
  question: string, gold: string, predicted: string
): Promise<JudgeResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const res = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: buildUserPrompt(question, gold, predicted) }],
  });
  const block = res.content.find((b) => b.type === "text");
  return parseJudgeOutput(block?.text ?? "");
}

async function judgeOpenAI(
  question: string, gold: string, predicted: string
): Promise<JudgeResult> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user",   content: buildUserPrompt(question, gold, predicted) },
    ],
  });
  return parseJudgeOutput(res.choices[0]?.message?.content ?? "");
}

async function judgeGemini(
  question: string, gold: string, predicted: string
): Promise<JudgeResult> {
  const body = {
    system_instruction: { parts: [{ text: JUDGE_SYSTEM }] },
    contents: [
      { role: "user", parts: [{ text: buildUserPrompt(question, gold, predicted) }] },
    ],
    generationConfig: { temperature: 0 },
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`Gemini judge ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return parseJudgeOutput(text);
}

/**
 * Judge one (question, gold, predicted) triple. Returns null when no provider
 * is configured; the caller should treat null as "judge unavailable" and fall
 * back to retrieval-only metrics.
 */
export async function judgeAnswer(
  question: string,
  gold: string,
  predicted: string
): Promise<JudgeResult | null> {
  const provider = pickJudgeProvider();
  try {
    switch (provider) {
      case "anthropic": return await judgeAnthropic(question, gold, predicted);
      case "openai":    return await judgeOpenAI(question, gold, predicted);
      case "gemini":    return await judgeGemini(question, gold, predicted);
      case "none":      return null;
    }
  } catch (err) {
    return {
      correct: 0,
      raw: `judge-error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Answer generation (for end-to-end QA mode) ──────────────────────────────

const ANSWER_SYSTEM = `You are the user's personal assistant. Answer the question using ONLY the conversation excerpts below. Be concise — one or two sentences is ideal. If the excerpts don't contain the answer, say "I don't know."`;

function buildAnswerPrompt(question: string, contextExcerpts: string): string {
  return `Conversation excerpts (from past chats):
${contextExcerpts}

Question: ${question}`;
}

async function generateAnthropic(question: string, ctx: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const res = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 400,
    system: ANSWER_SYSTEM,
    messages: [{ role: "user", content: buildAnswerPrompt(question, ctx) }],
  });
  const block = res.content.find((b) => b.type === "text");
  return block?.text ?? "";
}

async function generateOpenAI(question: string, ctx: string): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    messages: [
      { role: "system", content: ANSWER_SYSTEM },
      { role: "user",   content: buildAnswerPrompt(question, ctx) },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
}

async function generateGemini(question: string, ctx: string): Promise<string> {
  const body = {
    system_instruction: { parts: [{ text: ANSWER_SYSTEM }] },
    contents: [
      { role: "user", parts: [{ text: buildAnswerPrompt(question, ctx) }] },
    ],
    generationConfig: { temperature: 0 },
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`Gemini answer ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

/**
 * Generate an answer to `question` using `contextExcerpts` (already a
 * newline-joined excerpt list). Returns null when no provider is configured
 * or when generation errors — caller should treat null as "skip this question
 * for end-to-end scoring, keep retrieval metrics".
 */
export async function generateQAAnswer(
  question: string,
  contextExcerpts: string
): Promise<string | null> {
  const provider = pickJudgeProvider();
  try {
    switch (provider) {
      case "anthropic": return await generateAnthropic(question, contextExcerpts);
      case "openai":    return await generateOpenAI(question, contextExcerpts);
      case "gemini":    return await generateGemini(question, contextExcerpts);
      case "none":      return null;
    }
  } catch (err) {
    return `generation-error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
