"use client";

// The Assets tab: everything in the user's bucket, generated and uploaded, in one place.

import { useEffect, useRef, useState } from "react";
import { getImageModel } from "@/lib/imageModels";
import { getModel } from "@/lib/models";
import { assetFileUrl, type AssetSource, type UploadKind } from "@/lib/uploads";
import { withWorkspace, type Me } from "./api";
import type { Library, LibraryItem } from "./library";
import { MediaVisual, UploadOverlay, useLazyThumbs, usePlayer } from "./MediaBlocks";
import { MediaPreview } from "./MediaPreview";
import { Avatar } from "./Teams";
import { formatBytes } from "./UserMenu";

const KINDS: { value: UploadKind | "all"; label: string; icon: string }[] = [
  { value: "all", label: "All assets", icon: "▦" },
  { value: "image", label: "Images", icon: "▣" },
  { value: "video", label: "Videos", icon: "▶" },
  { value: "audio", label: "Audio", icon: "♪" },
];
const SOURCES: { value: AssetSource | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "generated", label: "Generated" },
  { value: "upload", label: "Uploaded" },
];

const modelLabel = (id: string) => getModel(id)?.label ?? getImageModel(id)?.label ?? id;

/** "Today", "Yesterday", a weekday this week, else a date. */
function dayLabel(ts: number, now: number) {
  const day = (t: number) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / 86_400_000);
  const diff = day(now) - day(ts);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const d = new Date(ts);
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(d.getFullYear() !== new Date(now).getFullYear() && { year: "numeric" }),
  });
}

