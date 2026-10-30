"use client";

// One box for all references: images, videos and audio as blocks, in any order.
// Mentions are numbered per kind (@Image 1, @Video 1, @Audio 1) in the order shown.

import { useRef, useState } from "react";
import { ACCEPT, type LibraryItem } from "./library";
import { MediaVisual, UploadOverlay, usePlayer } from "./MediaBlocks";
import { MediaPreview } from "./MediaPreview";

// Marks a drag that started on one of our own blocks (a reorder, not new files).
const REORDER_TYPE = "application/x-reference-index";

export interface ReferenceBlock {
  item: LibraryItem;
  /** "@Image 2" */
  label: string;
}

export function ReferenceBox({
  blocks,
  max,
  onAddFiles,
  onOpenLibrary,
  onRemove,
  onMove,
  onMention,
}: {
  blocks: ReferenceBlock[];
  max: number;
  onAddFiles: (files: File[]) => void;
  onOpenLibrary: () => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
  /** Insert this reference's mention into the prompt. */
  onMention: (index: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const player = usePlayer();
  const [fileDrag, setFileDrag] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const previewing = preview !== null ? blocks[preview] : undefined;

  const isReorder = (e: React.DragEvent) => e.dataTransfer.types.includes(REORDER_TYPE);
  const endDrag = () => {
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs font-medium tracking-wide text-zinc-400 uppercase">
        <span>
          References{" "}
          <span className="text-zinc-600 normal-case">
            {blocks.length}/{max}
          </span>
        </span>
        <button onClick={onOpenLibrary} className="text-zinc-400 normal-case hover:text-white">
          Uploads ↗
        </button>
      </div>
      <div
        className={`grid grid-cols-4 gap-2 rounded-xl border p-2 transition ${
          fileDrag ? "border-accent bg-accent/5" : "border-white/5 bg-white/[0.02]"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!isReorder(e)) setFileDrag(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileDrag(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setFileDrag(false);
          if (isReorder(e)) {
            // Dropped in the box but not on a block: move it to the end.
            onMove(Number(e.dataTransfer.getData(REORDER_TYPE)), blocks.length - 1);
            endDrag();
          } else if (e.dataTransfer.files.length) onAddFiles([...e.dataTransfer.files]);
        }}
      >
        {blocks.length < max && (
          <button
            onClick={() => input.current?.click()}
            title="Add images, video or audio"
            className="grid aspect-square place-items-center rounded-lg border border-dashed border-white/15 text-xl text-zinc-500 transition hover:border-white/30 hover:text-zinc-300"
          >
            ＋
          </button>
        )}
        {blocks.map(({ item, label }, i) => (
          <div
            key={item.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(REORDER_TYPE, String(i));
              e.dataTransfer.effectAllowed = "move";
              setDragFrom(i);
            }}
            onDragEnd={endDrag}
            onDragOver={(e) => {
              if (!isReorder(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOver(i);
            }}
            onDrop={(e) => {
              if (!isReorder(e)) return;
              e.preventDefault();
              e.stopPropagation();
              onMove(Number(e.dataTransfer.getData(REORDER_TYPE)), i);
              endDrag();
            }}
            title={`${item.name} · drag to reorder`}
            className={`group relative cursor-grab overflow-hidden rounded-lg border transition active:cursor-grabbing ${
              item.kind === "audio" ? "col-span-2 aspect-[2/1]" : "aspect-square"
            } ${dragOver === i && dragFrom !== i ? "border-accent ring-2 ring-accent/50" : "border-white/10"} ${
              dragFrom === i ? "opacity-40" : ""
            }`}
          >
            <MediaVisual
              item={item}
              player={player}
              compact
              onPreview={() => {
                player.stop();
                setPreview(i);
              }}
            />
            <UploadOverlay item={item} />
            <button
              onClick={() => onMention(i)}
              title="Insert into prompt"
              className={`absolute rounded bg-black/70 px-1 text-[10px] whitespace-nowrap hover:bg-accent hover:text-ink ${
                item.kind === "audio" ? "top-1 left-1" : "inset-x-1 bottom-1"
              }`}
            >
              {label}
            </button>
            <button
              onClick={() => onRemove(i)}
              className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-black/70 text-[10px] opacity-0 group-hover:opacity-100"
              aria-label={`Remove ${label}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-zinc-600">
        Drop images, video or audio, or pick from Uploads. Click a label to mention it.
      </p>
      {previewing && (
        <MediaPreview
          item={previewing.item}
          label={previewing.label}
          onToggle={() => {
            onRemove(preview!);
            setPreview(null);
          }}
          onPrev={preview! > 0 ? () => setPreview(preview! - 1) : undefined}
          onNext={preview! < blocks.length - 1 ? () => setPreview(preview! + 1) : undefined}
          onClose={() => setPreview(null)}
        />
      )}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          onAddFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
