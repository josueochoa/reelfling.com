"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ControlPanel, type Preset } from "./ControlPanel";
import { GenerationCard } from "./GenerationCard";
import { Lightbox } from "./Lightbox";
import { modelsFor, type ProviderId } from "@/lib/models";
import { TERMINAL_STATUSES, type GenerateRequest, type Generation } from "@/lib/types";

const POLL_MS = 5000;

const needsPoll = (g: Generation) =>
  !TERMINAL_STATUSES.includes(g.status) || (g.status === "succeeded" && !g.localVideo);

export function Studio() {
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState<Preset>({ key: 0 });
  const [open, setOpen] = useState<Generation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<{ provider: ProviderId; label: string } | null>(null);
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

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setProvider);
    fetch("/api/generations")
      .then((r) => r.json())
      .then((items: Generation[]) => setGenerations(items))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    const timer = setInterval(async () => {
      const pending = gensRef.current.filter(needsPoll);
      await Promise.all(
        pending.map(async (g) => {
          const res = await fetch(`/api/generations/${g.id}`);
          if (res.ok) upsert(await res.json());
        }),
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [upsert]);

  async function generate(req: GenerateRequest) {
    setError(null);
    const res = await fetch("/api/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "Generation failed");
      return false;
    }
    upsert(body);
    return true;
  }

  async function remove(gen: Generation) {
    setGenerations((prev) => prev.filter((g) => g.id !== gen.id));
    if (open?.id === gen.id) setOpen(null);
    await fetch(`/api/generations/${gen.id}`, { method: "DELETE" });
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
            {provider && <span className="text-xs text-zinc-500">via {provider.label}</span>}
          </div>
          {active > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-xs text-zinc-400">
              <span className="size-1.5 animate-pulse rounded-full bg-accent" />
              {active} generating
            </span>
          )}
        </header>
        {provider && (
          <ControlPanel
            key={preset.key}
            models={modelsFor(provider.provider)}
            preset={preset}
            onGenerate={generate}
            error={error}
          />
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
              <p className="mt-1 text-sm text-zinc-500">Write a prompt and hit Generate to start.</p>
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
