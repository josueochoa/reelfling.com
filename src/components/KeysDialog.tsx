"use client";

import { useEffect, useState } from "react";
import { MODELARK_REGIONS, PROVIDER_INFO, type ProviderId } from "@/lib/models";
import { apiJson, type Me } from "./api";

const ORDER: ProviderId[] = ["argolink", "openrouter", "modelark"];

export function KeysDialog({ me, onClose, onChanged }: { me: Me; onClose: () => void; onChanged: () => void }) {
  const team = me.workspace.kind === "team";
  // In a team, the keys are shared and only owners and admins manage them.
  const canManage = !team || me.workspace.role !== "member";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex bg-black/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label="API keys"
        className="m-auto w-full max-w-lg rounded-2xl border border-white/10 bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">{team ? `${me.workspace.name} API keys` : "API keys"}</h2>
            <p className="mt-1 text-sm text-zinc-400">
              {team
                ? canManage
                  ? "Everyone in the team generates with these keys, billed to the account they belong to."
                  : "Everyone in the team generates with these keys. Only the team's owner and admins can change them."
                : "Generations run on your own provider account."}{" "}
              Keys are encrypted and never sent to the browser.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {ORDER.map((p) => (
            <ProviderRow
              key={p}
              provider={p}
              saved={me.keys.find((k) => k.provider === p)}
              active={me.workspace.activeProvider === p}
              canManage={canManage}
              onChanged={onChanged}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  saved,
  active,
  canManage,
  onChanged,
}: {
  provider: ProviderId;
  saved?: Me["keys"][number];
  active: boolean;
  canManage: boolean;
  onChanged: () => void;
}) {
  const info = PROVIDER_INFO[provider];
  const [editing, setEditing] = useState(!saved && canManage);
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
      if (!confirm(`Remove the ${info.label} key?`)) return;
      await apiJson(`/api/keys?provider=${provider}`, { method: "DELETE" });
      setEditing(true);
    });

  const activate = () =>
    run(async () => {
      await apiJson("/api/me", { method: "PATCH", body: JSON.stringify({ activeProvider: provider }) });
    });

  return (
    <section className={`rounded-xl border p-4 ${active ? "border-accent/50 bg-accent/[0.04]" : "border-white/10"}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{info.label}</h3>
            {active && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-ink">In use</span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            {saved ? `Key ••••${saved.last4}` : canManage ? info.blurb : "Not set up"}
          </p>
        </div>
        {saved && canManage && (
          <div className="flex shrink-0 gap-1.5 text-xs">
            {!active && (
              <button
                onClick={activate}
                disabled={busy}
                className="rounded-lg bg-white/10 px-2.5 py-1.5 hover:bg-white/15"
              >
                Use
              </button>
            )}
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

      {message && <p className={`mt-2 text-xs ${message.ok ? "text-accent" : "text-red-300"}`}>{message.text}</p>}
    </section>
  );
}
