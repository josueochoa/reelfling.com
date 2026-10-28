"use client";

import { useRef, useState } from "react";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Not an image"));
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error("Image must be under 10 MB"));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function useImagePicker(onFiles: (urls: string[]) => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  async function handle(files: FileList | null) {
    if (!files?.length) return;
    const results = await Promise.allSettled([...files].map(readAsDataUrl));
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) alert((failed as PromiseRejectedResult).reason.message);
    if (ok.length) onFiles(ok);
  }

  return {
    open: () => inputRef.current?.click(),
    dragging,
    dropProps: {
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: () => setDragging(false),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        handle(e.dataTransfer.files);
      },
    },
    input: (multiple: boolean) => (
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={multiple}
        hidden
        onChange={(e) => {
          handle(e.target.files);
          e.target.value = "";
        }}
      />
    ),
  };
}

export function ImageSlot({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value?: string;
  onChange: (v: string | undefined) => void;
  disabled?: boolean;
}) {
  const picker = useImagePicker((urls) => onChange(urls[0]));

  if (value) {
    return (
      <div className="group relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={value} alt={label} className="size-full object-cover" />
        <span className="absolute top-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-zinc-300">
          {label}
        </span>
        <button
          onClick={() => onChange(undefined)}
          className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-black/70 text-xs opacity-0 transition group-hover:opacity-100"
          aria-label={`Remove ${label}`}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        disabled={disabled}
        onClick={picker.open}
        {...picker.dropProps}
        className={`flex aspect-video flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-xs transition disabled:cursor-not-allowed disabled:opacity-30 ${
          picker.dragging
            ? "border-accent bg-accent/5 text-accent"
            : "border-white/15 text-zinc-500 hover:border-white/30 hover:text-zinc-300"
        }`}
      >
        <span className="text-lg leading-none">＋</span>
        {label}
        <span className="text-[10px] text-zinc-600">optional</span>
      </button>
      {picker.input(false)}
    </>
  );
}

interface RefListProps {
  max: number;
  value: string[];
  onAdd: (items: string[]) => void;
  onRemove: (index: number) => void;
  /** Insert this reference's mention into the prompt. */
  onMention: (index: number) => void;
}

export function ReferenceImages({ max, value, onAdd, onRemove, onMention }: RefListProps) {
  const picker = useImagePicker((urls) => onAdd(urls.slice(0, max - value.length)));

  return (
    <div>
      <div className="mb-2 flex justify-between text-xs font-medium tracking-wide text-zinc-400 uppercase">
        <span>Reference images</span>
        <span className="text-zinc-500 normal-case">
          {value.length}/{max}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2" {...picker.dropProps}>
        {value.map((src, i) => (
          <div key={i} className="group relative aspect-square overflow-hidden rounded-lg border border-white/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={`Reference ${i + 1}`} className="size-full object-cover" />
            <button
              onClick={() => onMention(i)}
              title="Insert into prompt"
              className="absolute inset-x-1 bottom-1 rounded bg-black/70 px-1 text-[10px] whitespace-nowrap hover:bg-accent hover:text-ink"
            >
              @Image {i + 1}
            </button>
            <button
              onClick={() => onRemove(i)}
              className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-black/70 text-[10px] opacity-0 group-hover:opacity-100"
              aria-label={`Remove reference ${i + 1}`}
            >
              ✕
            </button>
          </div>
        ))}
        {value.length < max && (
          <button
            onClick={picker.open}
            className={`grid aspect-square place-items-center rounded-lg border border-dashed text-lg transition ${
              picker.dragging ? "border-accent text-accent" : "border-white/15 text-zinc-500 hover:border-white/30"
            }`}
          >
            ＋
          </button>
        )}
      </div>
      {picker.input(true)}
    </div>
  );
}

export function UrlList({
  label,
  kind,
  placeholder,
  max,
  value,
  onAdd,
  onRemove,
  onMention,
}: RefListProps & { label: string; kind: "Video" | "Audio"; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const valid = /^https?:\/\/\S+$/.test(draft.trim());

  function add() {
    if (!valid || value.length >= max) return;
    onAdd([draft.trim()]);
    setDraft("");
  }

  return (
    <div>
      <div className="mb-2 flex justify-between text-xs font-medium tracking-wide text-zinc-400 uppercase">
        <span>{label}</span>
        <span className="text-zinc-500 normal-case">
          {value.length}/{max}
        </span>
      </div>
      <ul className="space-y-1.5">
        {value.map((url, i) => (
          <li key={i} className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-xs">
            <button
              onClick={() => onMention(i)}
              title="Insert into prompt"
              className="rounded bg-white/10 px-1.5 py-0.5 whitespace-nowrap text-zinc-300 hover:bg-accent hover:text-ink"
            >
              @{kind} {i + 1}
            </button>
            <span className="min-w-0 flex-1 truncate text-zinc-400">{url}</span>
            <button onClick={() => onRemove(i)} className="text-zinc-500 hover:text-white">
              ✕
            </button>
          </li>
        ))}
      </ul>
      {value.length < max && (
        <div className="mt-1.5 flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder={placeholder}
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs outline-none placeholder:text-zinc-600 focus:border-accent/60"
          />
          <button
            onClick={add}
            disabled={!valid}
            className="rounded-lg border border-white/10 px-2.5 text-xs text-zinc-300 disabled:opacity-30"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
