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

function Scraper() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [lastResult, setLastResult] = useState<ScrapeResponse | null>(null);

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
      await fetchSources();
    } catch {
      setLastResult(null);
    } finally {
      setScraping(false);
    }
  }

  return (
    <div className="scraper-page">
      <h2>Log Scraper</h2>
      <p>
        Scrape chat logs from local AI tools to extract memory from
        conversations that happened outside RecallOS.
      </p>

      <div className="scraper-section">
        <h3>Sources</h3>
        {loading ? (
          <p className="muted">Loading...</p>
        ) : sources.length === 0 ? (
          <p className="muted">No sources detected.</p>
        ) : (
          <div className="sources-list">
            {sources.map((s) => (
              <div key={s.name} className="source-card">
                <div className="source-header">
                  <span className="source-name">{s.name}</span>
                  <span
                    className={`source-badge ${s.available ? "available" : "unavailable"}`}
                  >
                    {s.available ? "Available" : "Not found"}
                  </span>
                </div>
                {s.path && (
                  <div className="source-path">{s.path}</div>
                )}
                <div className="source-meta">
                  {s.lastScraped
                    ? `Last scraped: ${new Date(s.lastScraped).toLocaleString()}`
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
        </p>
        <button
          className="btn btn-primary"
          onClick={runScrape}
          disabled={scraping}
        >
          {scraping ? "Scraping..." : "Scrape Now"}
        </button>

        {lastResult && (
          <div className="scrape-results">
            <h4>Results</h4>
            <p className="muted">
              Scraped at {new Date(lastResult.scraped_at).toLocaleString()}
            </p>
            {lastResult.results.map((r) => (
              <div key={r.source} className="result-card">
                <div className="result-header">{r.source}</div>
                <div className="result-stats">
                  <span>Messages found: {r.messagesFound}</span>
                  <span>New: {r.messagesNew}</span>
                  <span>Memory extracted: {r.memoryExtracted}</span>
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
    </div>
  );
}

export default Scraper;
