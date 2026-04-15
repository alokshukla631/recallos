export type EntityType = "date" | "destination" | "amount" | "duration" | "technology" | "language";

export interface Entity {
  type: EntityType;
  value: string;
  normalized: string;
}

// ---------------------------------------------------------------------------
// Destinations (travel domain)
// ---------------------------------------------------------------------------

const KNOWN_DESTINATIONS = [
  // Countries
  "Japan", "France", "Italy", "Spain", "Germany", "Thailand", "Vietnam",
  "India", "China", "Mexico", "Brazil", "Argentina", "Greece", "Turkey",
  "Egypt", "Morocco", "Portugal", "Netherlands", "Belgium", "Switzerland",
  "Austria", "Sweden", "Norway", "Denmark", "Finland", "Iceland", "Ireland",
  "Scotland", "Australia", "New Zealand", "Canada", "Peru", "Chile", "Colombia",
  "Indonesia", "Malaysia", "Singapore", "Philippines", "South Korea", "Taiwan",
  "Hong Kong", "UAE", "Dubai", "Israel", "Jordan", "Kenya", "Tanzania",
  "Czech Republic", "Poland", "Hungary", "Romania", "Croatia", "Slovenia",
  "Costa Rica", "Panama", "Cuba", "Jamaica", "Dominican Republic",
  "South Africa", "Ghana", "Ethiopia", "Nigeria", "Rwanda",
  "Sri Lanka", "Nepal", "Myanmar", "Cambodia", "Laos",
  // Cities
  "Tokyo", "Kyoto", "Osaka", "Sapporo", "Paris", "Lyon", "Nice", "Rome",
  "Milan", "Venice", "Florence", "Naples", "Barcelona", "Madrid", "Seville",
  "Berlin", "Munich", "Hamburg", "Bangkok", "Phuket", "Chiang Mai", "Hanoi",
  "Mumbai", "Delhi", "Bangalore", "Goa", "Shanghai", "Beijing", "Mexico City",
  "Cancun", "Tulum", "Athens", "Santorini", "Istanbul", "Cairo", "Marrakech",
  "Lisbon", "Porto", "Amsterdam", "Brussels", "Zurich", "Geneva", "Vienna",
  "Stockholm", "Oslo", "Copenhagen", "Helsinki", "Reykjavik", "Dublin",
  "Edinburgh", "London", "Manchester", "Sydney", "Melbourne", "Auckland",
  "Toronto", "Vancouver", "Montreal", "Lima", "Cusco", "Santiago", "Bogota",
  "Bali", "Jakarta", "Kuala Lumpur", "Seoul", "Taipei", "Tel Aviv", "Petra",
  "Nairobi", "Zanzibar", "New York", "Los Angeles", "San Francisco", "Chicago",
  "Boston", "Seattle", "Miami", "Austin", "Denver", "Las Vegas",
  "Prague", "Budapest", "Warsaw", "Krakow", "Dubrovnik", "Split", "Ljubljana",
  "San Jose", "Havana", "Cape Town", "Johannesburg", "Addis Ababa",
  "Colombo", "Kathmandu", "Yangon", "Siem Reap", "Luang Prabang",
  "Ho Chi Minh City", "Da Nang", "Phnom Penh", "Maldives",
  "Washington DC", "Philadelphia", "Portland", "Nashville", "New Orleans",
  "Honolulu", "San Diego", "Atlanta", "Dallas", "Houston",
];

const DESTINATION_REGEX = new RegExp(
  `\\b(${KNOWN_DESTINATIONS.map((d) => d.replace(/\s+/g, "\\s+")).join("|")})\\b`,
  "gi"
);

// ---------------------------------------------------------------------------
// Technologies (coding domain)
// ---------------------------------------------------------------------------

