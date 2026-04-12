/**
 * BM25 ranking for memory retrieval.
 *
 * BM25 is a bag-of-words ranking function used by search engines to estimate
 * the relevance of documents to a given search query. It is a significant
 * upgrade over simple keyword overlap because it:
 *
 *   1. Penalizes terms that appear in many documents (IDF)
 *   2. Normalizes for document length (so long memory items don't dominate)
 *   3. Saturates term frequency (diminishing returns for repeated terms)
 *
 * Reference: https://en.wikipedia.org/wiki/Okapi_BM25
 */

const K1 = 1.5; // term frequency saturation
const B = 0.75; // length normalization

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "he", "her", "him", "his", "i", "in", "is", "it", "its",
  "me", "my", "of", "on", "or", "our", "she", "that", "the", "their",
  "them", "they", "this", "to", "was", "we", "were", "will", "with", "you",
  "your", "would", "could", "should", "do", "did", "does", "been", "being",
]);

export interface Document {
  id: string;
  text: string;
}

export interface ScoredDocument {
  id: string;
  score: number;
}

/**
 * Lightweight suffix stripper. Not a full Porter stemmer, but enough to fold
 * common plural/verb forms (seat/seats, book/booking/booked, fly/flying/flies)
 * together so BM25 retrieval isn't defeated by morphology.
 */
function stem(word: string): string {
  if (word.length <= 3) return word;
  // Order matters: strip longer suffixes first
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

/**
 * Tokenizes text into lowercase stemmed words, removing punctuation and stopwords.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * Builds an inverted index from a set of documents. Returns a map from term
 * to the set of document ids containing that term, plus document lengths.
 */
function buildIndex(docs: Document[]) {
  const termToDocs = new Map<string, Set<string>>();
  const docLengths = new Map<string, number>();
  const docTerms = new Map<string, Map<string, number>>();

  for (const doc of docs) {
    const terms = tokenize(doc.text);
    docLengths.set(doc.id, terms.length);

    const termFreq = new Map<string, number>();
    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
      if (!termToDocs.has(term)) termToDocs.set(term, new Set());
      termToDocs.get(term)!.add(doc.id);
    }
    docTerms.set(doc.id, termFreq);
  }

  const avgDocLength =
    docs.length > 0
      ? [...docLengths.values()].reduce((a, b) => a + b, 0) / docs.length
      : 0;

  return { termToDocs, docLengths, docTerms, avgDocLength, totalDocs: docs.length };
}

/**
 * Computes BM25 score for a query against a set of documents.
 * Returns documents with their scores, sorted descending by score.
 * Documents with score 0 are included so callers can decide what to do.
 */
export function bm25Rank(query: string, docs: Document[]): ScoredDocument[] {
  if (docs.length === 0) return [];

  const index = buildIndex(docs);
  const queryTerms = tokenize(query);

  if (queryTerms.length === 0) {
    return docs.map((d) => ({ id: d.id, score: 0 }));
  }

  const scores = new Map<string, number>();
  for (const doc of docs) scores.set(doc.id, 0);

  for (const term of queryTerms) {
    const docsWithTerm = index.termToDocs.get(term);
    if (!docsWithTerm) continue;

    // IDF: inverse document frequency
    // Uses the smoothed Okapi BM25 variant so the value stays non-negative
    // even when a term appears in the majority of documents.
    const df = docsWithTerm.size;
    const idf = Math.log(1 + (index.totalDocs - df + 0.5) / (df + 0.5));

    for (const docId of docsWithTerm) {
      const termFreq = index.docTerms.get(docId)?.get(term) ?? 0;
      const docLength = index.docLengths.get(docId) ?? 0;
      const norm = 1 - B + B * (docLength / (index.avgDocLength || 1));
      const tfComponent = (termFreq * (K1 + 1)) / (termFreq + K1 * norm);

      scores.set(docId, (scores.get(docId) ?? 0) + idf * tfComponent);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Compute Levenshtein edit distance between two strings.
 * Used for fuzzy matching when BM25 returns no results.
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Fuzzy search: finds documents that contain words similar to query words.
 * Used as a fallback when BM25 yields zero results.
 * Returns documents scored by best fuzzy match quality.
 */
export function fuzzySearch(query: string, docs: Document[], maxDistance: number = 2): ScoredDocument[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || docs.length === 0) return [];

  const scores = new Map<string, number>();

  for (const doc of docs) {
    const docTerms = tokenize(doc.text);
    let totalScore = 0;

    for (const qt of queryTerms) {
      let bestMatch = Infinity;
      for (const dt of docTerms) {
        // Quick skip if lengths are too different
        if (Math.abs(qt.length - dt.length) > maxDistance) continue;
        const dist = editDistance(qt, dt);
        if (dist < bestMatch) bestMatch = dist;
        if (dist === 0) break;
      }

      if (bestMatch <= maxDistance) {
        // Score: closer match = higher score
        totalScore += (maxDistance + 1 - bestMatch) / (maxDistance + 1);
      }
    }

    if (totalScore > 0) {
      // Normalize by query term count
      scores.set(doc.id, totalScore / queryTerms.length);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);
}
