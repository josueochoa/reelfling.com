"use client";

import { useEffect } from "react";
import { estimateCost, getModel } from "@/lib/models";
import type { Generation } from "@/lib/types";
import { formatSecs, StatusOverlay, useElapsed, videoSrc } from "./GenerationCard";

export function Lightbox({
  gen,
  onClose,
  onReuse,
  onExtend,
  onDelete,
}: {
  gen: Generation;
  onClose: () => void;
  onReuse: () => void;
  onExtend?: () => void;
  onDelete: () => void;
}) {
  const elapsed = useElapsed(gen);
  const ready = gen.status === "succeeded";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const model = getModel(gen.model);
  const cost = model && estimateCost(model, gen.resolution, gen.billedSeconds ?? gen.duration);
  const details: [string, React.ReactNode][] = [
    ["Model", model?.label ?? gen.model],
    ["Provider", gen.provider ?? "modelark"],
    ["Resolution", gen.resolution],
    ["Duration", `${gen.duration}s`],
    ["Ratio", gen.ratio],
    ["Audio", gen.generateAudio ? "On" : "Off"],
    ["Render time", formatSecs(elapsed)],
  ];
  if (gen.seed !== undefined) details.push(["Seed", gen.seed]);
  if (gen.tokens !== undefined) details.push(["Tokens", gen.tokens.toLocaleString()]);
  if (gen.billedSeconds !== undefined) details.push(["Billed", `${gen.billedSeconds}s`]);
  if (cost !== undefined) details.push(["Est. cost", `$${cost.toFixed(2)}`]);
  details.push([
    "Task",
    <code key="t" className="text-[11px] break-all">
      {gen.taskId}
    </code>,
  ]);

  return (
    <div className="fixed inset-0 z-50 flex bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div
        className="m-auto flex max-h-[92dvh] w-[min(1200px,94vw)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-panel lg:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative grid min-h-[300px] flex-1 place-items-center bg-black">
          {ready ? (
            <video src={videoSrc(gen)} controls autoPlay loop playsInline className="max-h-[92dvh] w-full" />
          ) : (
            <StatusOverlay gen={gen} elapsed={elapsed} />
          )}
        </div>
        <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto p-5 lg:w-80">
          <div className="flex items-start justify-between">
            <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Prompt</h2>
            <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
              ✕
            </button>
          </div>
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-zinc-200">{gen.prompt || "—"}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            {details.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-500">{k}</dt>
                <dd className="text-right text-zinc-300">{v}</dd>
              </div>
            ))}
          </dl>
          {gen.error && <p className="rounded-lg bg-red-500/10 p-2.5 text-xs text-red-300">{gen.error}</p>}
          <div className="mt-auto grid gap-2">
            {ready && (
              <a
                href={`${videoSrc(gen)}?download`}
                className="rounded-xl bg-accent py-2.5 text-center text-sm font-semibold text-ink"
              >
                Download
              </a>
            )}
            {onExtend && (
              <button onClick={onExtend} className="rounded-xl border border-white/10 py-2.5 text-sm hover:bg-white/5">
                Continue from last frame
              </button>
            )}
            <button onClick={onReuse} className="rounded-xl border border-white/10 py-2.5 text-sm hover:bg-white/5">
              Reuse settings
            </button>
            <button onClick={onDelete} className="rounded-xl py-2 text-sm text-red-300/80 hover:text-red-300">
              Delete
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