const KNOWN_TECHNOLOGIES = [
  // Languages
  "TypeScript", "JavaScript", "Python", "Rust", "Go", "Java", "C#", "C\\+\\+",
  "Ruby", "PHP", "Swift", "Kotlin", "Scala", "Elixir", "Haskell", "Lua",
  "Dart", "R", "Julia", "Perl", "Clojure", "Zig", "OCaml",
  // Frontend frameworks
  "React", "Vue", "Angular", "Svelte", "Next\\.js", "Nuxt", "Remix",
  "Astro", "SolidJS", "Qwik", "Gatsby",
  // Backend frameworks
  "Express", "FastAPI", "Django", "Flask", "Spring Boot", "Rails",
  "NestJS", "Hono", "Actix", "Axum", "Gin", "Echo", "Fiber",
  // Databases
  "PostgreSQL", "MySQL", "MongoDB", "Redis", "SQLite", "DynamoDB",
  "Supabase", "Firebase", "Prisma", "Drizzle", "Cassandra", "Neo4j",
  // Cloud / Infra
  "AWS", "Azure", "GCP", "Vercel", "Netlify", "Cloudflare", "Docker",
  "Kubernetes", "Terraform", "Pulumi",
  // Tools
  "Git", "GitHub", "GitLab", "VS Code", "Cursor", "Vim", "Neovim",
  "IntelliJ", "WebStorm", "Xcode", "Android Studio",
  // AI / ML
  "TensorFlow", "PyTorch", "LangChain", "LlamaIndex", "OpenAI",
  "Anthropic", "Hugging Face",
  // Other
  "GraphQL", "REST", "gRPC", "Webpack", "Vite", "Tailwind", "Bootstrap",
  "Material UI", "Chakra UI", "Storybook",
];

// Use (?!\w) instead of \b at the end because \b doesn't work after
// non-word characters like + or # (C++, C#). \b requires a transition
// between \w and \W, but + and # are already \W so \b never fires
// when followed by punctuation or whitespace.
const TECH_REGEX = new RegExp(
  `\\b(${KNOWN_TECHNOLOGIES.join("|")})(?!\\w)`,
  "gi"
);

