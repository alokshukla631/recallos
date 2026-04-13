import { useState, useEffect } from "react";
import "./MemoryDetailModal.css";

interface ImportanceFactors {
  confidence_score: number;
  recency_score: number;
  link_score: number;
  tag_score: number;
  age_bonus: number;
  total: number;
}

interface AuditEntry {
  id: string;
  action: string;
  details: string;
  created_at: string;
}

interface LinkEntry {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  strength: number;
  note: string | null;
  created_at: string;
}

interface VersionEntry {
  id: string;
  version_number: number;
  value: string;
  confidence: number;
  changed_by: string;
  created_at: string;
}

interface MemoryDetail {
  id: string;
  key: string;
  type: string;
  value: string;
  scope: string;
  domain: string | null;
  confidence: number;
  authority: string;
  status: string;
  pinned: number;
  created_at: string;
  last_confirmed_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  importance: ImportanceFactors;
  tags: Array<{ tag: string }>;
  links: LinkEntry[];
  audit: AuditEntry[];
  versions: VersionEntry[];
  superseded_by_item: { id: string; key: string; value: string } | null;
  supersedes: Array<{ id: string; key: string; value: string }>;
  context_appearances: number;
}

interface Props {
  itemId: number | string;
  onClose: () => void;
  onAction?: () => void;
}

