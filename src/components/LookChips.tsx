"use client";

// Look chips: one choice per group, Auto by default. A saved look sets every group at once.

import { useId, useState, type KeyboardEvent } from "react";
import { moveIndex } from "@/components/ui/a11y";
import { apiJson } from "@/components/api";
import {
  applySavedLook,
  keptLook,
  lookGroups,
  PALETTE_COLOR_MAX,
  PALETTE_CUSTOM,
  type LookChoice,
  type LookGroup,
  type SavedLook,
} from "@/lib/registry/looks";

const chipClass = (active: boolean) =>
  `rounded-md border px-2.5 py-1.5 text-label motion-reduce:transition-none ${
    active
      ? "border-accent bg-accent-soft text-accent"
      : "border-line bg-surface-2 text-fg-muted hover:border-line-strong hover:text-fg"
  }`;

function HexField({ color, label, onCommit }: { color: string; label: string; onCommit: (hex: string) => void }) {
  const [draft, setDraft] = useState(color);
  return (
    <input
      value={draft}
      aria-label={label}
      spellCheck={false}
      maxLength={7}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        const hex = next.startsWith("#") ? next : `#${next}`;
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) onCommit(hex.toLowerCase());
      }}
      className="w-20 rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-label text-fg"
    />
  );
}

export function LookChips({
  value,
  onChange,
  looks,
  onLooks,
}: {
  value: LookChoice;
  onChange: (next: LookChoice) => void;
  looks: readonly SavedLook[];
  onLooks: (next: SavedLook[]) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const nameId = useId();
  const choice = keptLook(value);
  const colors = choice.palette === PALETTE_CUSTOM ? (choice.colors ?? []) : [];

  function select(group: LookGroup, id: string) {
    if (id === "auto") {
      const next: LookChoice = { ...choice };
      delete next[group];
      if (group === "palette") delete next.colors;
      onChange(keptLook(next));
      return;
    }
    if (group === "palette" && id === PALETTE_CUSTOM) {
      onChange(keptLook({ ...choice, palette: PALETTE_CUSTOM, colors: colors.length ? colors : ["#c6f432"] }));
      return;
    }
    const next: LookChoice = { ...choice, [group]: id };
    if (group === "palette") delete next.colors;
    onChange(keptLook(next));
  }

  function onChipKey(event: KeyboardEvent<HTMLButtonElement>, group: LookGroup, index: number) {
    const options = lookGroups.find((item) => item.id === group)?.options ?? [];
    const key = event.key;
    if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
    event.preventDefault();
    const next =
      key === "Home" ? 0 : key === "End" ? options.length - 1 : moveIndex(index, key === "ArrowRight" ? 1 : -1, options.length);
    select(group, options[next].id);
    queueMicrotask(() => document.getElementById(`${group}-${options[next].id}`)?.focus());
  }

  function setColor(index: number, hex: string) {
    const next = [...colors];
    next[index] = hex;
    onChange(keptLook({ ...choice, palette: PALETTE_CUSTOM, colors: next }));
  }

  async function save() {
    setMessage("");
    setSaving(true);
    try {
      const saved = await apiJson<SavedLook[]>("/api/looks", {
        method: "POST",
        body: JSON.stringify({ name, choice }),
      });
      onLooks(saved);
      setName("");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setMessage("");
    try {
      onLooks(await apiJson<SavedLook[]>(`/api/looks?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
    } catch (e) {
      setMessage((e as Error).message);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-label tracking-wide text-fg-subtle uppercase">Saved</p>
        {looks.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {looks.map((look) => (
              <span key={look.id} className="inline-flex items-center gap-1">
                <button
                  type="button"
                  data-testid="saved-look"
                  className={chipClass(false)}
                  onClick={() => onChange(applySavedLook(look))}
                >
                  {look.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete look ${look.name}`}
                  onClick={() => void remove(look.id)}
                  className="grid size-6 place-items-center rounded-md text-fg-muted hover:bg-surface-3 hover:text-fg"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!saving && name.trim()) void save();
          }}
        >
          <label htmlFor={nameId} className="sr-only">
            Look name
          </label>
          <input
            id={nameId}
            data-testid="look-name"
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name this look"
            className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-label text-fg placeholder:text-fg-subtle"
          />
          <button
            type="submit"
            data-testid="save-look"
            disabled={saving || !name.trim()}
            className="rounded-md bg-accent px-2.5 py-1.5 text-label font-semibold text-accent-fg disabled:opacity-40"
          >
            Save look
          </button>
        </form>
        {message && (
          <p role="alert" className="mt-1.5 text-label text-red-300">
            {message}
          </p>
        )}
      </div>

      {lookGroups.map((group) => {
        const selected = choice[group.id] ?? "auto";
        const index = Math.max(0, group.options.findIndex((option) => option.id === selected));
        return (
          <div key={group.id}>
            <p id={`${group.id}-label`} className="mb-1.5 text-label tracking-wide text-fg-subtle uppercase">
              {group.label}
            </p>
            <div role="radiogroup" aria-labelledby={`${group.id}-label`} className="flex flex-wrap gap-1.5" data-testid={`look-${group.id}`}>
              {group.options.map((option, optionIndex) => {
                const active = option.id === selected;
                return (
                  <button
                    key={option.id}
                    id={`${group.id}-${option.id}`}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={optionIndex === index ? 0 : -1}
                    data-testid={`look-option-${group.id}-${option.id}`}
                    onClick={() => select(group.id, option.id)}
                    onKeyDown={(event) => onChipKey(event, group.id, optionIndex)}
                    className={chipClass(active)}
                  >
                    {option.name}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {choice.palette === PALETTE_CUSTOM && (
        <div>
          <p className="mb-1.5 text-label text-fg-muted">
            Up to {PALETTE_COLOR_MAX} colors. In references mode, models that take images get a swatch. Frames mode, and models without image references, put the colors in the prompt.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {colors.map((color, index) => (
              <div key={`${color}-${index}`} className="flex items-center gap-1">
                <input
                  type="color"
                  aria-label={`Palette color ${index + 1}`}
                  data-testid={`palette-color-${index}`}
                  value={color}
                  onChange={(event) => setColor(index, event.target.value.toLowerCase())}
                  className="size-8 cursor-pointer rounded-md border border-line bg-transparent"
                />
                <HexField key={color} color={color} label={`Palette color ${index + 1} hex`} onCommit={(hex) => setColor(index, hex)} />
                <button
                  type="button"
                  aria-label={`Remove palette color ${index + 1}`}
                  onClick={() => onChange(keptLook({ ...choice, palette: PALETTE_CUSTOM, colors: colors.filter((_, at) => at !== index) }))}
                  className="grid size-6 place-items-center rounded-md text-fg-muted hover:bg-surface-3 hover:text-fg"
                >
                  ×
                </button>
              </div>
            ))}
            {colors.length < PALETTE_COLOR_MAX && (
              <button
                type="button"
                data-testid="add-palette-color"
                onClick={() => onChange(keptLook({ ...choice, palette: PALETTE_CUSTOM, colors: [...colors, "#888888"] }))}
                className={chipClass(false)}
              >
                Add color
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