// Programming languages specifically (subset for language entity type)
const PROGRAMMING_LANGUAGES = new Set([
  "typescript", "javascript", "python", "rust", "go", "java", "c#", "c++",
  "ruby", "php", "swift", "kotlin", "scala", "elixir", "haskell", "lua",
  "dart", "r", "julia", "perl", "clojure", "zig", "ocaml",
]);

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function extractDates(text: string, now: Date = new Date()): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();

  function push(raw: string, iso: string) {
    const key = `${raw}|${iso}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type: "date", value: raw, normalized: iso });
  }

  // ISO format: 2026-07-15
  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = isoRe.exec(text)) !== null) {
    push(m[0], m[0]);
  }

  // Month-day format: "July 15", "Jul 15", "July 15 2026", "15 July"
  const monthDayRe = new RegExp(
    `\\b(${Object.keys(MONTHS).join("|")})\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?\\b`,
    "gi"
  );
  while ((m = monthDayRe.exec(text)) !== null) {
    const monthNum = MONTHS[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    const year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
    if (monthNum && day >= 1 && day <= 31) {
      const iso = `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      push(m[0], iso);
    }
  }

  // Day-month format: "15 July"
  const dayMonthRe = new RegExp(
    `\\b(\\d{1,2})\\s+(${Object.keys(MONTHS).join("|")})(?:\\s+(\\d{4}))?\\b`,
    "gi"
  );
  while ((m = dayMonthRe.exec(text)) !== null) {
    const day = parseInt(m[1], 10);
    const monthNum = MONTHS[m[2].toLowerCase()];
    const year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
    if (monthNum && day >= 1 && day <= 31) {
      const iso = `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      push(m[0], iso);
    }
  }

  // Relative dates: "next week", "next month", "tomorrow", "in 3 days"
  const relRe =
    /\b(tomorrow|yesterday|today|next week|next month|next year|this week|this month)\b/gi;
  while ((m = relRe.exec(text)) !== null) {
    const phrase = m[1].toLowerCase();
    const d = new Date(now);
    switch (phrase) {
      case "today":
        break;
      case "tomorrow":
        d.setDate(d.getDate() + 1);
        break;
      case "yesterday":
        d.setDate(d.getDate() - 1);
        break;
      case "next week":
        d.setDate(d.getDate() + 7);
        break;
      case "next month":
        d.setMonth(d.getMonth() + 1);
        break;
      case "next year":
        d.setFullYear(d.getFullYear() + 1);
        break;
      case "this week":
      case "this month":
        break;
    }
    const iso = d.toISOString().slice(0, 10);
    push(m[0], iso);
  }

  // "in N days/weeks/months"
  const inNRe = /\bin\s+(\d+)\s+(day|days|week|weeks|month|months)\b/gi;
  while ((m = inNRe.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const d = new Date(now);
    if (unit.startsWith("day")) d.setDate(d.getDate() + n);
    else if (unit.startsWith("week")) d.setDate(d.getDate() + n * 7);
    else if (unit.startsWith("month")) d.setMonth(d.getMonth() + n);
    push(m[0], d.toISOString().slice(0, 10));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

function extractDestinations(text: string): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  DESTINATION_REGEX.lastIndex = 0;
  while ((m = DESTINATION_REGEX.exec(text)) !== null) {
    const raw = m[1];
    const canonical = raw
      .split(/\s+/)
      .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ type: "destination", value: raw, normalized: canonical });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Amounts / Currency
// ---------------------------------------------------------------------------

function extractAmounts(text: string): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();

  function push(raw: string, normalized: string) {
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ type: "amount", value: raw, normalized });
  }

  // Symbol + number: $500, $2000, EUR1,200, GBP50.5
  // The pattern uses \d+ first to greedily match full numbers like 2000,
  // then optionally matches decimal parts. Thousands-grouped numbers (1,200)
  // are handled by the comma-separated alternative.
  const symbolRe = /([$\u20AC\u00A3\u00A5\u20B9])\s?(\d+(?:[,\s]\d{3})*(?:\.\d+)?)\s?([kKmM])?/g;
  let m: RegExpExecArray | null;
  while ((m = symbolRe.exec(text)) !== null) {
    const symbol = m[1];
    let num = parseFloat(m[2].replace(/[,\s]/g, ""));
    if (m[3]) {
      if (m[3].toLowerCase() === "k") num *= 1000;
      if (m[3].toLowerCase() === "m") num *= 1_000_000;
    }
    const currency =
      symbol === "$" ? "USD"
        : symbol === "\u20AC" ? "EUR"
        : symbol === "\u00A3" ? "GBP"
        : symbol === "\u00A5" ? "JPY"
        : symbol === "\u20B9" ? "INR"
        : "USD";
    push(m[0], `${num} ${currency}`);
  }

  // Number + currency code: 500 USD, 1200 eur
  const codeRe = /\b(\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s?([kKmM])?\s?(USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|KRW)\b/gi;
  while ((m = codeRe.exec(text)) !== null) {
    let num = parseFloat(m[1].replace(/[,\s]/g, ""));
    if (m[2]) {
      if (m[2].toLowerCase() === "k") num *= 1000;
      if (m[2].toLowerCase() === "m") num *= 1_000_000;
    }
    push(m[0], `${num} ${m[3].toUpperCase()}`);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

function extractDurations(text: string): Entity[] {
  const out: Entity[] = [];
  const re = /\b(\d+|a|an|two|three|four|five|six|seven|eight|nine|ten)\s+(day|days|night|nights|week|weeks|month|months|year|years|hour|hours)\b/gi;
  const wordToNum: Record<string, number> = {
    a: 1, an: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(text)) !== null) {
    const numPart = m[1].toLowerCase();
    const n = /^\d+$/.test(numPart) ? parseInt(numPart, 10) : wordToNum[numPart];
    if (!n) continue;
    let unit = m[2].toLowerCase().replace(/s$/, "");
    if (unit === "night") unit = "day";
    const normalized = `${n} ${unit}${n > 1 ? "s" : ""}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ type: "duration", value: m[0], normalized });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Technologies
// ---------------------------------------------------------------------------

function extractTechnologies(text: string): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  TECH_REGEX.lastIndex = 0;
  while ((m = TECH_REGEX.exec(text)) !== null) {
    const raw = m[1];
    const lower = raw.toLowerCase().replace(/\\/g, "");
    if (seen.has(lower)) continue;
    seen.add(lower);

    // Determine if it's a programming language or a technology
    const entityType: EntityType = PROGRAMMING_LANGUAGES.has(lower) ? "language" : "technology";
    out.push({ type: entityType, value: raw, normalized: raw });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Extracts structured entities from free-form text.
 * Covers: dates, destinations, amounts, durations, technologies, programming languages.
 */
export function extractEntities(text: string, now: Date = new Date()): Entity[] {
  return [
    ...extractDates(text, now),
    ...extractDestinations(text),
    ...extractAmounts(text),
    ...extractDurations(text),
    ...extractTechnologies(text),
  ];
}