/** Starts a download without leaving the page. */
function download(item: LibraryItem) {
  if (!item.key) return;
  const a = document.createElement("a");
  a.href = withWorkspace(assetFileUrl(item.key, { download: true }));
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function AssetsStudio({
  me,
  library,
  active,
  onUseInImage,
  onUseInVideo,
  onDeleted,
}: {
  me: Me | null;
  library: Library;
  /** The tab is showing: refresh, since generations may have finished elsewhere. */
  active: boolean;
  onUseInImage: (item: LibraryItem) => void;
  onUseInVideo: (item: LibraryItem) => void;
  /** Generated assets were deleted, so the Video and Image tabs should refresh. */
  onDeleted: () => void;
}) {
  const [kind, setKind] = useState<UploadKind | "all">("all");
  const [source, setSource] = useState<AssetSource | "all">("all");
  const [model, setModel] = useState("");
  const [creator, setCreator] = useState("");
  const team = me?.workspace.kind === "team";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const grid = useRef<HTMLDivElement>(null);
  const player = usePlayer();
  const { reload } = library;

  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  const items = library.items.filter((i) => i.status === "ready" || i.source === "upload");
  const q = query.trim().toLowerCase();
  const shown = items.filter(
    (i) =>
      (kind === "all" || i.kind === kind) &&
      (source === "all" || i.source === source) &&
      (!model || i.generation?.model === model) &&
      (!creator || i.createdBy?.id === creator) &&
      (!q || i.name.toLowerCase().includes(q) || i.generation?.prompt.toLowerCase().includes(q)),
  );
  useLazyThumbs(grid, shown, library.ensureThumb);

  const models = [...new Set(items.flatMap((i) => (i.generation ? [i.generation.model] : [])))];
  const creators = [
    ...new Map(items.flatMap((i) => (i.createdBy ? [[i.createdBy.id, i.createdBy] as const] : []))).values(),
  ];
  const stats = (k: UploadKind | "all") => {
    const list = items.filter((i) => k === "all" || i.kind === k);
    return { count: list.length, bytes: list.reduce((n, i) => n + i.bytes, 0) };
  };
  const groups: { label: string; items: LibraryItem[] }[] = [];
  for (const item of shown) {
    const label = dayLabel(item.createdAt, now);
    if (groups.at(-1)?.label === label) groups.at(-1)!.items.push(item);
    else groups.push({ label, items: [item] });
  }

  const selecting = selected.size > 0;
  const toggle = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  async function remove(ids: string[]) {
    const list = items.filter((i) => ids.includes(i.id));
    const videos = list.filter((i) => i.source === "generated" && i.kind === "video").length;
    const msg =
      `Delete ${list.length === 1 ? "this asset" : `${list.length} assets`}? This can't be undone.` +
      (videos
        ? `\n${videos === 1 ? "The generated video's" : `${videos} generated videos'`} generation goes too.`
        : "");
    if (!confirm(msg)) return;
    setSelected(new Set());
    setPreviewId(null);
    await library.removeMany(ids).catch((e) => alert((e as Error).message));
    if (list.some((i) => i.source === "generated")) onDeleted();
  }

  const previewIndex = shown.findIndex((i) => i.id === previewId);
  const previewing = previewIndex >= 0 ? shown[previewIndex] : undefined;
  const usage = me?.storage;

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <aside className="flex shrink-0 flex-col gap-1 border-b border-white/5 bg-panel p-3 lg:w-64 lg:border-r lg:border-b-0">
        {KINDS.map((k, i) => {
          const s = stats(k.value);
          return (
            <div key={k.value}>
              {i === 1 && <p className="px-3 pt-4 pb-1 text-xs text-zinc-500">By type</p>}
              <button
                onClick={() => setKind(k.value)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                  kind === k.value ? "bg-white/10 text-white ring-1 ring-accent/50" : "text-zinc-300 hover:bg-white/5"
                }`}
              >
                <span className="grid size-7 place-items-center rounded-lg bg-white/10 text-xs">{k.icon}</span>
                <span className="flex-1">{k.label}</span>
                <span className="text-right text-[11px] leading-tight text-zinc-500 tabular-nums">
                  {s.count}
                  <br />
                  {formatBytes(s.bytes)}
                </span>
              </button>
            </div>
          );
        })}
        {usage && (
          <div className="mt-auto hidden px-3 pt-6 text-xs lg:block">
            <div className="flex justify-between text-zinc-400">
              <span>Storage</span>
              <span className="tabular-nums">
                {formatBytes(usage.bytes)} of {formatBytes(usage.quotaBytes)}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full ${usage.bytes >= usage.quotaBytes ? "bg-red-400" : "bg-accent"}`}
                style={{ width: `${Math.min(100, (usage.bytes / usage.quotaBytes) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </aside>

      <main ref={grid} className="min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-white/5 bg-ink/85 px-6 py-3 backdrop-blur">
          {selecting ? (
            <>
              <span className="text-sm font-medium">{selected.size} selected</span>
              <button
                onClick={() => {
                  // One at a time, so the browser doesn't drop any.
                  items.filter((i) => selected.has(i.id)).forEach((i, n) => setTimeout(() => download(i), n * 400));
                }}
                className="rounded-full bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15"
              >
                Download
              </button>
              <button
                onClick={() => void remove([...selected])}
                className="rounded-full bg-red-500/15 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/25"
              >
                Delete
              </button>
              <button onClick={() => setSelected(new Set())} className="text-xs text-zinc-400 hover:text-white">
                Clear
              </button>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold">{KINDS.find((k) => k.value === kind)!.label}</h1>
              <div className="flex gap-1 rounded-full bg-white/[0.04] p-1 text-xs">
                {SOURCES.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => setSource(s.value)}
                    className={`rounded-full px-3 py-1 ${source === s.value ? "bg-white/15 text-white" : "text-zinc-400 hover:text-white"}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {models.length > 0 && (
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  aria-label="Model"
                  className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs outline-none"
                >
                  <option value="" className="bg-panel">
                    All models
                  </option>
                  {models.map((m) => (
                    <option key={m} value={m} className="bg-panel">
                      {modelLabel(m)}
                    </option>
                  ))}
                </select>
              )}
              {team && creators.length > 0 && (
                <select
                  value={creator}
                  onChange={(e) => setCreator(e.target.value)}
                  aria-label="Created by"
                  className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs outline-none"
                >
                  <option value="" className="bg-panel">
                    Everyone
                  </option>
                  {creators.map((c) => (
                    <option key={c.id} value={c.id} className="bg-panel">
                      {c.id === me?.user.id ? "Me" : (c.name ?? c.email)}
                    </option>
                  ))}
                </select>
              )}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search prompts and names"
                className="w-52 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs outline-none placeholder:text-zinc-600 focus:border-accent/60"
              />
              <span className="ml-auto text-xs text-zinc-500">
                {shown.length} {shown.length === 1 ? "asset" : "assets"}
              </span>
            </>
          )}
        </div>

        {library.loaded && shown.length === 0 && (
          <div className="grid h-[50vh] place-items-center text-center">
            <div>
              <p className="text-lg font-medium text-zinc-300">Nothing here yet</p>
              <p className="mt-1 text-sm text-zinc-500">
                Generated videos and images, and your uploads, all show up here.
              </p>
            </div>
          </div>
        )}

        <div className="space-y-6 p-6">
          {groups.map((g) => {
            const ids = g.items.map((i) => i.id);
            const all = ids.every((id) => selected.has(id));
            return (
              <section key={g.label}>
                <label className="mb-3 flex w-fit cursor-pointer items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={all}
                    onChange={() => toggle(ids, !all)}
                    className="size-4 accent-[var(--color-accent)]"
                  />
                  {g.label}
                  <span className="text-xs font-normal text-zinc-500">{g.items.length}</span>
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
                  {g.items.map((item) => {
                    const isSelected = selected.has(item.id);
                    return (
                      <div
                        key={item.id}
                        data-asset-id={item.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => (selecting ? toggle([item.id], !isSelected) : setPreviewId(item.id))}
                        onKeyDown={(e) => e.key === "Enter" && setPreviewId(item.id)}
                        title={item.generation?.prompt ?? item.name}
                        className={`group relative aspect-square cursor-pointer overflow-hidden rounded-xl border transition ${
                          isSelected ? "border-accent ring-2 ring-accent/60" : "border-white/10 hover:border-white/30"
                        }`}
                      >
                        <MediaVisual
                          item={item}
                          player={player}
                          onPreview={() => (selecting ? toggle([item.id], !isSelected) : setPreviewId(item.id))}
                        />
                        <UploadOverlay item={item} />
                        <input
                          type="checkbox"
                          checked={isSelected}
                          aria-label="Select"
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggle([item.id], !isSelected)}
                          className={`absolute top-2 left-2 size-4 accent-[var(--color-accent)] transition ${
                            selecting ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                          }`}
                        />
                        <span className="absolute bottom-2 left-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-200">
                          {item.source === "generated" ? `✦ ${modelLabel(item.generation?.model ?? "")}` : "⇪ Upload"}
                        </span>
                        {team && item.createdBy && (
                          <span className="absolute top-2 right-2">
                            <Avatar person={item.createdBy} size="size-6" />
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </main>

      {previewing && (
        <MediaPreview
          item={previewing}
          onPrev={previewIndex > 0 ? () => setPreviewId(shown[previewIndex - 1].id) : undefined}
          onNext={previewIndex < shown.length - 1 ? () => setPreviewId(shown[previewIndex + 1].id) : undefined}
          onClose={() => setPreviewId(null)}
          actions={
            <>
              <ActionButton onClick={() => download(previewing)}>Download</ActionButton>
              {previewing.kind === "image" && (
                <ActionButton
                  onClick={() => {
                    setPreviewId(null);
                    onUseInImage(previewing);
                  }}
                >
                  Use in Image
                </ActionButton>
              )}
              <ActionButton
                onClick={() => {
                  setPreviewId(null);
                  onUseInVideo(previewing);
                }}
              >
                Use in Video
              </ActionButton>
              <ActionButton danger onClick={() => void remove([previewing.id])}>
                Delete
              </ActionButton>
            </>
          }
        />
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border border-white/10 px-3 py-2 text-sm whitespace-nowrap hover:bg-white/5 ${
        danger ? "text-red-300" : "text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}
