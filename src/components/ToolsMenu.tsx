"use client";

// Tools for the asset on screen. The list is already limited to that asset's kind.
// Upscale models that share a menu name collapse into one item with a model picker.

import { useState } from "react";
import { lipsyncEstimate, lipsyncLimitError, mismatchNotice } from "@/lib/lipsyncQuote";
import { availabilityFor, availabilityHint, routeProviders } from "@/lib/registry/availability";
import { toolsForKind, type ToolAsset, type ToolFieldView, type ToolView } from "@/lib/toolTypes";
import { formatUpscaleCost, planBulkToolJobs, upscaleCost } from "@/lib/upscaleQuote";
import { api } from "./api";
import type { ToolAudioChoice } from "./library";
import { UnlockHint } from "./UnlockHint";

interface MenuEntry {
  id: string;
  name: string;
  description: string;
  tools: ToolView[];
}

function entryProviders(tools: readonly ToolView[]) {
  return routeProviders(tools.flatMap((tool) => (tool.providers ?? []).map((provider) => ({ provider }))));
}

function menuEntries(tools: readonly ToolView[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  const index = new Map<string, MenuEntry>();
  for (const tool of tools) {
    const key = tool.menu ?? tool.id;
    const existing = index.get(key);
    if (existing) {
      existing.tools.push(tool);
      continue;
    }
    const entry: MenuEntry = {
      id: key,
      name: tool.menu ?? tool.name,
      description: tool.menu === "Upscale" ? "Increase the resolution." : tool.menu === "Lip sync" ? "Match a face in a video to an audio track." : tool.description,
      tools: [tool],
    };
    index.set(key, entry);
    out.push(entry);
  }
  return out;
}

function defaults(tool: ToolView, prev?: Record<string, string | boolean>): Record<string, string | boolean> {
  const initial: Record<string, string | boolean> = {};
  for (const field of tool.fields) {
    if (field.type === "boolean") initial[field.name] = field.default ?? false;
    else if (field.type === "enum" || field.type === "string") initial[field.name] = field.default ?? "";
    else if (field.default !== undefined) initial[field.name] = String(field.default);
  }
  const prevTarget = prev?.target;
  const targetField = tool.fields.find((field) => field.name === "target");
  if (
    typeof prevTarget === "string" &&
    targetField?.type === "enum" &&
    targetField.options.includes(prevTarget)
  )
    initial.target = prevTarget;
  return initial;
}

function estimateFor(tool: ToolView, subjects: readonly ToolAsset[], target: string | undefined): number | undefined {
  if (!tool.quote) return undefined;
  const list = subjects.length > 0 ? subjects : [{} as ToolAsset];
  let sum = 0;
  for (const subject of list) {
    const part = upscaleCost(tool.quote, {
      width: subject.width,
      height: subject.height,
      target,
    });
    if (part === undefined) return undefined;
    sum += part;
  }
  return sum;
}

export function ToolsMenu({
  kind,
  assetKey,
  asset,
  assets,
  tools,
  keyed = new Set<string>(),
  onOpenKeys,
  onStarted,
  placement = "up",
  label = "Tools",
  compact = false,
  inline = false,
  entry = undefined,
  audios = [],
  onUploadAudio,
}: {
  kind: string;
  /** Library key. Absent until the file is stored. */
  assetKey?: string;
  /** Size of the one asset, for the cost estimate. */
  asset?: Omit<ToolAsset, "kind" | "key">;
  /** Bulk run: one job per asset. */
  assets?: readonly ToolAsset[];
  tools: readonly ToolView[];
  /** Providers this user has a key for. Names only. */
  keyed?: ReadonlySet<string>;
  onOpenKeys?: () => void;
  /** The job is in the feed. */
  onStarted: () => void;
  placement?: "up" | "down";
  label?: string;
  compact?: boolean;
  /** Draw the menu in the inspector instead of a floating panel. */
  inline?: boolean;
  /** Open this menu name (`Upscale`). Null shows the list. A new key remounts it. */
  entry?: string | null;
  /** Audio already in Uploads. Lip sync picks one of these, or uploads a new file. */
  audios?: readonly ToolAudioChoice[];
  onUploadAudio?: (file: File) => Promise<ToolAudioChoice>;
}) {
  const available = toolsForKind(tools, kind);
  const entries = menuEntries(available);
  const initial = entry ? entries.find((item) => item.id === entry || item.name === entry) : undefined;
  const [open, setOpen] = useState(inline || !!initial);
  const [choices, setChoices] = useState<ToolView[] | null>(initial && initial.tools.length > 1 ? initial.tools : null);
  const [tool, setTool] = useState<ToolView | null>(initial?.tools[0] ?? null);
  const [values, setValues] = useState<Record<string, string | boolean>>(initial?.tools[0] ? defaults(initial.tools[0]) : {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [audioSource, setAudioSource] = useState<"library" | "new">("library");
  const [audioKey, setAudioKey] = useState<string>("");
  const [uploaded, setUploaded] = useState<ToolAudioChoice | null>(null);
  const [uploading, setUploading] = useState(false);

  if (available.length === 0) return null;

  function show(next: ToolView, prev?: Record<string, string | boolean>) {
    setTool(next);
    setValues(defaults(next, prev));
    setError(null);
  }

  function openEntry(entry: MenuEntry) {
    setChoices(entry.tools.length > 1 ? entry.tools : null);
    show(entry.tools[0]);
  }

  const subjects: readonly ToolAsset[] = assets ?? [{ kind, key: assetKey, ...asset }];
  const target = typeof values.target === "string" ? values.target : undefined;
  const estimate = tool ? estimateFor(tool, subjects, target) : undefined;
  const count = assets?.length ?? 1;
  const audioChoices = uploaded && !audios.some((item) => item.key === uploaded.key) ? [uploaded, ...audios] : audios;
  const selectedAudio = audioChoices.find((item) => item.key === audioKey);
  const optionField = tool?.fields.find((field) => field.name === "sync_mode" || field.name === "loop_mode");
  const optionValue = optionField ? values[optionField.name] : undefined;
  const option = typeof optionValue === "string" ? optionValue : undefined;
  const lipsync = tool?.needsAudio
    ? lipsyncEstimate(tool.id, { video: asset?.duration, audio: selectedAudio?.duration, option })
    : undefined;
  const mismatch =
    tool?.needsAudio && selectedAudio
      ? mismatchNotice(tool.id, { video: asset?.duration, audio: selectedAudio.duration, option })
      : undefined;
  const audioLimit =
    tool?.needsAudio && selectedAudio
      ? lipsyncLimitError(
          tool.id,
          { duration: asset?.duration },
          { duration: selectedAudio.duration, bytes: selectedAudio.bytes },
          tool.name,
        )
      : undefined;

  async function run() {
    if (!tool) return;
    if (!assets && !assetKey) return;
    if (tool.needsAudio && !selectedAudio) {
      setError("Choose an audio file.");
      return;
    }
    if (audioLimit) {
      setError(audioLimit);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, string | number | boolean> = {};
      for (const field of tool.fields) params[field.name] = paramValue(field, values[field.name]);
      const jobs = assets
        ? planBulkToolJobs(
            assets.flatMap((item) => (item.key ? [{ key: item.key, kind: item.kind }] : [])),
            { id: tool.id, accepts: tool.accepts },
            params,
          )
        : [{ toolId: tool.id, assetIds: [assetKey!], params, ...(tool.needsAudio ? { audioId: selectedAudio!.key } : {}) }];
      for (let i = 0; i < jobs.length; i++) {
        const res = await api("/api/fal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(jobs[i]),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          const prefix = i > 0 ? `Queued ${i} of ${jobs.length}. ` : "";
          setError(prefix + (body.error ?? `Couldn't start the tool (${res.status})`));
          if (i > 0) onStarted();
          return;
        }
      }
      setOpen(false);
      setTool(null);
      setChoices(null);
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const kindWord = kind === "image" ? (count === 1 ? "image" : "images") : count === 1 ? "video" : "videos";

  const menu = open && (
        <div
          role="menu"
          aria-label={label}
          className={
            inline
              ? "w-full rounded-lg border border-line bg-surface-2 p-2 text-left"
              : `absolute z-20 w-80 rounded-xl border border-white/10 bg-panel p-2 text-left shadow-2xl shadow-black/50 ${
                  placement === "down" ? "top-full left-0 mt-2" : "right-0 bottom-full mb-2"
                }`
          }
        >
          {!assetKey && !assets ? (
            <p className="px-2 py-1.5 text-xs text-zinc-500">Save the file before running a tool.</p>
          ) : tool ? (
            <form
              className="space-y-2 p-1"
              onSubmit={(e) => {
                e.preventDefault();
                void run();
              }}
            >
              <button
                type="button"
                onClick={() => {
                  if (assets) {
                    setOpen(false);
                    setTool(null);
                    setChoices(null);
                    return;
                  }
                  setTool(null);
                  setChoices(null);
                }}
                className="text-[11px] text-zinc-500 hover:text-white"
              >
                ← {choices ? (tool.menu ?? tool.name) : tool.name}
              </button>
              {assets && (
                <p className="text-xs text-zinc-400">
                  {count} {kindWord}
                </p>
              )}
              {choices && (
                <label className="block text-xs text-zinc-400">
                  Model
                  <select
                    aria-label="Model"
                    value={tool.id}
                    onChange={(e) => {
                      const next = choices.find((item) => item.id === e.target.value);
                      if (next) show(next, values);
                    }}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-sm text-zinc-100 outline-none"
                  >
                    {choices.map((item) => (
                      <option key={item.id} value={item.id} className="bg-panel">
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {choices && tool.description && (
                <p className="text-[11px] leading-snug text-zinc-500">{tool.description}</p>
              )}
              {tool.needsAudio && (
                <AudioPicker
                  source={audioSource}
                  onSource={setAudioSource}
                  choices={audioChoices}
                  audioKey={audioKey}
                  onAudio={setAudioKey}
                  uploading={uploading}
                  canUpload={!!onUploadAudio}
                  onFile={(file) => {
                    if (!onUploadAudio) return;
                    setUploading(true);
                    setError(null);
                    void onUploadAudio(file)
                      .then((item) => {
                        setUploaded(item);
                        setAudioKey(item.key);
                        setAudioSource("library");
                      })
                      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't upload that audio"))
                      .finally(() => setUploading(false));
                  }}
                />
              )}
              {tool.fields.map((field) => (
                <Field
                  key={field.name}
                  field={field}
                  value={values[field.name]}
                  onChange={(value) => setValues((prev) => ({ ...prev, [field.name]: value }))}
                />
              ))}
              {mismatch && (
                <p data-testid="lipsync-mismatch" role="status" className="rounded-md bg-surface-3 px-2 py-1.5 text-body text-fg">
                  {mismatch}
                </p>
              )}
              {lipsync && (
                <p data-testid="tool-cost" className="text-body text-fg">
                  {lipsync.text}
                </p>
              )}
              {tool.menu === "Upscale" && (
                <p className="text-xs text-zinc-200">
                  {estimate === undefined ? "Estimate unavailable." : `Est. cost ${formatUpscaleCost(estimate)}`}
                </p>
              )}
              {(error || audioLimit) && <p className="text-xs text-red-300">{error || audioLimit}</p>}
              <button
                type="submit"
                data-testid="tool-run"
                disabled={busy || uploading || (tool.needsAudio && !selectedAudio) || !!audioLimit}
                className="w-full rounded-lg bg-accent py-2 text-sm font-semibold text-accent-fg disabled:opacity-40"
              >
                {busy ? "Starting…" : assets ? `Queue ${count}` : "Run"}
              </button>
            </form>
          ) : (
            entries.map((item) => {
              const providers = entryProviders(item.tools);
              const open = availabilityFor(providers, keyed);
              const locked = providers.length > 0 && !open.available;
              const hint = availabilityHint(open.needs);
              return (
                <div
                  key={item.id}
                  onMouseEnter={() => setHover(item.id)}
                  onMouseLeave={() => setHover((current) => (current === item.id ? null : current))}
                >
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`tool-${item.id}`}
                    data-available={locked ? "false" : "true"}
                    aria-disabled={locked}
                    onClick={() => {
                      if (locked) {
                        setHover(item.id);
                        return;
                      }
                      openEntry(item);
                    }}
                    className={`block w-full rounded-lg px-2 py-2 text-left ${
                      locked ? "cursor-not-allowed text-zinc-500" : "hover:bg-white/5"
                    }`}
                  >
                    <span className={`block text-sm ${locked ? "text-zinc-500" : "text-zinc-100"}`}>{item.name}</span>
                    {item.description && (
                      <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">{item.description}</span>
                    )}
                  </button>
                  {locked && hover === item.id && hint && onOpenKeys && (
                    <div className="px-2 pb-1">
                      <UnlockHint hint={hint} onOpen={onOpenKeys} />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
  );

  if (inline) return <div className="w-full">{menu}</div>;

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
            setTool(null);
            setChoices(null);
            setError(null);
            return;
          }
          setOpen(true);
          if (assets && entries.length === 1) openEntry(entries[0]);
          else {
            setTool(null);
            setChoices(null);
          }
        }}
        className={
          compact
            ? "rounded-full bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15"
            : "rounded-xl border border-white/10 px-3 py-2 text-sm whitespace-nowrap text-zinc-200 hover:bg-white/5"
        }
      >
        {label}
      </button>
      {menu}
    </div>
  );
}

/** Selection bar: one upscale job per selected asset. Hidden when none of them can be upscaled. */
export function BulkUpscale({
  items,
  tools,
  keyed,
  onOpenKeys,
  onStarted,
}: {
  items: readonly ToolAsset[];
  tools: readonly ToolView[];
  keyed?: ReadonlySet<string>;
  onOpenKeys?: () => void;
  onStarted: () => void;
}) {
  const kinds = new Set(items.map((item) => item.kind));
  if (items.length === 0) return null;
  if (kinds.size !== 1 || (!kinds.has("image") && !kinds.has("video"))) {
    if (![...kinds].some((kind) => kind === "image" || kind === "video")) return null;
    return <span className="text-xs text-zinc-400">Select images or videos, not a mix.</span>;
  }
  const kind = [...kinds][0];
  const available = toolsForKind(tools, kind).filter((tool) => tool.menu === "Upscale");
  if (available.length === 0) return null;
  return (
    <ToolsMenu
      kind={kind}
      assets={items}
      tools={available}
      keyed={keyed}
      onOpenKeys={onOpenKeys}
      onStarted={onStarted}
      placement="down"
      label="Upscale"
      compact
    />
  );
}

function AudioPicker({
  source,
  onSource,
  choices,
  audioKey,
  onAudio,
  uploading,
  canUpload,
  onFile,
}: {
  source: "library" | "new";
  onSource: (source: "library" | "new") => void;
  choices: readonly ToolAudioChoice[];
  audioKey: string;
  onAudio: (key: string) => void;
  uploading: boolean;
  canUpload: boolean;
  onFile: (file: File) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-body text-fg">Audio</legend>
      <div className="flex gap-3">
        <label className="flex items-center gap-1.5 text-body text-fg">
          <input
            type="radio"
            name="lipsync-audio-source"
            value="library"
            checked={source === "library"}
            onChange={() => onSource("library")}
            data-testid="lipsync-audio-library"
            className="accent-[var(--color-accent)]"
          />
          From Uploads
        </label>
        <label className="flex items-center gap-1.5 text-body text-fg">
          <input
            type="radio"
            name="lipsync-audio-source"
            value="new"
            checked={source === "new"}
            onChange={() => onSource("new")}
            data-testid="lipsync-audio-new"
            disabled={!canUpload}
            className="accent-[var(--color-accent)]"
          />
          Upload new
        </label>
      </div>
      {source === "library" ? (
        <label className="block text-body text-fg-muted">
          Uploaded audio
          <select
            aria-label="Uploaded audio"
            data-testid="lipsync-audio-select"
            value={audioKey}
            onChange={(event) => onAudio(event.target.value)}
            className="mt-1 w-full rounded-md border border-line bg-surface-3 px-2 py-1.5 text-body text-fg outline-none"
          >
            <option value="" className="bg-panel">
              Choose audio
            </option>
            {choices.map((item) => (
              <option key={item.key} value={item.key} className="bg-panel">
                {item.name}
                {item.duration !== undefined ? ` · ${item.duration.toFixed(1)}s` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <input
          type="file"
          accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,.mp3,.wav"
          aria-label="Upload audio"
          data-testid="lipsync-audio-file"
          disabled={uploading || !canUpload}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onFile(file);
          }}
          className="block w-full text-body text-fg file:mr-2 file:rounded-md file:border-0 file:bg-accent file:px-2 file:py-1 file:text-body file:font-semibold file:text-accent-fg"
        />
      )}
      {source === "library" && choices.length === 0 && (
        <p className="text-body text-fg-muted">No audio in Uploads yet. Upload a new file.</p>
      )}
      {uploading && <p className="text-body text-fg-muted">Uploading audio…</p>}
    </fieldset>
  );
}

function paramValue(field: ToolFieldView, value: string | boolean | undefined): string | number | boolean {
  if (field.type === "boolean") return value === true;
  if (field.type === "number") return Number(value);
  return typeof value === "string" ? value : "";
}

function Field({
  field,
  value,
  onChange,
}: {
  field: ToolFieldView;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="size-3.5 accent-[var(--color-accent)]"
        />
        {field.label}
      </label>
    );
  }
  if (field.type === "number") {
    return (
      <label className="block text-body text-fg-muted">
        {field.label}
        <input
          type="number"
          inputMode="decimal"
          aria-label={field.label}
          min={field.min}
          max={field.max}
          step={field.step ?? "any"}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-md border border-line bg-surface-3 px-2 py-1.5 text-body text-fg outline-none"
        />
      </label>
    );
  }
  if (field.type === "enum") {
    return (
      <label className="block text-xs text-zinc-400">
        {field.label}
        <select
          aria-label={field.label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-sm text-zinc-100 outline-none"
        >
          {field.options.map((option) => (
            <option key={option} value={option} className="bg-panel">
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="block text-xs text-zinc-400">
      {field.label}
      <input
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-sm text-zinc-100 outline-none"
      />
    </label>
  );
}
