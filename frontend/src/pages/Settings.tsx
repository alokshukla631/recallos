import { useState, useEffect } from "react";
import "./Settings.css";

interface Provider {
  provider: string;
  is_default: boolean;
}

const ALL_PROVIDERS = ["openai", "anthropic", "gemini", "ollama"];

interface McpConfig {
  config: { command: string; args: string[]; env?: Record<string, string> };
  claude_desktop_config_path: string | null;
}

interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  created_at: string;
}

interface DeliveryEntry {
  webhook_id: string;
  url: string;
  event: string;
  status: number | null;
  success: boolean;
  timestamp: string;
  error?: string;
}

interface DecayCandidate {
  id: string;
  key: string;
  value: string;
  type: string;
  reason: string;
  importance: number;
}

function Settings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [defaultProvider, setDefaultProvider] = useState("");
  const [statusMessages, setStatusMessages] = useState<
    Record<string, { text: string; type: "success" | "error" }>
  >({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null);
  const [mcpInstalling, setMcpInstalling] = useState(false);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [isCustomPrompt, setIsCustomPrompt] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);

  // Decay state
  const [decayCandidates, setDecayCandidates] = useState<DecayCandidate[] | null>(null);
  const [decayLoading, setDecayLoading] = useState(false);
  const [decayApplying, setDecayApplying] = useState(false);

  // Delivery log
  const [deliveryLog, setDeliveryLog] = useState<DeliveryEntry[]>([]);
  const [showDeliveryLog, setShowDeliveryLog] = useState(false);

  // DB stats
  const [dbStats, setDbStats] = useState<Record<string, number> | null>(null);

  // Scheduled tasks
  const [scheduledTasks, setScheduledTasks] = useState<Array<{
    name: string;
    last_run: string | null;
    interval_human: string;
    enabled: boolean;
  }> | null>(null);

  // Clear data
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState("");
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    fetchProviders();
    fetchMcpConfig();
    fetchWebhooks();
    fetchSystemPrompt();
    fetchDbStats();
    fetchScheduledTasks();
  }, []);

  async function fetchProviders() {
    setLoadingProviders(true);
    try {
      const res = await fetch("/api/settings/providers");
      if (!res.ok) throw new Error("Failed to fetch");
      const data: Provider[] = await res.json();
      setProviders(data);
      const def = data.find((p) => p.is_default);
      if (def) setDefaultProvider(def.provider);
    } catch {
      setProviders([]);
    } finally {
      setLoadingProviders(false);
    }
  }

  function isConfigured(provider: string) {
    return providers.some((p) => p.provider === provider);
  }

  function isDefault(provider: string) {
    return providers.some((p) => p.provider === provider && p.is_default);
  }

  function showStatus(
    key: string,
    text: string,
    type: "success" | "error"
  ) {
    setStatusMessages((prev) => ({ ...prev, [key]: { text, type } }));
    setTimeout(() => {
      setStatusMessages((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, 3000);
  }

  async function saveApiKey(provider: string) {
    const key = apiKeys[provider]?.trim();
    if (!key) return;

    setSaving((prev) => ({ ...prev, [provider]: true }));
    try {
      const res = await fetch(`/api/settings/providers/${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to save");
      }

      setApiKeys((prev) => ({ ...prev, [provider]: "" }));
      showStatus(provider, "API key saved successfully", "success");
      await fetchProviders();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save";
      showStatus(provider, msg, "error");
    } finally {
      setSaving((prev) => ({ ...prev, [provider]: false }));
    }
  }

  async function deleteProvider(provider: string) {
    setSaving((prev) => ({ ...prev, [`${provider}-del`]: true }));
    try {
      const res = await fetch(`/api/settings/providers/${provider}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to delete");
      }

      showStatus(provider, "Provider removed", "success");
      await fetchProviders();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete";
      showStatus(provider, msg, "error");
    } finally {
      setSaving((prev) => ({ ...prev, [`${provider}-del`]: false }));
    }
  }

  async function setDefault(provider: string) {
    try {
      const res = await fetch("/api/settings/providers/default", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to set default");
      }

      setDefaultProvider(provider);
      showStatus("default", "Default provider updated", "success");
      await fetchProviders();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to set default";
      showStatus("default", msg, "error");
    }
  }

  async function fetchMcpConfig() {
    try {
      const res = await fetch("/api/settings/mcp/config");
      if (!res.ok) throw new Error("Failed");
      setMcpConfig(await res.json());
    } catch {
      setMcpConfig(null);
    }
  }

  async function installMcp() {
    setMcpInstalling(true);
    try {
      const res = await fetch("/api/settings/mcp/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Install failed");
      showStatus("mcp", data.message || "MCP config installed", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Install failed";
      showStatus("mcp", msg, "error");
    } finally {
      setMcpInstalling(false);
    }
  }

  async function fetchWebhooks() {
    try {
      const res = await fetch("/api/settings/webhooks");
      if (!res.ok) return;
      setWebhooks(await res.json());
    } catch {
      // ignore
    }
  }

  async function addWebhook() {
    const url = newWebhookUrl.trim();
    if (!url) return;
    try {
      const res = await fetch("/api/settings/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, events: ["*"] }),
      });
      if (!res.ok) throw new Error("Failed to add webhook");
      setNewWebhookUrl("");
      showStatus("webhooks", "Webhook added", "success");
      fetchWebhooks();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      showStatus("webhooks", msg, "error");
    }
  }

  async function fetchDeliveryLog() {
    try {
      const res = await fetch("/api/settings/webhooks/log?limit=50");
      if (!res.ok) return;
      setDeliveryLog(await res.json());
      setShowDeliveryLog(true);
    } catch {
      // ignore
    }
  }

  async function toggleWebhookActive(id: string, active: boolean) {
    try {
      await fetch(`/api/settings/webhooks/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      fetchWebhooks();
    } catch {
      // ignore
    }
  }

  async function deleteWebhookById(id: string) {
    try {
      await fetch(`/api/settings/webhooks/${id}`, { method: "DELETE" });
      showStatus("webhooks", "Webhook deleted", "success");
      fetchWebhooks();
    } catch {
      showStatus("webhooks", "Delete failed", "error");
    }
  }

  async function fetchSystemPrompt() {
    try {
      const res = await fetch("/api/settings/system-prompt");
      if (!res.ok) return;
      const data = await res.json();
      setSystemPrompt(data.prompt);
      setIsCustomPrompt(data.is_custom);
    } catch {
      // ignore
    }
  }

  async function saveSystemPrompt() {
    setSavingPrompt(true);
    try {
      const res = await fetch("/api/settings/system-prompt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: systemPrompt }),
      });
      if (!res.ok) throw new Error("Failed to save");
      showStatus("prompt", "System prompt saved", "success");
      setIsCustomPrompt(true);
    } catch {
      showStatus("prompt", "Failed to save prompt", "error");
    } finally {
      setSavingPrompt(false);
    }
  }

  async function resetSystemPrompt() {
    try {
      await fetch("/api/settings/system-prompt", { method: "DELETE" });
      showStatus("prompt", "System prompt reset to default", "success");
      fetchSystemPrompt();
    } catch {
      showStatus("prompt", "Reset failed", "error");
    }
  }

  async function fetchDbStats() {
    try {
      const res = await fetch("/api/settings/stats");
      if (!res.ok) return;
      setDbStats(await res.json());
    } catch {
      // ignore
    }
  }

  async function fetchScheduledTasks() {
    try {
      const res = await fetch("/api/settings/scheduled-tasks");
      if (!res.ok) return;
      setScheduledTasks(await res.json());
    } catch {
      // ignore
    }
  }

  async function clearAllData() {
    if (clearConfirmText !== "DELETE") return;
    setClearing(true);
    try {
      const res = await fetch("/api/settings/clear-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE_ALL_DATA" }),
      });
      if (!res.ok) throw new Error("Failed to clear");
      showStatus("clear", "All data has been cleared", "success");
      setShowClearConfirm(false);
      setClearConfirmText("");
      fetchDbStats();
      fetchProviders();
      fetchWebhooks();
    } catch {
      showStatus("clear", "Failed to clear data", "error");
    } finally {
      setClearing(false);
    }
  }

  async function previewDecay() {
    setDecayLoading(true);
    try {
      const res = await fetch("/api/memory/decay");
      if (!res.ok) throw new Error("Failed to fetch decay preview");
      const data = await res.json();
      setDecayCandidates(data.candidates);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      showStatus("decay", msg, "error");
    } finally {
      setDecayLoading(false);
    }
  }

  async function applyDecayNow() {
    setDecayApplying(true);
    try {
      const res = await fetch("/api/memory/decay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("Failed to apply decay");
      const data = await res.json();
      showStatus("decay", `Marked ${data.marked} items as stale`, "success");
      setDecayCandidates(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      showStatus("decay", msg, "error");
    } finally {
      setDecayApplying(false);
    }
  }

  const configuredProviders = providers.map((p) => p.provider);

  return (
    <div className="settings-page">
      <h2>Settings</h2>
      <p>Manage your AI providers and application configuration.</p>

      {loadingProviders ? (
        <p>Loading...</p>
      ) : (
        <>
          <div className="settings-section">
            <h3>Provider API Keys</h3>

            {ALL_PROVIDERS.map((provider) => (
              <div key={provider} className="provider-card">
                <div className="provider-card-header">
                  <span className="provider-name">{provider}</span>
                  {isDefault(provider) && (
                    <span className="default-badge">Default</span>
                  )}
                  {isConfigured(provider) ? (
                    <span className="configured-badge">Configured</span>
                  ) : (
                    <span className="not-configured-badge">
                      Not configured
                    </span>
                  )}
                </div>

                <div className="provider-card-form">
                  <input
                    type="password"
                    placeholder={
                      isConfigured(provider)
                        ? "Enter new key to update..."
                        : "Enter API key..."
                    }
                    value={apiKeys[provider] || ""}
                    onChange={(e) =>
                      setApiKeys((prev) => ({
                        ...prev,
                        [provider]: e.target.value,
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveApiKey(provider);
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() => saveApiKey(provider)}
                    disabled={
                      !apiKeys[provider]?.trim() || saving[provider]
                    }
                  >
                    {saving[provider] ? "Saving..." : "Save"}
                  </button>
                  {isConfigured(provider) && (
                    <button
                      className="btn btn-danger"
                      onClick={() => deleteProvider(provider)}
                      disabled={saving[`${provider}-del`]}
                    >
                      {saving[`${provider}-del`]
                        ? "Removing..."
                        : "Remove"}
                    </button>
                  )}
                </div>

                {statusMessages[provider] && (
                  <p
                    className={`status-msg ${statusMessages[provider].type}`}
                  >
                    {statusMessages[provider].text}
                  </p>
                )}
              </div>
            ))}
          </div>

          {configuredProviders.length > 0 && (
            <div className="settings-section">
              <h3>Default Provider</h3>
              <div className="default-provider-row">
                <select
                  value={defaultProvider}
                  onChange={(e) => setDefault(e.target.value)}
                >
                  <option value="" disabled>
                    Select a provider
                  </option>
                  {configuredProviders.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              {statusMessages["default"] && (
                <p
                  className={`status-msg ${statusMessages["default"].type}`}
                >
                  {statusMessages["default"].text}
                </p>
              )}
            </div>
          )}

          <div className="settings-section data-section">
            <h3>System Prompt</h3>
            <p>
              Customize the system instructions sent to the AI provider with every message.
            </p>
            <textarea
              className="system-prompt-textarea"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={5}
            />
            <div className="passport-actions">
              <button className="btn btn-primary" onClick={saveSystemPrompt} disabled={savingPrompt}>
                {savingPrompt ? "Saving..." : "Save Prompt"}
              </button>
              {isCustomPrompt && (
                <button className="btn btn-secondary" onClick={resetSystemPrompt}>
                  Reset to Default
                </button>
              )}
            </div>
            {statusMessages["prompt"] && (
              <p className={`status-msg ${statusMessages["prompt"].type}`}>
                {statusMessages["prompt"].text}
              </p>
            )}
          </div>

          <div className="settings-section data-section">
            <h3>Memory Passport</h3>
            <p>
              Export your memory as a portable JSON file, or import one from
              another RecallOS instance. Swap the AI model, keep the memory.
            </p>
            <div className="passport-actions">
              <button
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    const res = await fetch("/api/passport/export");
                    if (!res.ok) throw new Error("Export failed");
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `recallos-passport-${new Date().toISOString().slice(0, 10)}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    showStatus("passport", "Memory exported", "success");
                  } catch {
                    showStatus("passport", "Export failed", "error");
                  }
                }}
              >
                Export Memory
              </button>
              <label className="btn btn-secondary import-label">
                Import Memory
                <input
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const text = await file.text();
                      const passport = JSON.parse(text);
                      const res = await fetch("/api/passport/import", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(passport),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error || "Import failed");
                      showStatus(
                        "passport",
                        `Imported: ${data.memories_created} memories, ${data.trips_created} trips (${data.memories_skipped} skipped)`,
                        "success"
                      );
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : "Import failed";
                      showStatus("passport", msg, "error");
                    }
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {statusMessages["passport"] && (
              <p className={`status-msg ${statusMessages["passport"].type}`}>
                {statusMessages["passport"].text}
              </p>
            )}
          </div>

          <div className="settings-section data-section">
            <h3>MCP Server</h3>
            <p>
              Connect RecallOS to Claude Desktop or any MCP-compatible AI tool.
            </p>
            {mcpConfig && (
              <div className="mcp-config-block">
                <pre className="mcp-config-pre">
{`"recallos": ${JSON.stringify(mcpConfig.config, null, 2)}`}
                </pre>
                {mcpConfig.claude_desktop_config_path && (
                  <p className="mcp-path">
                    Config file: {mcpConfig.claude_desktop_config_path}
                  </p>
                )}
              </div>
            )}
            <div className="passport-actions">
              <button
                className="btn btn-primary"
                onClick={installMcp}
                disabled={mcpInstalling}
              >
                {mcpInstalling ? "Installing..." : "Install to Claude Desktop"}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  if (!mcpConfig) return;
                  const text = `"recallos": ${JSON.stringify(mcpConfig.config, null, 2)}`;
                  navigator.clipboard.writeText(text);
                  showStatus("mcp", "Config copied to clipboard", "success");
                }}
                disabled={!mcpConfig}
              >
                Copy Config
              </button>
            </div>
            {statusMessages["mcp"] && (
              <p className={`status-msg ${statusMessages["mcp"].type}`}>
                {statusMessages["mcp"].text}
              </p>
            )}
          </div>

          <div className="settings-section data-section">
            <h3>Webhooks</h3>
            <p>
              Get notified when memory events happen (created, superseded, conflicts).
            </p>
            <div className="webhook-add-row">
              <input
                type="url"
                placeholder="https://your-server.com/webhook"
                value={newWebhookUrl}
                onChange={(e) => setNewWebhookUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addWebhook(); }}
              />
              <button className="btn btn-primary" onClick={addWebhook} disabled={!newWebhookUrl.trim()}>
                Add Webhook
              </button>
            </div>
            {webhooks.length > 0 && (
              <div className="webhooks-list">
                {webhooks.map((wh) => (
                  <div key={wh.id} className={`webhook-item ${wh.active ? "" : "inactive"}`}>
                    <div className="webhook-url">{wh.url}</div>
                    <div className="webhook-meta">
                      <span className="webhook-events">{wh.events.join(", ")}</span>
                      <label className="webhook-toggle">
                        <input
                          type="checkbox"
                          checked={wh.active}
                          onChange={(e) => toggleWebhookActive(wh.id, e.target.checked)}
                        />
                        {wh.active ? "Active" : "Paused"}
                      </label>
                      <button className="btn-action btn-delete" onClick={() => deleteWebhookById(wh.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="passport-actions" style={{ marginTop: 12 }}>
              <button className="btn btn-secondary" onClick={fetchDeliveryLog}>
                {showDeliveryLog ? "Refresh Log" : "View Delivery Log"}
              </button>
            </div>
            {showDeliveryLog && (
              <div className="delivery-log">
                {deliveryLog.length === 0 ? (
                  <p className="status-msg success">No deliveries recorded yet.</p>
                ) : (
                  <table className="delivery-log-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Event</th>
                        <th>URL</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveryLog.map((entry, i) => (
                        <tr key={i} className={entry.success ? "" : "delivery-failed"}>
                          <td className="delivery-time">{new Date(entry.timestamp).toLocaleString()}</td>
                          <td className="delivery-event">{entry.event}</td>
                          <td className="delivery-url">{entry.url}</td>
                          <td className={`delivery-status ${entry.success ? "status-ok" : "status-fail"}`}>
                            {entry.success ? entry.status || "OK" : entry.error || `${entry.status}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            {statusMessages["webhooks"] && (
              <p className={`status-msg ${statusMessages["webhooks"].type}`}>
                {statusMessages["webhooks"].text}
              </p>
            )}
          </div>

          <div className="settings-section data-section">
            <h3>Memory Decay</h3>
            <p>
              Find and mark stale memory items that have low importance, were never confirmed,
              or have not been used recently.
            </p>
            <div className="passport-actions">
              <button className="btn btn-secondary" onClick={previewDecay} disabled={decayLoading}>
                {decayLoading ? "Scanning..." : "Preview Stale Items"}
              </button>
              {decayCandidates && decayCandidates.length > 0 && (
                <button className="btn btn-danger" onClick={applyDecayNow} disabled={decayApplying}>
                  {decayApplying ? "Applying..." : `Mark ${decayCandidates.length} as Stale`}
                </button>
              )}
            </div>
            {decayCandidates !== null && decayCandidates.length === 0 && (
              <p className="status-msg success">No stale items found - memory is healthy.</p>
            )}
            {decayCandidates && decayCandidates.length > 0 && (
              <div className="decay-list">
                {decayCandidates.map((c) => (
                  <div key={c.id} className="decay-item">
                    <div className="decay-item-top">
                      <span className="decay-key">{c.key}</span>
                      <span className="decay-type">{c.type}</span>
                      <span className="decay-score">{c.importance}</span>
                    </div>
                    <div className="decay-reason">{c.reason}</div>
                  </div>
                ))}
              </div>
            )}
            {statusMessages["decay"] && (
              <p className={`status-msg ${statusMessages["decay"].type}`}>
                {statusMessages["decay"].text}
              </p>
            )}
          </div>

          <div className="settings-section data-section">
            <h3>Export Memory</h3>
            <p>Download your memory in different formats.</p>
            <div className="export-buttons">
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  try {
                    const res = await fetch("/api/passport/export");
                    if (!res.ok) throw new Error("Export failed");
                    const data = await res.json();
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `recallos-export-${new Date().toISOString().slice(0, 10)}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    showStatus("export", "Exported as JSON", "success");
                  } catch {
                    showStatus("export", "Export failed", "error");
                  }
                }}
              >
                Export JSON
              </button>
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  try {
                    const res = await fetch("/api/passport/export/markdown");
                    if (!res.ok) throw new Error("Export failed");
                    const md = await res.text();
                    const blob = new Blob([md], { type: "text/markdown" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `recallos-memory-${new Date().toISOString().slice(0, 10)}.md`;
                    a.click();
                    URL.revokeObjectURL(url);
                    showStatus("export", "Exported as Markdown", "success");
                  } catch {
                    showStatus("export", "Export failed", "error");
                  }
                }}
              >
                Export Markdown
              </button>
            </div>
            {statusMessages["export"] && (
              <p className={`status-msg ${statusMessages["export"].type}`}>
                {statusMessages["export"].text}
              </p>
            )}
          </div>

          {/* Scheduled Tasks */}
          {scheduledTasks && scheduledTasks.length > 0 && (
            <div className="settings-section data-section">
              <h3>Background Tasks</h3>
              <p>Recurring tasks that run automatically in the background.</p>
              <div className="scheduled-tasks-list">
                {scheduledTasks.map((task) => (
                  <div key={task.name} className={`scheduled-task-item ${task.enabled ? "" : "disabled"}`}>
                    <div className="scheduled-task-name">
                      {task.name.replace(/_/g, " ")}
                    </div>
                    <div className="scheduled-task-meta">
                      <span className="scheduled-task-interval">every {task.interval_human}</span>
                      {!task.enabled && <span className="scheduled-task-disabled-badge">Disabled</span>}
                      <span className="scheduled-task-last-run">
                        {task.last_run
                          ? `Last: ${new Date(task.last_run).toLocaleTimeString()}`
                          : "Not yet run"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Database Stats */}
          {dbStats && (
            <div className="settings-section data-section">
              <h3>Database Statistics</h3>
              <div className="db-stats-grid">
                {[
                  { label: "Memory Items", key: "memory_items" },
                  { label: "Conversations", key: "conversations" },
                  { label: "Messages", key: "events" },
                  { label: "Trips", key: "trips" },
                  { label: "Links", key: "memory_links" },
                  { label: "Tags", key: "memory_tags" },
                  { label: "Audit Entries", key: "memory_audit_log" },
                  { label: "Context Snapshots", key: "context_snapshots" },
                  { label: "Conflicts", key: "conflicts" },
                  { label: "Webhooks", key: "webhooks" },
                ].map((item) => (
                  <div key={item.key} className="db-stat-item">
                    <span className="db-stat-value">{dbStats[item.key] ?? 0}</span>
                    <span className="db-stat-label">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="settings-section data-section">
            <h3>Data Management</h3>
            <p>
              Remove all stored memories, conversations, and trips. Provider API keys are kept.
            </p>
            {!showClearConfirm ? (
              <button
                className="btn btn-danger"
                onClick={() => setShowClearConfirm(true)}
              >
                Clear All Data
              </button>
            ) : (
              <div className="clear-confirm-box">
                <p className="clear-confirm-warning">
                  This will permanently delete all memory items, conversations, trips,
                  links, tags, snapshots, and webhooks. Provider API keys will be kept.
                </p>
                <p className="clear-confirm-instruction">
                  Type <strong>DELETE</strong> to confirm:
                </p>
                <div className="clear-confirm-row">
                  <input
                    type="text"
                    value={clearConfirmText}
                    onChange={(e) => setClearConfirmText(e.target.value)}
                    placeholder="Type DELETE"
                    className="clear-confirm-input"
                  />
                  <button
                    className="btn btn-danger"
                    onClick={clearAllData}
                    disabled={clearConfirmText !== "DELETE" || clearing}
                  >
                    {clearing ? "Clearing..." : "Confirm Delete"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      setShowClearConfirm(false);
                      setClearConfirmText("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {statusMessages["clear"] && (
              <p className={`status-msg ${statusMessages["clear"].type}`}>
                {statusMessages["clear"].text}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default Settings;
