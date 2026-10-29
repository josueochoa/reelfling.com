"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiJson, type Me } from "./api";
import { ControlPanel, type Preset } from "./ControlPanel";
import { GenerationCard } from "./GenerationCard";
import { KeysDialog } from "./KeysDialog";
import { Lightbox } from "./Lightbox";
import { UserMenu } from "./UserMenu";
import { modelsFor, PROVIDER_INFO } from "@/lib/models";
import { TERMINAL_STATUSES, type GenerateRequest, type Generation } from "@/lib/types";

const POLL_MS = 5000;

const needsPoll = (g: Generation) =>
  !TERMINAL_STATUSES.includes(g.status) || (g.status === "succeeded" && !g.stored);

export function Studio() {
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState<Preset>({ key: 0 });
  const [open, setOpen] = useState<Generation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const provider = me?.user.activeProvider ?? null;
  const gensRef = useRef(generations);
  useEffect(() => {
    gensRef.current = generations;
  }, [generations]);

  const upsert = useCallback((gen: Generation) => {
    setGenerations((prev) => {
      const i = prev.findIndex((g) => g.id === gen.id);
      if (i === -1) return [gen, ...prev];
      const next = [...prev];
      next[i] = gen;
      return next;
    });
    setOpen((o) => (o?.id === gen.id ? gen : o));
  }, []);

  const loadMe = useCallback(() => apiJson<Me>("/api/me").then(setMe), []);

  useEffect(() => {
    loadMe();
    apiJson<Generation[]>("/api/generations")
      .then(setGenerations)
      .finally(() => setLoaded(true));
  }, [loadMe]);

  useEffect(() => {
    const timer = setInterval(async () => {
      const pending = gensRef.current.filter(needsPoll);
      await Promise.all(
        pending.map(async (g) => {
          const res = await api(`/api/generations/${g.id}`);
          if (res.ok) upsert(await res.json());
        }),
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [upsert]);

  async function generate(req: GenerateRequest) {
    setError(null);
    try {
      upsert(await apiJson<Generation>("/api/generations", { method: "POST", body: JSON.stringify(req) }));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function remove(gen: Generation) {
    setGenerations((prev) => prev.filter((g) => g.id !== gen.id));
    if (open?.id === gen.id) setOpen(null);
    await api(`/api/generations/${gen.id}`, { method: "DELETE" });
  }

  function reuse(gen: Generation, asFirstFrame?: string) {
    setOpen(null);
    setPreset((p) => ({
      key: p.key + 1,
      model: gen.model,
      prompt: gen.prompt,
      ratio: gen.ratio,
      resolution: gen.resolution,
      duration: gen.duration,
      generateAudio: gen.generateAudio,
      firstFrame: asFirstFrame,
    }));
  }

  const active = generations.filter((g) => !TERMINAL_STATUSES.includes(g.status)).length;

  return (
    <div className="flex h-dvh flex-col bg-ink text-zinc-100 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col border-b border-white/5 bg-panel lg:h-dvh lg:w-[400px] lg:border-r lg:border-b-0">
        <header className="flex items-center justify-between px-5 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <div className="grid size-7 place-items-center rounded-lg bg-accent font-black text-ink">S</div>
            <span className="font-semibold tracking-tight">Studio</span>
            {provider && (
              <button onClick={() => setKeysOpen(true)} className="text-xs text-zinc-500 hover:text-zinc-300">
                via {PROVIDER_INFO[provider].label}
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {active > 0 && (
              <span className="flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-xs text-zinc-400">
                <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                {active} generating
              </span>
            )}
            {me && <UserMenu me={me} onOpen={loadMe} onOpenKeys={() => setKeysOpen(true)} />}
          </div>
        </header>
        {provider ? (
          <ControlPanel
            key={`${provider}-${preset.key}`}
            models={modelsFor(provider)}
            preset={preset}
            onGenerate={generate}
            error={error}
          />
        ) : (
          me && (
            <div className="m-5 rounded-2xl border border-dashed border-white/15 p-6 text-center">
              <p className="font-medium">Connect a provider</p>
              <p className="mt-1 text-sm text-zinc-400">
                Add your ArgoLink or ModelArk API key. Generations are billed to your own account.
              </p>
              <button
                onClick={() => setKeysOpen(true)}
                className="mt-4 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-ink"
              >
                Add API key
              </button>
            </div>
          )
        )}
      </aside>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-ink/80 px-6 py-4 backdrop-blur">
          <h1 className="text-sm font-medium text-zinc-300">
            Generations <span className="text-zinc-500">· {generations.length}</span>
          </h1>
        </div>

        {loaded && generations.length === 0 ? (
          <div className="grid h-[60vh] place-items-center text-center">
            <div>
              <p className="text-lg font-medium text-zinc-300">No videos yet</p>
              <p className="mt-1 text-sm text-zinc-500">
                {provider ? "Write a prompt and hit Generate to start." : "Add an API key to start generating."}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2 2xl:grid-cols-3">
            {generations.map((g) => (
              <GenerationCard
                key={g.id}
                gen={g}
                onOpen={() => setOpen(g)}
                onReuse={() => reuse(g)}
                onDelete={() => remove(g)}
              />
            ))}
          </div>
        )}
      </main>

      {keysOpen && me && <KeysDialog me={me} onClose={() => setKeysOpen(false)} onChanged={loadMe} />}

      {open && (
        <Lightbox
          gen={open}
          onClose={() => setOpen(null)}
          onReuse={() => reuse(open)}
          onExtend={open.lastFrameUrl ? () => reuse(open, open.lastFrameUrl) : undefined}
          onDelete={() => remove(open)}
        />
      )}
    </div>
  );
}
