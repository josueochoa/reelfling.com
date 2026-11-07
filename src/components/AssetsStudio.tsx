"use client";

// The Assets tab: everything in the user's bucket, generated and uploaded, in one place,
// plus their teammates' files (read-only: open and download).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { lookupModelName } from "@/lib/registry/lookup";
import { Play } from "@/components/ui/Icon";
import { Select } from "@/components/ui/Select";
import { confirmToast, toast } from "@/components/ui/Toast";
import type { ToolView } from "@/lib/toolTypes";
import { assetFileUrl, type AssetItem, type AssetSource, type UploadKind } from "@/lib/uploads";
import { apiJson, type Me } from "./api";
import { fileSrc, fromServer, thumbSrc, type Library, type LibraryItem } from "./library";
import { OwnerBadge, ownerName, useTeamRefresh } from "./Owner";
import { BulkUpscale } from "./ToolsMenu";
import { MediaVisual, UploadOverlay, formatDuration, useLazyThumbs, usePlayer } from "./MediaBlocks";
import { Viewer } from "./Viewer";
import { formatCreated, type ViewerDetail } from "./viewer/model";
import { formatBytes } from "./UserMenu";

const KINDS: { value: UploadKind | "all"; label: string; icon: ReactNode }[] = [
  { value: "all", label: "All assets", icon: "▦" },
  { value: "image", label: "Images", icon: "▣" },
  { value: "video", label: "Videos", icon: <Play className="size-3.5" aria-hidden /> },
  { value: "audio", label: "Audio", icon: "♪" },
];
const SOURCES: { value: AssetSource | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "generated", label: "Generated" },
  { value: "upload", label: "Uploaded" },
  { value: "processed", label: "Processed" },
];

