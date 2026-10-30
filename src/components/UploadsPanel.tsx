"use client";

// Picker for references: the user's assets, uploads first (generated ones one click away).

import { useRef, useState } from "react";
import type { AssetSource, UploadKind } from "@/lib/uploads";
import { ACCEPT, type Library, type LibraryItem } from "./library";
import { MediaVisual, UploadOverlay, useLazyThumbs, usePlayer } from "./MediaBlocks";
import { MediaPreview } from "./MediaPreview";
import { formatBytes } from "./UserMenu";

const FILTERS: { value: UploadKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
];

export function UploadsPanel({
  library,
  selected,
  onToggle,
  onDelete,
  onClose,
}: {
  library: Library;
  /** Items currently used as references → their mention ("@Image 2"). */
  selected: Map<string, string>;
  onToggle: (item: LibraryItem) => void;
  onDelete: (item: LibraryItem) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const player = usePlayer();
  const [filter, setFilter] = useState<UploadKind | "all">("all");
  const [source, setSource] = useState<AssetSource | "all">("upload");
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const shown = library.items.filter(
    (i) =>
      (source === "all" || i.source === source) &&
      (filter === "all" || i.kind === filter) &&
      (!q || i.name.toLowerCase().includes(q)),
  );

  useLazyThumbs(grid, shown, library.ensureThumb);
  const previewIndex = shown.findIndex((i) => i.id === previewId);
  const previewing = previewIndex >= 0 ? shown[previewIndex] : undefined;
  function openPreview(item: LibraryItem) {
    player.stop();
    setPreviewId(item.id);
  }

  async function addFiles(files: File[]) {
    if (!files.length) return;
    const { errors } = await library.add(files);
    setErrors(errors);
  }

  return (
    <section
      className="relative flex min-h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-white/5 bg-ink/80 px-6 py-3 backdrop-blur">
        <div className="flex gap-1 rounded-full bg-white/[0.04] p-1 text-sm">
          {(
            [
              ["upload", "Uploads"],
              ["generated", "Generated"],
              ["all", "All"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setSource(value)}
              className={`rounded-full px-3.5 py-1 ${source === value ? "bg-white font-semibold text-ink" : "text-zinc-400 hover:text-white"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-full bg-white/[0.04] p-1 text-xs">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full px-3 py-1 ${filter === f.value ? "bg-white/15 text-white" : "text-zinc-400 hover:text-white"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name"
          className="w-40 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs outline-none placeholder:text-zinc-600 focus:border-accent/60"
        />
        <span className="text-xs text-zinc-500">
          {shown.length} {shown.length === 1 ? "file" : "files"}
        </span>
        <button
          onClick={onClose}
          aria-label="Close uploads"
          className="ml-auto grid size-8 place-items-center rounded-full bg-white/5 text-zinc-300 hover:bg-white/10"
        >
          ✕
        </button>
      </div>

      {errors.length > 0 && (
        <div className="mx-6 mt-4 flex items-start gap-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <ul className="flex-1 space-y-0.5">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <button onClick={() => setErrors([])} aria-label="Dismiss" className="text-red-300/70 hover:text-red-200">
            ✕
          </button>
        </div>
      )}

      <div ref={grid} className="grid grid-cols-2 gap-3 p-6 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        <button
          onClick={() => input.current?.click()}
          className={`flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm transition ${
            dragging
              ? "border-accent bg-accent/5 text-accent"
              : "border-white/15 text-zinc-400 hover:border-white/30 hover:text-zinc-200"
          }`}
        >
          <span className="grid size-10 place-items-center rounded-full bg-white/10 text-lg">⇪</span>
          Upload file
          <span className="px-4 text-center text-[11px] text-zinc-600">Images, video or audio. Or drop them here.</span>
        </button>

        {shown.map((item) => {
          const label = selected.get(item.id);
          return (
            <div
              key={item.id}
              data-asset-id={item.id}
              role="button"
              tabIndex={0}
              onClick={() => item.status === "ready" && onToggle(item)}
              onKeyDown={(e) => e.key === "Enter" && item.status === "ready" && onToggle(item)}
              title={label ? "Remove from references" : "Add to references"}
              className={`group relative aspect-square cursor-pointer overflow-hidden rounded-xl border transition ${
                label ? "border-accent ring-2 ring-accent/60" : "border-white/10 hover:border-white/30"
              }`}
            >
              <MediaVisual item={item} player={player} onPreview={() => openPreview(item)} />
              <UploadOverlay item={item} />
              {label && (
                <span className="absolute top-2 left-2 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-ink">
                  {label}
                </span>
              )}
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                <IconButton label="Preview" onClick={() => openPreview(item)}>
                  ⤢
                </IconButton>
                {item.source === "upload" && (
                  <IconButton label="Rename" onClick={() => setEditing(item.id)}>
                    ✎
                  </IconButton>
                )}
                <IconButton
                  label="Delete"
                  onClick={() => {
                    const what =
                      item.source === "generated"
                        ? item.kind === "video"
                          ? "this generated video (and its generation)"
                          : "this generated image"
                        : `“${item.name}” from your uploads`;
                    if (confirm(`Delete ${what}? This can't be undone.`)) onDelete(item);
                  }}
                >
                  🗑
                </IconButton>
              </div>
              {editing === item.id ? (
                <RenameField
                  initial={item.name}
                  onDone={(name) => {
                    setEditing(null);
                    if (name !== null) void library.rename(item.id, name);
                  }}
                />
              ) : (
                item.kind !== "audio" && (
                  <p className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2 pt-4 pb-1.5 text-[11px] text-zinc-200 opacity-0 transition group-hover:opacity-100">
                    {item.name} · {formatBytes(item.bytes)}
                  </p>
                )
              )}
            </div>
          );
        })}
      </div>

      {library.loaded && library.items.length === 0 && (
        <p className="px-6 text-sm text-zinc-500">
          No uploads yet. Files you add to references are kept here to reuse.
        </p>
      )}

      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void addFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />

      {previewing && (
        <MediaPreview
          item={previewing}
          label={selected.get(previewing.id)}
          onToggle={() => onToggle(previewing)}
          onPrev={previewIndex > 0 ? () => setPreviewId(shown[previewIndex - 1].id) : undefined}
          onNext={previewIndex < shown.length - 1 ? () => setPreviewId(shown[previewIndex + 1].id) : undefined}
          onClose={() => setPreviewId(null)}
        />
      )}
    </section>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid size-7 place-items-center rounded-full bg-black/70 text-xs text-white hover:bg-black"
    >
      {children}
    </button>
  );
}

/** Inline name editor: Enter or blur saves, Escape cancels (onDone(null)). */
function RenameField({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(initial);
  // Enter saves, then the input unmounts and blurs: only finish once.
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      autoFocus
      value={name}
      maxLength={120}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(name);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(name)}
      onFocus={(e) => e.currentTarget.select()}
      className="absolute inset-x-1.5 bottom-1.5 rounded-md border border-accent/60 bg-black/90 px-2 py-1 text-xs text-white outline-none"
    />
  );
}