function MemoryDetailModal({ itemId, onClose, onAction }: Props) {
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [linkTarget, setLinkTarget] = useState("");
  const [linkRelation, setLinkRelation] = useState("related_to");

  useEffect(() => {
    fetchDetail();
  }, [itemId]);

  async function fetchDetail() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/memory/${itemId}/detail`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail(await res.json());
    } catch (err: any) {
      setError(err.message || "Failed to load details");
    } finally {
      setLoading(false);
    }
  }

  async function handlePin() {
    if (!detail) return;
    const endpoint = detail.pinned ? "unpin" : "pin";
    await fetch(`/api/memory/${itemId}/${endpoint}`, { method: "POST" });
    fetchDetail();
    onAction?.();
  }

  async function handleReconfirm() {
    await fetch(`/api/memory/${itemId}/reconfirm`, { method: "POST" });
    fetchDetail();
    onAction?.();
  }

  async function handleAddTag() {
    const tag = tagInput.trim().toLowerCase();
    if (!tag) return;
    await fetch(`/api/memory/${itemId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag }),
    });
    setTagInput("");
    fetchDetail();
  }

  async function handleRemoveTag(tag: string) {
    await fetch(`/api/memory/${itemId}/tags/${encodeURIComponent(tag)}`, { method: "DELETE" });
    fetchDetail();
  }

  async function handleAddLink() {
    const target = linkTarget.trim();
    if (!target) return;
    await fetch(`/api/memory/${itemId}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_id: target, relation: linkRelation }),
    });
    setLinkTarget("");
    fetchDetail();
  }

  async function handleRevert(versionId: string) {
    await fetch(`/api/memory/${itemId}/revert/${versionId}`, { method: "POST" });
    fetchDetail();
    onAction?.();
  }

  async function handleRemoveLink(linkId: string) {
    await fetch(`/api/memory/links/${linkId}`, { method: "DELETE" });
    fetchDetail();
  }

  function formatDate(d: string | null) {
    if (!d) return "Never";
    return new Date(d).toLocaleString();
  }

  function timeAgo(d: string) {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content detail-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>x</button>

        {loading && <div className="detail-loading">Loading...</div>}
        {error && <div className="detail-error">{error}</div>}

        {detail && (
          <>
            {/* Header */}
            <div className="detail-header">
              <div className="detail-key-row">
                {detail.pinned ? <span className="detail-pin-icon">&#128204;</span> : null}
                <h3 className="detail-key">{detail.key}</h3>
                <span className={`detail-status status-${detail.status}`}>{detail.status}</span>
              </div>
              <div className="detail-meta-row">
                <span className="detail-type" data-type={detail.type}>{detail.type}</span>
                <span className="detail-scope">{detail.scope}</span>
                {detail.domain && <span className="detail-domain">{detail.domain}</span>}
                <span className="detail-id">ID: {String(detail.id).slice(0, 8)}</span>
              </div>
            </div>

            {/* Value */}
            <div className="detail-value-section">
              <div className="detail-value">{detail.value}</div>
              <button
                className="detail-copy-btn"
                onClick={() => {
                  navigator.clipboard.writeText(detail.value);
                }}
                title="Copy value"
              >
                Copy
              </button>
            </div>

            {/* Quick actions */}
            <div className="detail-actions">
              <button className="btn-detail" onClick={handlePin}>
                {detail.pinned ? "Unpin" : "Pin"}
              </button>
              <button className="btn-detail btn-detail-confirm" onClick={handleReconfirm}>
                Reconfirm
              </button>
            </div>

            {/* Importance breakdown */}
            <div className="detail-section">
              <h4>Importance Score: {detail.importance.total}/100</h4>
              <div className="importance-breakdown">
                <div className="importance-factor">
                  <span className="factor-label">Confidence</span>
                  <div className="factor-bar">
                    <div className="factor-fill" style={{ width: `${(detail.importance.confidence_score / 30) * 100}%` }} />
                  </div>
                  <span className="factor-value">{detail.importance.confidence_score}/30</span>
                </div>
                <div className="importance-factor">
                  <span className="factor-label">Recency</span>
                  <div className="factor-bar">
                    <div className="factor-fill" style={{ width: `${(detail.importance.recency_score / 25) * 100}%` }} />
                  </div>
                  <span className="factor-value">{detail.importance.recency_score}/25</span>
                </div>
                <div className="importance-factor">
                  <span className="factor-label">Links</span>
                  <div className="factor-bar">
                    <div className="factor-fill" style={{ width: `${(detail.importance.link_score / 20) * 100}%` }} />
                  </div>
                  <span className="factor-value">{detail.importance.link_score}/20</span>
                </div>
                <div className="importance-factor">
                  <span className="factor-label">Tags</span>
                  <div className="factor-bar">
                    <div className="factor-fill" style={{ width: `${(detail.importance.tag_score / 15) * 100}%` }} />
                  </div>
                  <span className="factor-value">{detail.importance.tag_score}/15</span>
                </div>
                <div className="importance-factor">
                  <span className="factor-label">Age bonus</span>
                  <div className="factor-bar">
                    <div className="factor-fill" style={{ width: `${(detail.importance.age_bonus / 10) * 100}%` }} />
                  </div>
                  <span className="factor-value">{detail.importance.age_bonus}/10</span>
                </div>
              </div>
            </div>

            {/* Metadata */}
            <div className="detail-section">
              <h4>Metadata</h4>
              <div className="detail-meta-grid">
                <div className="meta-item">
                  <span className="meta-label">Confidence</span>
                  <span className="meta-value">{Math.round(detail.confidence * 100)}%</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Authority</span>
                  <span className="meta-value">{detail.authority}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Created</span>
                  <span className="meta-value" title={formatDate(detail.created_at)}>{timeAgo(detail.created_at)}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Last confirmed</span>
                  <span className="meta-value" title={formatDate(detail.last_confirmed_at)}>
                    {detail.last_confirmed_at ? timeAgo(detail.last_confirmed_at) : "Never"}
                  </span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Context appearances</span>
                  <span className="meta-value">{detail.context_appearances}</span>
                </div>
                {detail.valid_from && (
                  <div className="meta-item">
                    <span className="meta-label">Valid from</span>
                    <span className="meta-value">{formatDate(detail.valid_from)}</span>
                  </div>
                )}
                {detail.valid_to && (
                  <div className="meta-item">
                    <span className="meta-label">Valid to</span>
                    <span className="meta-value">{formatDate(detail.valid_to)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Tags */}
            <div className="detail-section">
              <h4>Tags ({detail.tags.length})</h4>
              <div className="detail-tags">
                {detail.tags.map((t) => (
                  <span key={t.tag} className="detail-tag">
                    {t.tag}
                    <button onClick={() => handleRemoveTag(t.tag)}>x</button>
                  </span>
                ))}
                <div className="detail-tag-add">
                  <input
                    type="text"
                    placeholder="Add tag..."
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddTag(); }}
                  />
                  <button onClick={handleAddTag}>+</button>
                </div>
              </div>
            </div>

            {/* Links */}
            <div className="detail-section">
              <h4>Links ({detail.links.length})</h4>
              {detail.links.length > 0 && (
                <div className="detail-links">
                  {detail.links.map((link) => (
                    <div key={link.id} className="detail-link">
                      <span className="link-relation">{link.relation}</span>
                      <span className="link-target">
                        {link.source_id === String(itemId) ? link.target_id.slice(0, 8) : link.source_id.slice(0, 8)}
                      </span>
                      {link.note && <span className="link-note">{link.note}</span>}
                      <button className="link-remove" onClick={() => handleRemoveLink(link.id)}>x</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="detail-link-add">
                <input
                  type="text"
                  placeholder="Target item ID..."
                  value={linkTarget}
                  onChange={(e) => setLinkTarget(e.target.value)}
                />
                <select value={linkRelation} onChange={(e) => setLinkRelation(e.target.value)}>
                  <option value="related_to">related_to</option>
                  <option value="depends_on">depends_on</option>
                  <option value="conflicts_with">conflicts_with</option>
                  <option value="refines">refines</option>
                  <option value="derived_from">derived_from</option>
                </select>
                <button onClick={handleAddLink}>Link</button>
              </div>
            </div>

            {/* Supersession info */}
            {(detail.superseded_by_item || detail.supersedes.length > 0) && (
              <div className="detail-section">
                <h4>Supersession</h4>
                {detail.superseded_by_item && (
                  <div className="supersession-info">
                    <span className="supersession-label">Superseded by:</span>
                    <span className="supersession-item">{detail.superseded_by_item.key} - {detail.superseded_by_item.value.slice(0, 60)}</span>
                  </div>
                )}
                {detail.supersedes.length > 0 && (
                  <div className="supersession-info">
                    <span className="supersession-label">Supersedes:</span>
                    {detail.supersedes.map((s) => (
                      <span key={s.id} className="supersession-item">{s.key} - {s.value.slice(0, 60)}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Version history */}
            {detail.versions && detail.versions.length > 0 && (
              <div className="detail-section">
                <h4>Version History ({detail.versions.length})</h4>
                <div className="detail-versions">
                  {detail.versions.map((v) => (
                    <div key={v.id} className="version-entry">
                      <div className="version-header">
                        <span className="version-number">v{v.version_number}</span>
                        <span className="version-by">{v.changed_by}</span>
                        <span className="version-time" title={formatDate(v.created_at)}>{timeAgo(v.created_at)}</span>
                        <button className="version-revert" onClick={() => handleRevert(v.id)}>Revert</button>
                      </div>
                      <div className="version-value">{v.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Audit history */}
            <div className="detail-section">
              <h4>Audit History ({detail.audit.length})</h4>
              {detail.audit.length === 0 ? (
                <p className="detail-muted">No audit entries.</p>
              ) : (
                <div className="detail-audit">
                  {detail.audit.slice(0, 20).map((entry) => (
                    <div key={entry.id} className="audit-entry">
                      <span className={`audit-action audit-${entry.action}`}>{entry.action}</span>
                      <span className="audit-details">{entry.details}</span>
                      <span className="audit-time" title={formatDate(entry.created_at)}>{timeAgo(entry.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default MemoryDetailModal;
