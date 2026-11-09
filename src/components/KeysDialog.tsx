"use client";

import { useEffect, useState } from "react";
import { MODELARK_REGIONS, PROVIDER_INFO, type ProviderId } from "@/lib/registry";
import { Modal } from "@/components/ui/Modal";
import { confirmToast } from "@/components/ui/Toast";
import { wrongBoxError } from "@/lib/keyFormat";
import { apiJson, type Me } from "./api";

const ORDER: ProviderId[] = ["argolink", "openrouter", "modelark", "fal"];

export function KeysDialog({ me, onClose, onChanged }: { me: Me; onClose: () => void; onChanged: () => void }) {
  return (
    <Modal
      size="md"
      onClose={onClose}
      title="API keys"
      description="Generations run on your own provider account. Keys are encrypted and never sent to the browser."
    >
      <div className="space-y-3">
        {ORDER.map((p) => (
          <ProviderRow
            key={p}
            provider={p}
            saved={me.keys.find((k) => k.provider === p)}
            onChanged={onChanged}
          />
        ))}
        <ConnectedApps />
      </div>
    </Modal>
  );
}

interface Grant {
  id: string;
  name: string;
  scope: string[];
  createdAt: number;
  spentToday: number;
}

/** The Claude connector: its URL, and the apps connected through it (see src/mcp). */
function ConnectedApps() {
  const [data, setData] = useState<{ grants: Grant[]; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () =>
    apiJson<{ grants: Grant[]; url: string }>("/api/connector/grants")
      .then(setData)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
  }, []);

  async function disconnect(grant: Grant) {
    const ok = await confirmToast(`Disconnect ${grant.name}? It loses access right away.`, { confirmLabel: "Disconnect" });
    if (!ok) return;
    await apiJson(`/api/connector/grants?id=${encodeURIComponent(grant.id)}`, { method: "DELETE" }).catch((e) =>
      setError((e as Error).message),
    );
    void load();
  }

  async function copy() {
    if (!data) return;
    await navigator.clipboard.writeText(data.url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section data-testid="connected-apps" className="rounded-lg border border-line p-4">
      <h3 className="font-medium">Connected apps</h3>
      <p className="mt-0.5 text-xs text-zinc-500">
        Use ReelFling from Claude: in Claude, open Settings → Connectors → Add custom connector, and paste this URL.
        Claude shows the cost before it starts anything, and each connection can spend up to $20 a day.
      </p>
      {data && (
        <div className="mt-3 flex gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm">
            {data.url}
          </code>
          <button onClick={copy} className="rounded-lg bg-white/5 px-3 text-sm text-zinc-300 hover:bg-white/10">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {data?.grants.length ? (
        <ul className="mt-3 divide-y divide-line">
          {data.grants.map((grant) => (
            <li key={grant.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{grant.name}</p>
                <p className="text-xs text-zinc-500">
                  {grant.scope.includes("generate") ? "Can generate" : "View only"} · ${grant.spentToday.toFixed(2)} in
                  the last 24 h · since {new Date(grant.createdAt).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => void disconnect(grant)}
                className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-red-300/80 hover:text-red-300"
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      ) : (
        data && <p className="mt-3 text-xs text-zinc-500">Nothing connected yet.</p>
      )}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </section>
  );
}

function ProviderRow({
  provider,
  saved,
  onChanged,
}: {
  provider: ProviderId;
  saved?: Me["keys"][number];
  onChanged: () => void;
}) {
  const info = PROVIDER_INFO[provider];
  const [editing, setEditing] = useState(!saved);
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState(saved?.baseUrl ?? Object.keys(MODELARK_REGIONS)[0]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const misplaced = apiKey.trim() ? wrongBoxError(provider, apiKey) : null;

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ ok: true, text });
      onChanged();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const res = await apiJson<{ detail?: string }>("/api/keys", {
        method: "PUT",
        body: JSON.stringify({ provider, apiKey, baseUrl: provider === "modelark" ? region : undefined }),
      });
      setApiKey("");
      setEditing(false);
      return `Key verified${res.detail ? ` · ${res.detail}` : ""}`;
    });

  const remove = () =>
    run(async () => {
      const ok = await confirmToast(`Remove your ${info.label} key?`, { confirmLabel: "Remove" });
      if (!ok) return;
      await apiJson(`/api/keys?provider=${provider}`, { method: "DELETE" });
      setEditing(true);
    });

  return (
    <section className="rounded-lg border border-line p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{info.label}</h3>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">{saved ? `Key ••••${saved.last4}` : info.blurb}</p>
        </div>
        {saved && (
          <div className="flex shrink-0 gap-1.5 text-xs">
            <button
              onClick={() => setEditing((e) => !e)}
              disabled={busy}
              className="rounded-lg px-2.5 py-1.5 text-zinc-400 hover:text-white"
            >
              {editing ? "Cancel" : "Replace"}
            </button>
            <button
              onClick={remove}
              disabled={busy}
              className="rounded-lg px-2.5 py-1.5 text-red-300/80 hover:text-red-300"
            >
              Remove
            </button>
          </div>
        )}
      </div>

      {editing && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {provider === "modelark" && (
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm outline-none focus:border-accent/60"
            >
              {Object.entries(MODELARK_REGIONS).map(([url, label]) => (
                <option key={url} value={url} className="bg-panel">
                  {label}
                </option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={`${info.label} API key`}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm outline-none focus:border-accent/60"
            />
            <button
              type="submit"
              disabled={busy || !apiKey.trim() || !!misplaced}
              className="rounded-lg bg-accent px-3.5 text-sm font-semibold text-ink disabled:opacity-40"
            >
              {busy ? "Checking…" : "Save"}
            </button>
          </div>
          <a
            href={info.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs text-zinc-500 hover:text-zinc-300"
          >
            Get a key ↗
          </a>
        </form>
      )}

      {misplaced && (
        <p data-testid="key-wrong-box" className="mt-2 text-xs text-red-300">
          {misplaced}
        </p>
      )}
      {message && !misplaced && (
        <p className={`mt-2 text-xs ${message.ok ? "text-fg" : "text-red-300"}`}>{message.text}</p>
      )}
    </section>
  );
}
