"use client";

import { useRef, useState } from "react";
import { Modal, type ModalSize } from "@/components/ui/Modal";
import { Popover } from "@/components/ui/Popover";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { confirmToast, toast } from "@/components/ui/Toast";
import { Check, Download, Lock, Play, RotateCcw, X } from "@/components/ui/Icon";

const SWATCHES = [
  ["ink", "bg-ink"],
  ["panel", "bg-panel"],
  ["surface-2", "bg-surface-2"],
  ["surface-3", "bg-surface-3"],
  ["line", "bg-line"],
  ["line-strong", "bg-line-strong"],
  ["fg", "bg-fg"],
  ["fg-muted", "bg-fg-muted"],
  ["fg-subtle", "bg-fg-subtle"],
  ["accent", "bg-accent"],
] as const;

export function Gallery() {
  const [modal, setModal] = useState<ModalSize | null>(null);
  const [menu, setMenu] = useState(false);
  const [ratio, setRatio] = useState("16:9");
  const [deleted, setDeleted] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  return (
    <main className="min-h-dvh bg-ink px-6 py-10 text-fg">
      <div className="mx-auto flex max-w-3xl flex-col gap-10">
        <header>
          <p className="text-label tracking-wide text-fg-subtle uppercase">ReelFling</p>
          <h1 className="text-display mt-1">Primitives</h1>
          <p className="mt-2 max-w-xl text-body text-fg-muted">
            Dev-only gallery for the shared controls. Nothing here calls a provider.
          </p>
        </header>

        <section>
          <h2 className="text-title">Color</h2>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {SWATCHES.map(([name, bg]) => (
              <div key={name} className="overflow-hidden rounded-md border border-line">
                <div className={`h-12 ${bg}`} />
                <p className="bg-panel px-2 py-1 text-label text-fg-muted">{name}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 inline-flex rounded-md bg-accent px-3 py-1.5 text-body font-semibold text-accent-fg">
            Accent fill, near-black text
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-title">Type</h2>
          <p className="text-label text-fg-subtle">Label 11 / 500</p>
          <p className="text-body">Body 13. The quick brown fox jumps over the lazy dog.</p>
          <p className="text-title">Title 15 / 600</p>
          <p className="text-display">Display</p>
        </section>

        <section>
          <h2 className="text-title">Modal</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["sm", "md", "lg", "full"] as const).map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => setModal(size)}
                className="rounded-md border border-line bg-surface-2 px-3 py-1.5 text-body capitalize hover:border-line-strong"
              >
                {size}
              </button>
            ))}
          </div>
          <Modal
            open={modal !== null}
            size={modal ?? "md"}
            onClose={() => setModal(null)}
            title={`${modal ?? ""} dialog`}
            description="Tab stays inside. Escape or the backdrop closes it and returns focus here."
          >
            <p className="text-body text-fg-muted">A second control, so the trap has somewhere to go.</p>
            <button
              type="button"
              onClick={() => setModal(null)}
              className="mt-4 rounded-md bg-accent px-3 py-1.5 text-body font-semibold text-accent-fg"
            >
              Done
            </button>
          </Modal>
        </section>

        <section>
          <h2 className="text-title">Popover</h2>
          <button
            ref={anchor}
            type="button"
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
            className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-1.5 text-body"
          >
            Open menu
          </button>
          <Popover open={menu} onClose={() => setMenu(false)} anchorRef={anchor} className="w-52 p-1">
            {["Duplicate", "Rename", "Details"].map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMenu(false)}
                className="block w-full rounded-md px-2.5 py-2 text-left text-body hover:bg-white/10"
              >
                {item}
              </button>
            ))}
          </Popover>
        </section>

        <section className="flex flex-wrap items-start gap-6">
          <div>
            <h2 className="text-title">Select</h2>
            <div className="mt-3">
              <Select
                label="Ratio"
                value={ratio}
                onChange={setRatio}
                options={[
                  { value: "16:9", label: "16:9", subtitle: "Landscape" },
                  { value: "9:16", label: "9:16", subtitle: "Portrait" },
                  { value: "1:1", label: "1:1", subtitle: "Square" },
                  { value: "21:9", label: "21:9", subtitle: "Not on this model", locked: true },
                ]}
              />
            </div>
          </div>
          <div>
            <h2 className="text-title">Locked</h2>
            <div className="mt-3">
              <Select label="Quality" value="720p" onChange={() => {}} locked options={[{ value: "720p", label: "720p" }]} />
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-title">Toast</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => toast("Couldn't read that image. Use a file under 10 MB.", { tone: "error" })}
              className="rounded-md border border-line bg-surface-2 px-3 py-1.5 text-body"
            >
              Error toast
            </button>
            <button
              type="button"
              onClick={() =>
                void confirmToast("Delete this generation? This can't be undone.", { confirmLabel: "Delete" }).then(
                  (ok) => setDeleted(ok),
                )
              }
              className="rounded-md border border-line bg-surface-2 px-3 py-1.5 text-body"
            >
              Confirm delete
            </button>
          </div>
          <p className="mt-2 text-label text-fg-subtle">{deleted ? "Confirmed." : "Not confirmed."}</p>
        </section>

        <section>
          <h2 className="text-title">Icons</h2>
          <div className="mt-3 flex gap-3 text-fg-muted">
            <X className="size-4" aria-label="Close" />
            <Check className="size-4 text-accent" aria-label="Selected" />
            <Download className="size-4" aria-label="Download" />
            <RotateCcw className="size-4" aria-label="Reuse" />
            <Play className="size-4" aria-label="Play" />
            <Lock className="size-4" aria-label="Locked" />
          </div>
        </section>

        <section>
          <h2 className="text-title">Skeleton</h2>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Skeleton className="aspect-video" />
            <Skeleton className="aspect-square" />
            <div className="space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
