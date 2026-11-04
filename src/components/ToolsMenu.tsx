"use client";

// Tools for the asset on screen. The list is already limited to that asset's kind.
// Upscale models that share a menu name collapse into one item with a model picker.

import { useState } from "react";
import { availabilityFor, availabilityHint, routeProviders } from "@/lib/registry/availability";
import { toolsForKind, type ToolAsset, type ToolFieldView, type ToolView } from "@/lib/toolTypes";
import { formatUpscaleCost, planBulkToolJobs, upscaleCost } from "@/lib/upscaleQuote";
import { api } from "./api";
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
      description: tool.menu ? "Increase the resolution." : tool.description,
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
}) {
  const available = toolsForKind(tools, kind);
  const entries = menuEntries(available);
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<ToolView[] | null>(null);
  const [tool, setTool] = useState<ToolView | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

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

  async function run() {
    if (!tool) return;
    if (!assets && !assetKey) return;
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
        : [{ toolId: tool.id, assetIds: [assetKey!], params }];
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
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`absolute z-20 w-80 rounded-xl border border-white/10 bg-panel p-2 text-left shadow-2xl shadow-black/50 ${
            placement === "down" ? "top-full left-0 mt-2" : "right-0 bottom-full mb-2"
          }`}
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
              {tool.fields.map((field) => (
                <Field
                  key={field.name}
                  field={field}
                  value={values[field.name]}
                  onChange={(value) => setValues((prev) => ({ ...prev, [field.name]: value }))}
                />
              ))}
              {tool.menu === "Upscale" && (
                <p className="text-xs text-zinc-200">
                  {estimate === undefined ? "Estimate unavailable." : `Est. cost ${formatUpscaleCost(estimate)}`}
                </p>
              )}
              {error && <p className="text-xs text-red-300">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-accent py-2 text-sm font-semibold text-ink disabled:opacity-40"
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
      )}
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
