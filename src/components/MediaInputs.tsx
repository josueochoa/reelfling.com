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

function useImagePicker(onFiles: (urls: string[]) => void, onFile?: (file: File) => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  async function handle(files: FileList | null) {
    if (!files?.length) return;
    // Library uploads (so the file has an R2 key Reuse can restore). The caller validates it.
    if (onFile) {
      onFile(files[0]);
      return;
    }
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
  onFile,
  disabled,
  testId,
}: {
  label: string;
  value?: string;
  onChange: (v: string | undefined) => void;
  /** When set, a picked file is handed over instead of being read as a data URL. */
  onFile?: (file: File) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const picker = useImagePicker((urls) => onChange(urls[0]), onFile);

  if (value) {
    return (
      <div data-testid={testId} className="group relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={value} alt={label} className="size-full object-cover" />
        <span className="absolute top-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-zinc-300">
          {label}
        </span>
        <button
          onClick={() => onChange(undefined)}
          className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-black/70 text-xs"
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
        data-testid={testId}
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
