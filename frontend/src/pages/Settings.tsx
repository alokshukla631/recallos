import { useState, useEffect } from "react";
import "./Settings.css";

interface Provider {
  provider: string;
  is_default: boolean;
}

const ALL_PROVIDERS = ["openai", "anthropic"];

function Settings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [defaultProvider, setDefaultProvider] = useState("");
  const [statusMessages, setStatusMessages] = useState<
    Record<string, { text: string; type: "success" | "error" }>
  >({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [loadingProviders, setLoadingProviders] = useState(true);

  useEffect(() => {
    fetchProviders();
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
            <h3>Data Management</h3>
            <p>
              Remove all stored memories, conversations, and configuration.
            </p>
            <button className="btn btn-danger" disabled>
              Clear All Data (coming soon)
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default Settings;
