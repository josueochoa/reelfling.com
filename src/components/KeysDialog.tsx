"use client";

import { useState } from "react";
import { MODELARK_REGIONS, PROVIDER_INFO, type ProviderId } from "@/lib/registry";
import { Modal } from "@/components/ui/Modal";
import { confirmToast } from "@/components/ui/Toast";
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
      </div>
    </Modal>
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
              disabled={busy || !apiKey.trim()}
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

      {message && <p className={`mt-2 text-xs ${message.ok ? "text-fg" : "text-red-300"}`}>{message.text}</p>}
    </section>
  );
}
