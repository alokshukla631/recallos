import { useState, useEffect } from "react";
import "./Scraper.css";

interface Source {
  name: string;
  available: boolean;
  path: string | null;
  lastScraped: string | null;
}

interface ScrapeResultItem {
  source: string;
  messagesFound: number;
  messagesNew: number;
  memoryExtracted: number;
  errors: string[];
}

interface ScrapeResponse {
  scraped_at: string;
  results: ScrapeResultItem[];
}

const SOURCE_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  chatgpt: "ChatGPT",
  windsurf: "Windsurf",
};

const SOURCE_DESCRIPTIONS: Record<string, string> = {
  "claude-code": "Reads JSONL transcripts from ~/.claude/projects/",
  cursor: "Reads SQLite composer data from Cursor state",
  chatgpt: "Reads conversations.json export from ChatGPT (Settings > Export data)",
  windsurf: "Reads SQLite conversation data from Windsurf state",
};

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function Scraper() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [lastResult, setLastResult] = useState<ScrapeResponse | null>(null);
  const [scrapeHistory, setScrapeHistory] = useState<ScrapeResponse[]>([]);

  useEffect(() => {
    fetchSources();
  }, []);

  async function fetchSources() {
    setLoading(true);
    try {
      const res = await fetch("/api/scraper/sources");
      if (!res.ok) throw new Error("Failed to fetch");
      setSources(await res.json());
    } catch {
      setSources([]);
    } finally {
      setLoading(false);
    }
  }

  async function runScrape() {
    setScraping(true);
    setLastResult(null);
    try {
      const res = await fetch("/api/scraper/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("Scrape failed");
      const data: ScrapeResponse = await res.json();
      setLastResult(data);
      setScrapeHistory((prev) => [data, ...prev].slice(0, 10));
      await fetchSources();
    } catch {
      setLastResult(null);
    } finally {
      setScraping(false);
    }
  }

  const availableCount = sources.filter((s) => s.available).length;
  const totalExtracted = lastResult
    ? lastResult.results.reduce((sum, r) => sum + r.memoryExtracted, 0)
    : 0;
  const totalNew = lastResult
    ? lastResult.results.reduce((sum, r) => sum + r.messagesNew, 0)
    : 0;

  return (
    <div className="scraper-page">
      <h2>Log Scraper</h2>
      <p>
        Scrape chat logs from local AI tools to extract memory from
        conversations that happened outside RecallOS.
      </p>

      {/* Stats bar */}
      {!loading && (
        <div className="scraper-stats-bar">
          <div className="scraper-stat">
            <span className="scraper-stat-value">{availableCount}</span>
            <span className="scraper-stat-label">Sources found</span>
          </div>
          <div className="scraper-stat">
            <span className="scraper-stat-value">{sources.length}</span>
            <span className="scraper-stat-label">Total sources</span>
          </div>
          <div className="scraper-stat">
            <span className="scraper-stat-value">{scrapeHistory.length}</span>
            <span className="scraper-stat-label">Scrapes this session</span>
          </div>
        </div>
      )}

      <div className="scraper-section">
        <h3>Sources</h3>
        {loading ? (
          <p className="muted">Loading...</p>
        ) : sources.length === 0 ? (
          <p className="muted">No sources detected.</p>
        ) : (
          <div className="sources-list">
            {sources.map((s) => (
              <div key={s.name} className={`source-card ${s.available ? "source-available" : ""}`}>
                <div className="source-header">
                  <span className="source-name">{SOURCE_LABELS[s.name] || s.name}</span>
                  <span
                    className={`source-badge ${s.available ? "available" : "unavailable"}`}
                  >
                    {s.available ? "Available" : "Not found"}
                  </span>
                </div>
                <div className="source-description">
                  {SOURCE_DESCRIPTIONS[s.name] || ""}
                </div>
                {s.path && (
                  <div className="source-path">{s.path}</div>
                )}
                <div className="source-meta">
                  {s.lastScraped
                    ? `Last scraped: ${timeAgo(s.lastScraped)} (${new Date(s.lastScraped).toLocaleString()})`
                    : "Never scraped"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="scraper-section">
        <h3>Run Scraper</h3>
        <p className="muted">
          Scan all available sources for new conversations and extract memory.
          Only user messages from new or modified files are processed.
        </p>
        <button
          className="btn btn-primary"
          onClick={runScrape}
          disabled={scraping || availableCount === 0}
        >
          {scraping ? "Scraping..." : `Scrape ${availableCount} Source${availableCount !== 1 ? "s" : ""}`}
        </button>
        {availableCount === 0 && !loading && (
          <p className="scraper-no-sources">
            No available sources detected. Install Claude Code, Cursor, Windsurf, or
            export your ChatGPT data to get started.
          </p>
        )}

        {lastResult && (
          <div className="scrape-results">
            <div className="scrape-results-header">
              <h4>Latest Results</h4>
              <span className="scrape-time">
                {new Date(lastResult.scraped_at).toLocaleString()}
              </span>
            </div>

            {/* Summary bar */}
            <div className="scrape-summary">
              <span className="scrape-summary-item">
                <strong>{totalNew}</strong> new messages
              </span>
              <span className="scrape-summary-item">
                <strong>{totalExtracted}</strong> memories extracted
              </span>
            </div>

            {lastResult.results.map((r) => (
              <div
                key={r.source}
                className={`result-card ${r.memoryExtracted > 0 ? "result-has-data" : ""}`}
              >
                <div className="result-header">
                  <span>{SOURCE_LABELS[r.source] || r.source}</span>
                  {r.memoryExtracted > 0 && (
                    <span className="result-extracted-badge">
                      +{r.memoryExtracted} memories
                    </span>
                  )}
                </div>
                <div className="result-stats">
                  <span>Messages: {r.messagesFound}</span>
                  <span>New: {r.messagesNew}</span>
                  <span>Extracted: {r.memoryExtracted}</span>
                </div>
                {r.errors.length > 0 && (
                  <div className="result-errors">
                    {r.errors.map((e, i) => (
                      <span key={i} className="error-text">{e}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Scrape history */}
      {scrapeHistory.length > 1 && (
        <div className="scraper-section">
          <h3>Session History</h3>
          <div className="scrape-history">
            {scrapeHistory.slice(1).map((entry, i) => {
              const extracted = entry.results.reduce((sum, r) => sum + r.memoryExtracted, 0);
              const newMsgs = entry.results.reduce((sum, r) => sum + r.messagesNew, 0);
              return (
                <div key={i} className="history-item">
                  <span className="history-time">{timeAgo(entry.scraped_at)}</span>
                  <span className="history-detail">
                    {newMsgs} new messages, {extracted} memories extracted
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default Scraper;
