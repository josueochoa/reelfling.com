"use client";

import { useState } from "react";
import { apiJson } from "./api";
import { enhanceAvailability, wordDiff, type NativeExpansion } from "@/lib/enhance";
import { availabilityHint } from "@/lib/registry/availability";
import { UnlockHint } from "./UnlockHint";

interface Props {
  prompt: string;
  onChange: (prompt: string) => void;
  family: string;
  /** Camera preset ids. The server turns known ids into chip text. */
  cameras?: readonly string[];
  /** Mention tokens and short names. No file URLs. */
  references?: readonly string[];
  keyed: ReadonlySet<string>;
  onOpenKeys: () => void;
  /** Wan or MiniMax H3, when this model expands prompts itself. */
  native?: NativeExpansion | null;
  nativeOn?: boolean;
  onNativeOn?: (on: boolean) => void;
}

export function PromptEnhance({
  prompt,
  onChange,
  family,
  cameras = [],
  references = [],
  keyed,
  onOpenKeys,
  native = null,
  nativeOn = false,
  onNativeOn,
}: Props) {
  const gate = enhanceAvailability(keyed);
  // A checked native toggle sends the model's flag and does not call the rewrite endpoint.
  const callLlm = !(native && nativeOn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ before: string; after: string } | null>(null);
  const [undoTo, setUndoTo] = useState<string | null>(null);
  const reason = gate.available ? "" : availabilityHint(gate.needs);
  const showing = pending && pending.before === prompt ? pending : null;

  async function run() {
    if (!callLlm || !gate.available || busy || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    setUndoTo(null);
    try {
      const body = await apiJson<{ prompt: string }>("/api/enhance", {
        method: "POST",
        body: JSON.stringify({ prompt, family, cameras, references }),
      });
      setPending({ before: prompt, after: body.prompt });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function accept() {
    if (!showing) return;
    const next = showing.after;
    setUndoTo(showing.before);
    setPending(null);
    onChange(next);
  }

  function undo() {
    if (showing) {
      setPending(null);
      return;
    }
    if (undoTo !== null) {
      onChange(undoTo);
      setUndoTo(null);
    }
  }

  return (
    <div className="mt-2 space-y-2" data-testid="enhance-panel">
      <div className="flex flex-wrap items-center gap-2">
        {native && (
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            {native.label}
            <button
              type="button"
              role="switch"
              data-testid="native-expansion"
              aria-checked={nativeOn}
              onClick={() => {
                setPending(null);
                setError(null);
                onNativeOn?.(!nativeOn);
              }}
              className={`relative h-5 w-9 rounded-full transition ${nativeOn ? "bg-accent" : "bg-white/15"}`}
            >
              <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${nativeOn ? "left-[18px]" : "left-0.5"}`} />
            </button>
          </label>
        )}
        {callLlm && (
          <button
            type="button"
            data-testid="enhance"
            data-available={gate.available ? "true" : "false"}
            disabled={!gate.available || busy || !prompt.trim()}
            title={reason || undefined}
            onClick={() => void run()}
            className={`h-8 rounded-lg px-3 text-xs font-medium transition disabled:cursor-not-allowed ${
              gate.available
                ? "bg-white/10 text-zinc-100 hover:bg-white/15 disabled:opacity-40"
                : "cursor-not-allowed bg-white/[0.04] text-zinc-600"
            }`}
          >
            {busy ? "Enhancing…" : "Enhance"}
          </button>
        )}
        {!gate.available && callLlm && (
          <span data-testid="enhance-reason">
            <UnlockHint hint={reason} onOpen={onOpenKeys} />
          </span>
        )}
        {nativeOn && native && <span className="text-xs text-zinc-500">{native.detail}</span>}
        {undoTo !== null && !showing && (
          <button type="button" onClick={undo} className="text-xs text-zinc-400 underline decoration-white/20 hover:text-zinc-200">
            Undo
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-300">{error}</p>}
      {showing && (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
          <p className="mb-1.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">Rewrite</p>
          <p data-testid="enhance-diff" className="text-sm leading-relaxed whitespace-pre-wrap text-zinc-200">
            {wordDiff(showing.before, showing.after).map((part, index) =>
              part.kind === "same" ? (
                <span key={index}>{part.text}</span>
              ) : part.kind === "del" ? (
                <span key={index} className="rounded-sm bg-red-500/15 text-red-200/90 line-through">
                  {part.text}
                </span>
              ) : (
                <span key={index} className="rounded-sm bg-emerald-500/15 text-emerald-200">
                  {part.text}
                </span>
              ),
            )}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid="enhance-accept"
              onClick={accept}
              className="h-7 rounded-lg bg-accent px-2.5 text-xs font-semibold text-ink"
            >
              Accept
            </button>
            <button
              type="button"
              data-testid="enhance-discard"
              onClick={undo}
              className="h-7 rounded-lg border border-white/10 px-2.5 text-xs text-zinc-300 hover:text-white"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
