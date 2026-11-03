"use client";

// Tools for the asset on screen. The list is already limited to that asset's kind.

import { useState } from "react";
import { toolsForKind, type ToolFieldView, type ToolView } from "@/lib/toolTypes";
import { api } from "./api";

export function ToolsMenu({
  kind,
  assetKey,
  tools,
  onStarted,
}: {
  kind: string;
  /** Library key. Absent until the file is stored. */
  assetKey?: string;
  tools: readonly ToolView[];
  /** The job is in the feed. */
  onStarted: () => void;
}) {
  const available = toolsForKind(tools, kind);
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<ToolView | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (kind !== "image" && kind !== "video") return null;

  function show(next: ToolView) {
    const initial: Record<string, string | boolean> = {};
    for (const field of next.fields) {
      if (field.type === "boolean") initial[field.name] = field.default ?? false;
      else if (field.type === "enum" || field.type === "string") initial[field.name] = field.default ?? "";
      else if (field.default !== undefined) initial[field.name] = String(field.default);
    }
    setTool(next);
    setValues(initial);
    setError(null);
  }

  async function run() {
    if (!tool || !assetKey) return;
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, string | number | boolean> = {};
      for (const field of tool.fields) params[field.name] = paramValue(field, values[field.name]);
      const res = await api("/api/fal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolId: tool.id, assetIds: [assetKey], params }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `Couldn't start the tool (${res.status})`);
        return;
      }
      setOpen(false);
      setTool(null);
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setTool(null);
          setError(null);
        }}
        className="rounded-xl border border-white/10 px-3 py-2 text-sm whitespace-nowrap text-zinc-200 hover:bg-white/5"
      >
        Tools
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Tools"
          className="absolute right-0 bottom-full z-20 mb-2 w-72 rounded-xl border border-white/10 bg-panel p-2 text-left shadow-2xl shadow-black/50"
        >
          {!assetKey ? (
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
                onClick={() => setTool(null)}
                className="text-[11px] text-zinc-500 hover:text-white"
              >
                ← {tool.name}
              </button>
              {tool.fields.map((field) => (
                <Field
                  key={field.name}
                  field={field}
                  value={values[field.name]}
                  onChange={(value) => setValues((prev) => ({ ...prev, [field.name]: value }))}
                />
              ))}
              {error && <p className="text-xs text-red-300">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-accent py-2 text-sm font-semibold text-ink disabled:opacity-40"
              >
                {busy ? "Starting…" : "Run"}
              </button>
            </form>
          ) : available.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-zinc-500">No {kind} tools yet.</p>
          ) : (
            available.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                onClick={() => show(item)}
                className="block w-full rounded-lg px-2 py-2 text-left hover:bg-white/5"
              >
                <span className="block text-sm text-zinc-100">{item.name}</span>
                {item.description && <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">{item.description}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
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
