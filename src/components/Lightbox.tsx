"use client";

import { useState } from "react";
import { X } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { cameraSummary, estimateCost } from "@/lib/registry";
import { lookupModel } from "@/lib/registry/lookup";
import type { ExtendOffer, ToolView } from "@/lib/toolTypes";
import type { Generation } from "@/lib/types";
import { formatSecs, StatusOverlay, useElapsed, videoSrc } from "./GenerationCard";
import { ToolsMenu } from "./ToolsMenu";

export function Lightbox({
  gen,
  onClose,
  onReuse,
  onUseAsReference,
  onContinue,
  continueBusy,
  extendOffer,
  onNativeExtend,
  onDelete,
  tools,
  keyed,
  onOpenKeys,
  onToolJob,
}: {
  gen: Generation;
  onClose: () => void;
  onReuse: () => void;
  onUseAsReference: () => void;
  /** Extract the last frame and use it as the start frame. */
  onContinue?: () => void;
  continueBusy?: boolean;
  /** Set when this clip's model has a native extend endpoint. */
  extendOffer?: ExtendOffer;
  onNativeExtend?: (prompt: string) => Promise<void>;
  onDelete: () => void;
  tools: readonly ToolView[];
  keyed: ReadonlySet<string>;
  onOpenKeys: () => void;
  onToolJob: () => void;
}) {
  const elapsed = useElapsed(gen);
  const ready = gen.status === "succeeded";
  const canReference = ready && !!gen.stored;
  const [extendPrompt, setExtendPrompt] = useState(gen.prompt);
  const [extendBusy, setExtendBusy] = useState(false);
  const [extendError, setExtendError] = useState<string | null>(null);

  const model = lookupModel(gen.model);
  const camera = cameraSummary(gen.cameraMoves, gen.cameraMove);
  const billed = gen.billedSeconds;
  // billed_seconds already include reference video. Use the with-video rate only
  // when this job had one. A longer bill on its own (a provider minimum) stays
  // on the normal rate.
  const hadReferenceVideo = gen.inputs.videos > 0;
  const cost =
    model &&
    estimateCost(model, {
      resolution: gen.resolution,
      duration: billed ?? gen.duration,
      audio: gen.generateAudio,
      ...(hadReferenceVideo && billed !== undefined ? { referenceVideoSeconds: 0, durationIsBilled: true } : {}),
    });
  const details: [string, React.ReactNode][] = [
    ["Model", model?.name ?? gen.model],
    ["Provider", gen.provider ?? "modelark"],
    ["Resolution", gen.resolution],
    ["Duration", `${gen.duration}s`],
    ["Ratio", gen.ratio],
    ["Audio", gen.generateAudio ? "On" : "Off"],
    ["Render time", formatSecs(elapsed)],
  ];
  if (camera) details.splice(5, 0, ["Camera", camera]);
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
    <Modal size="lg" width={1200} onClose={onClose} label="Generation" showClose={false}>
      <div className="flex max-h-[92dvh] flex-col lg:flex-row">
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
              <X className="size-4" aria-hidden />
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
            <ToolsMenu
              kind="video"
              assetKey={gen.stored ? `videos/${gen.id}.mp4` : undefined}
              tools={tools}
              keyed={keyed}
              onOpenKeys={onOpenKeys}
              onStarted={onToolJob}
            />
            {ready && (
              <a
                href={`${videoSrc(gen)}?download`}
                className="rounded-xl bg-accent py-2.5 text-center text-sm font-semibold text-ink"
              >
                Download
              </a>
            )}
            {ready && onContinue && (
              <button
                type="button"
                data-testid="continue-last-frame"
                onClick={onContinue}
                disabled={continueBusy}
                className="rounded-xl border border-white/10 py-2.5 text-sm hover:bg-white/5 disabled:opacity-50"
              >
                {continueBusy ? "Saving the last frame…" : "Continue from last frame"}
              </button>
            )}
            {ready && extendOffer && onNativeExtend && (
              <form
                data-testid="extend-option"
                className="grid gap-2 rounded-xl border border-white/10 p-2.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const prompt = extendPrompt.trim();
                  if (!prompt || extendBusy) return;
                  setExtendBusy(true);
                  setExtendError(null);
                  void onNativeExtend(prompt)
                    .catch((err: unknown) => setExtendError(err instanceof Error ? err.message : "Couldn't extend"))
                    .finally(() => setExtendBusy(false));
                }}
              >
                <p className="text-sm text-zinc-100">{extendOffer.name}</p>
                <textarea
                  aria-label="What happens next"
                  value={extendPrompt}
                  onChange={(e) => setExtendPrompt(e.target.value)}
                  rows={3}
                  className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-sm text-zinc-100 outline-none"
                />
                {extendError && <p className="text-xs text-red-300">{extendError}</p>}
                <button
                  type="submit"
                  disabled={extendBusy || !extendPrompt.trim()}
                  className="rounded-lg bg-white/10 py-2 text-sm hover:bg-white/15 disabled:opacity-40"
                >
                  {extendBusy ? "Starting…" : "Extend"}
                </button>
              </form>
            )}
            {canReference && (
              <button
                onClick={onUseAsReference}
                className="rounded-xl border border-white/10 py-2.5 text-sm hover:bg-white/5"
              >
                Use as reference
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
    </Modal>
  );
}