const modelLabel = (id: string) => lookupModelName(id);

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
  a.href = assetFileUrl(item.key, { download: true, owner: item.owner?.id });
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
  tools,
  onToolJob,
  onOpenKeys,
}: {
  me: Me | null;
  library: Library;
  /** The tab is showing: refresh, since generations may have finished elsewhere. */
  active: boolean;
  onUseInImage: (item: LibraryItem) => void;
  onUseInVideo: (item: LibraryItem) => void;
  /** Generated assets were deleted, so the Video and Image tabs should refresh. */
  onDeleted: () => void;
  tools: readonly ToolView[];
  /** A tool job was created and should show in the feed. */
  onToolJob: () => void;
  onOpenKeys: () => void;
}) {
  const keyed = new Set(me?.keys.map((key) => key.provider) ?? []);
  const [kind, setKind] = useState<UploadKind | "all">("all");
  const [source, setSource] = useState<AssetSource | "all">("all");
  const [model, setModel] = useState("");
  const [query, setQuery] = useState("");
  /** "" is everyone, "me" the viewer, else a teammate's user id. */
  const [person, setPerson] = useState("");
  const [teamList, setTeamList] = useState<LibraryItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const grid = useRef<HTMLDivElement>(null);
  const player = usePlayer();
  const { reload } = library;
  const hasTeammates = !!me?.teammates;
  // Left over from before the user left their last team: not shown.
  const teamItems = hasTeammates ? teamList : [];
  const loadTeam = useCallback(() => {
    if (!hasTeammates) return;
    apiJson<AssetItem[]>("/api/assets?team=1")
      .then((list) => setTeamList(list.map(fromServer)))
      .catch(() => {});
  }, [hasTeammates]);

  useEffect(() => {
    if (!active) return;
    void reload();
    loadTeam();
  }, [active, reload, loadTeam]);
  useTeamRefresh(active && hasTeammates, loadTeam);

  const items = [...library.items.filter((i) => i.status === "ready" || i.source === "upload"), ...teamItems].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  const people = [...new Map(teamItems.flatMap((i) => (i.owner ? [[i.owner.id, i.owner] as const] : []))).values()];
  const q = query.trim().toLowerCase();
  const shown = items.filter(
    (i) =>
      (kind === "all" || i.kind === kind) &&
      (source === "all" || i.source === source) &&
      (!model || i.generation?.model === model) &&
      (!person || (person === "me" ? !i.owner : i.owner?.id === person)) &&
      (!q || i.name.toLowerCase().includes(q) || i.generation?.prompt.toLowerCase().includes(q)),
  );
  useLazyThumbs(grid, shown, library.ensureThumb);

  const models = [...new Set(items.flatMap((i) => (i.generation ? [i.generation.model] : [])))];
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
    const ok = await confirmToast(msg, { confirmLabel: "Delete" });
    if (!ok) return;
    setSelected(new Set());
    setPreviewId(null);
    await library.removeMany(ids).catch((e) => toast((e as Error).message, { tone: "error" }));
    if (list.some((i) => i.source === "generated")) onDeleted();
  }

  const previewIndex = shown.findIndex((i) => i.id === previewId);
  const previewing = previewIndex >= 0 ? shown[previewIndex] : undefined;
  const usage = me?.storage;

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* A sidebar from md; a scrolling row of filters above the grid on phones. */}
      <aside className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/5 bg-panel p-2 [scrollbar-width:none] md:w-56 md:flex-col md:border-r md:border-b-0 md:p-3 lg:w-64">
        {KINDS.map((k, i) => {
          const s = stats(k.value);
          return (
            <div key={k.value} className="shrink-0">
              {i === 1 && <p className="hidden px-3 pt-4 pb-1 text-xs text-zinc-500 md:block">By type</p>}
              <button
                onClick={() => setKind(k.value)}
                className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm transition md:gap-3 md:px-3 md:py-2.5 ${
                  kind === k.value ? "bg-white/10 text-white ring-1 ring-accent/50" : "text-zinc-300 hover:bg-white/5"
                }`}
              >
                <span className="grid size-7 place-items-center rounded-lg bg-white/10 text-xs">{k.icon}</span>
                <span className="flex-1">{k.label}</span>
                <span className="text-right text-[11px] leading-tight text-zinc-500 tabular-nums">
                  {s.count}
                  <span className="hidden md:block">{formatBytes(s.bytes)}</span>
                </span>
              </button>
            </div>
          );
        })}
        {usage && (
          <div className="mt-auto hidden px-3 pt-6 text-xs md:block">
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
              <BulkUpscale
                items={items
                  .filter((item) => selected.has(item.id) && item.key)
                  .map((item) => ({
                    key: item.key,
                    kind: item.kind,
                    width: item.width,
                    height: item.height,
                    duration: item.duration,
                  }))}
                tools={tools}
                keyed={keyed}
                onOpenKeys={onOpenKeys}
                onStarted={() => {
                  setSelected(new Set());
                  onToolJob();
                }}
              />
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
              {people.length > 0 && (
                <Select
                  label="Made by"
                  value={person}
                  onChange={setPerson}
                  options={[
                    { value: "", label: "Everyone" },
                    { value: "me", label: "Me" },
                    ...people.map((owner) => ({ value: owner.id, label: owner.name ?? ownerName(owner) })),
                  ]}
                />
              )}
              {models.length > 0 && (
                <Select
                  label="Model"
                  value={model}
                  onChange={setModel}
                  options={[
                    { value: "", label: "All models" },
                    ...models.map((m) => ({ value: m, label: modelLabel(m) })),
                  ]}
                />
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
            // Only the viewer's own files can be selected: the bulk actions delete and run tools.
            const ids = g.items.flatMap((i) => (i.owner ? [] : [i.id]));
            const all = ids.length > 0 && ids.every((id) => selected.has(id));
            return (
              <section key={g.label}>
                <label className="mb-3 flex w-fit cursor-pointer items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={all}
                    disabled={!ids.length}
                    onChange={() => toggle(ids, !all)}
                    className="size-4 accent-[var(--color-accent)] disabled:opacity-30"
                  />
                  {g.label}
                  <span className="text-xs font-normal text-zinc-500">{g.items.length}</span>
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
                  {g.items.map((item) => {
                    const isSelected = selected.has(item.id);
                    const pick = () => (selecting && !item.owner ? toggle([item.id], !isSelected) : setPreviewId(item.id));
                    return (
                      <div
                        key={item.id}
                        data-asset-id={item.id}
                        role="button"
                        tabIndex={0}
                        onClick={pick}
                        onKeyDown={(e) => e.key === "Enter" && setPreviewId(item.id)}
                        title={item.generation?.prompt ?? item.name}
                        className={`group relative aspect-square cursor-pointer overflow-hidden rounded-xl border transition ${
                          isSelected ? "border-accent ring-2 ring-accent/60" : "border-white/10 hover:border-white/30"
                        }`}
                      >
                        <MediaVisual
                          item={item}
                          player={player}
                          onPreview={pick}
                        />
                        <UploadOverlay item={item} />
                        {item.owner ? (
                          <OwnerBadge owner={item.owner} className="absolute top-2 left-2" />
                        ) : (
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
                        )}
                        <span className="absolute bottom-2 left-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-200">
                          {item.source === "processed"
                            ? `✦ ${tools.find((tool) => tool.id === item.tool)?.name ?? item.name}${item.resolution ? ` · ${item.resolution}` : ""}`
                            : item.source === "generated"
                              ? `✦ ${modelLabel(item.generation?.model ?? "")}`
                              : "⇪ Upload"}
                        </span>
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
        <Viewer
          label="Preview"
          title={previewing.name}
          kind={previewing.kind}
          src={fileSrc(previewing)}
          poster={previewing.kind === "video" ? thumbSrc(previewing) : undefined}
          alt={previewing.name}
          prompt={previewing.generation?.prompt || previewing.name}
          details={
            previewing.owner
              ? [{ label: "Made by", value: previewing.owner.name ?? previewing.owner.email }, ...libraryDetails(previewing)]
              : libraryDetails(previewing)
          }
          peaks={previewing.peaks}
          onClose={() => setPreviewId(null)}
          onPrev={previewIndex > 0 ? () => setPreviewId(shown[previewIndex - 1].id) : undefined}
          onNext={previewIndex < shown.length - 1 ? () => setPreviewId(shown[previewIndex + 1].id) : undefined}
          onUseAsReference={
            previewing.owner
              ? undefined
              : () => {
                  setPreviewId(null);
                  onUseInVideo(previewing);
                }
          }
          referenceLabel="Use in Video"
          onDownload={() => download(previewing)}
          onDelete={previewing.owner ? undefined : () => void remove([previewing.id])}
          tools={previewing.owner ? undefined : tools}
          toolKind={previewing.kind === "image" || previewing.kind === "video" ? previewing.kind : undefined}
          assetKey={previewing.key}
          toolAsset={{ width: previewing.width, height: previewing.height, duration: previewing.duration }}
          keyed={keyed}
          onOpenKeys={onOpenKeys}
          onToolJob={() => {
            setPreviewId(null);
            onToolJob();
          }}
          lineage={lineageFor(
            previewing,
            items.filter((other) => other.owner?.id === previewing.owner?.id),
            tools,
            setPreviewId,
          )}
          extra={
            previewing.kind === "image" && !previewing.owner ? (
              <button
                type="button"
                onClick={() => {
                  setPreviewId(null);
                  onUseInImage(previewing);
                }}
                className="mt-3 w-full rounded-md border border-line py-2 text-body text-fg"
              >
                Use in Image
              </button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

function lineageFor(
  item: LibraryItem,
  all: LibraryItem[],
  tools: readonly ToolView[],
  open: (id: string) => void,
) {
  const parent = item.parentId ? all.find((other) => other.key === item.parentId) : undefined;
  const children = all.filter((other) => other.parentId && other.parentId === item.key);
  const toolName = tools.find((tool) => tool.id === item.tool)?.name;
  if (!parent && !children.length && !toolName) return undefined;
  return {
    toolName,
    parent: parent ? { id: parent.id, name: parent.name } : undefined,
    children: children.map((child) => ({ id: child.id, name: child.name })),
    onOpen: open,
  };
}

function libraryDetails(item: LibraryItem): ViewerDetail[] {
  const rows: ViewerDetail[] = [];
  if (item.generation?.model) rows.push({ label: "Model", value: lookupModelName(item.generation.model) });
  const size = item.resolution ?? (item.width && item.height ? `${item.width}×${item.height}` : undefined);
  if (size) rows.push({ label: "Resolution", value: size });
  const duration = formatDuration(item.duration);
  if (duration) rows.push({ label: "Duration", value: duration });
  rows.push({ label: "Created", value: formatCreated(item.createdAt) });
  return rows;
}
