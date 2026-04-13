/**
 * Domain auto-detection module.
 * Infers a domain from memory key + value using keyword matching.
 */

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  travel: [
    "hotel", "flight", "airport", "airline", "trip", "vacation", "travel",
    "destination", "booking", "resort", "cruise", "passport", "luggage",
    "itinerary", "hostel", "airbnb", "train", "taxi", "uber",
  ],
  coding: [
    "code", "programming", "framework", "api", "database", "backend",
    "frontend", "react", "typescript", "python", "javascript", "git",
    "deploy", "server", "docker", "kubernetes", "npm", "package",
    "function", "class", "variable", "debug", "test", "ci", "cd",
  ],
  work: [
    "meeting", "deadline", "project", "team", "manager", "salary",
    "office", "remote", "standup", "sprint", "kanban", "jira",
    "slack", "email", "presentation", "report", "quarterly",
  ],
  health: [
    "exercise", "workout", "diet", "calories", "sleep", "meditation",
    "doctor", "medicine", "supplement", "vitamin", "allergy", "weight",
    "running", "gym", "yoga", "mental", "therapy", "blood",
  ],
  finance: [
    "budget", "investment", "savings", "expense", "tax", "income",
    "crypto", "stock", "portfolio", "retirement", "mortgage", "loan",
    "bank", "credit", "insurance", "payment",
  ],
  learning: [
    "course", "book", "study", "lecture", "tutorial", "lesson",
    "certificate", "skill", "language", "class", "university",
    "research", "paper", "exam", "degree",
  ],
  writing: [
    "blog", "article", "essay", "draft", "editor", "publish",
    "manuscript", "chapter", "novel", "poetry", "content", "copywriting",
  ],
  personal: [
    "birthday", "family", "friend", "hobby", "pet", "home",
    "apartment", "furniture", "cooking", "recipe", "garden",
  ],
  communication: [
    "email", "message", "tone", "formal", "informal", "greeting",
    "signature", "template", "response", "notification",
  ],
};

/**
 * Try to infer a domain from the key and value text.
 * Returns null if no domain matches with enough confidence.
 */
export function detectDomain(key: string, value: string): string | null {
  const text = `${key} ${value}`.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > 0) scores[domain] = score;
  }

  // Need at least 2 keyword matches to be confident
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0 || entries[0][1] < 2) return null;

  return entries[0][0];
}
