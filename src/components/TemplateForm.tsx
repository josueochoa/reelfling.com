"use client";

import { useRef, useState } from "react";
import { availabilityFor, availabilityHint, routeProviders } from "@/lib/registry/availability";
import { estimateRouteCost, type VideoModel } from "@/lib/registry";
import {
  buildTemplateRequest,
  categoryLabel,
  type SlotInput,
  type VideoTemplate,
} from "@/lib/templates/templates";
import type { GenerateRequest } from "@/lib/types";
import { UnlockHint } from "./UnlockHint";
import { fileSrc, thumbSrc, type Library } from "./library";

interface Draft {
  text: string;
  image?: string;
  key?: string;
  preview?: string;
  pending?: boolean;
}

function draftsFrom(
  template: VideoTemplate,
  initial: Readonly<Record<string, SlotInput>> | undefined,
  library: Library,
): Record<string, Draft> {
  const drafts: Record<string, Draft> = {};
  for (const slot of template.slots) {
    const value = initial?.[slot.id];
    if (slot.kind === "text") {
      drafts[slot.id] = { text: value?.text ?? "" };
      continue;
    }
    const item = value?.key ? library.items.find((entry) => entry.key === value.key && entry.status === "ready") : undefined;
    if (item?.key) {
      drafts[slot.id] = {
        text: "",
        image: `upload:${item.key}`,
        key: item.key,
        preview: thumbSrc(item) ?? (item.kind === "image" ? fileSrc(item) : undefined),
      };
    } else if (value?.key && !library.loaded) {
      drafts[slot.id] = { text: "", image: `upload:${value.key}`, key: value.key };
    } else {
      drafts[slot.id] = { text: "" };
    }
  }
  return drafts;
}

export function TemplateForm({
  template,
  models,
  modelsReady,
  keyed,
  library,
  initial,
  onGenerate,
  onBack,
  onOpenKeys,
  error,
}: {
  template: VideoTemplate;
  models: readonly VideoModel[];
  /** False until the video model list has been fetched. */
  modelsReady: boolean;
  keyed: ReadonlySet<string>;
  library: Library;
  initial?: Readonly<Record<string, SlotInput>>;
  onGenerate: (req: GenerateRequest) => Promise<boolean>;
  onBack: () => void;
  onOpenKeys: () => void;
  error: string | null;
}) {
  const model = models.find((item) => item.id === template.model);
  const gate = model ? availabilityFor(routeProviders(model.routes), keyed) : undefined;
  const cost = model
    ? estimateRouteCost(model, template.route, {
        resolution: template.resolution,
        duration: template.duration,
        audio: !!template.audio,
      })
    : undefined;
  const [drafts, setDrafts] = useState(() => draftsFrom(template, initial, library));
  const draftsRef = useRef(drafts);
  const inflight = useRef(new Set<Promise<void>>());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const missingRestore = template.slots.filter(
    (slot) => slot.kind !== "text" && initial?.[slot.id]?.key && library.loaded && !drafts[slot.id]?.key,
  );

  function setDraft(id: string, patch: Partial<Draft>) {
    const current = draftsRef.current[id] ?? { text: "" };
    const next = { ...draftsRef.current, [id]: { ...current, ...patch } };
    draftsRef.current = next;
    setDrafts(next);
  }

  async function pickImage(id: string, file: File | undefined) {
    if (!file) return;
    const job = (async () => {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setFormError("");
      setDraft(id, { pending: true });
      try {
        const { items, errors } = await library.add([file]);
        if (errors[0] || !items[0]) throw new Error(errors[0] || "Couldn't add that image");
        const ready = await library.whenReady(items[0].id);
        if (!ready.key) throw new Error("Couldn't add that image");
        setDraft(id, {
          image: `upload:${ready.key}`,
          key: ready.key,
          preview: items[0].localThumb || thumbSrc(ready),
          pending: false,
        });
      } catch (e) {
        setDraft(id, { pending: false });
        setFieldErrors((prev) => ({ ...prev, [id]: (e as Error).message }));
      }
    })();
    inflight.current.add(job);
    try {
      await job;
    } finally {
      inflight.current.delete(job);
    }
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setFormError("");
    try {
      await Promise.all([...inflight.current]);
    } catch {
      setSubmitting(false);
      return;
    }
    const latest = draftsRef.current;
    const values: Record<string, SlotInput> = {};
    for (const slot of template.slots) {
      const draft = latest[slot.id];
      values[slot.id] = slot.kind === "text" ? { text: draft?.text ?? "" } : { image: draft?.image, key: draft?.key };
    }
    const built = buildTemplateRequest(template, values);
    if (!built.request) {
      setFieldErrors(Object.fromEntries(built.errors.filter((item) => item.id).map((item) => [item.id, item.message])));
      setFormError(built.errors.find((item) => !item.id)?.message ?? "Fill the required fields.");
      setSubmitting(false);
      return;
    }
    if (!model || !gate?.available) {
      setSubmitting(false);
      return;
    }
    setFieldErrors({});
    await onGenerate(built.request).finally(() => setSubmitting(false));
  }

  const blocked = !model || !gate?.available;

  return (
    <form
      data-testid="template-form"
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5">
        <div className="space-y-1">
          <button type="button" onClick={onBack} className="text-body text-fg-muted hover:text-fg">
            Back to composer
          </button>
          <p className="text-label tracking-wide text-fg-muted uppercase">{categoryLabel(template.category)}</p>
          <h2 className="text-title text-fg">{template.name}</h2>
          <p className="text-body text-fg-muted">{template.summary}</p>
          <p className="text-label text-fg-muted">
            {model?.name ?? "Loading model"} · {template.duration}s · {template.ratio} · {template.resolution}
          </p>
        </div>
        {missingRestore.length > 0 && (
          <p className="rounded-md bg-surface-3 px-3 py-2 text-body text-fg">
            {missingRestore.map((slot) => slot.label).join(", ")} {missingRestore.length === 1 ? "is" : "are"} no longer
            in your uploads. Add {missingRestore.length === 1 ? "it" : "them"} again.
          </p>
        )}
        {template.slots.map((slot) => {
          const draft = drafts[slot.id] ?? { text: "" };
          const fieldId = `template-slot-${slot.id}`;
          const message = fieldErrors[slot.id];
          const optional = slot.required ? "" : " (optional)";
          if (slot.kind === "text") {
            return (
              <div key={slot.id} className="space-y-1.5">
                <label htmlFor={fieldId} className="text-label tracking-wide text-fg-muted uppercase">
                  {slot.label}
                  {optional}
                </label>
                {slot.hint && (
                  <p id={`${fieldId}-hint`} className="text-body text-fg-muted">
                    {slot.hint}
                  </p>
                )}
                <input
                  id={fieldId}
                  data-testid={fieldId}
                  value={draft.text}
                  maxLength={slot.maxLength ?? 160}
                  aria-required={slot.required}
                  aria-invalid={!!message}
                  aria-describedby={message ? `${fieldId}-error` : slot.hint ? `${fieldId}-hint` : undefined}
                  onChange={(event) => {
                    setDraft(slot.id, { text: event.target.value });
                    if (message) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next[slot.id];
                        return next;
                      });
                    }
                  }}
                  className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-body text-fg"
                />
                {message && (
                  <p id={`${fieldId}-error`} className="text-body text-fg">
                    {message}
                  </p>
                )}
              </div>
            );
          }
          return (
            <div key={slot.id} className="space-y-1.5">
              <label htmlFor={fieldId} className="text-label tracking-wide text-fg-muted uppercase">
                {slot.label}
                {optional}
              </label>
              {slot.hint && (
                <p id={`${fieldId}-hint`} className="text-body text-fg-muted">
                  {slot.hint}
                </p>
              )}
              {draft.preview && (
                <div className="relative aspect-video overflow-hidden rounded-md border border-line bg-ink">
                  {/* Local preview of a file the user just picked. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={draft.preview} alt="" className="size-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setDraft(slot.id, { image: undefined, key: undefined, preview: undefined })}
                    className="absolute top-2 right-2 rounded-md bg-ink px-2 py-1 text-label text-fg"
                  >
                    Remove
                  </button>
                </div>
              )}
              <input
                id={fieldId}
                data-testid={fieldId}
                type="file"
                accept="image/jpeg,image/png,image/*"
                aria-required={slot.required}
                aria-invalid={!!message}
                aria-describedby={message ? `${fieldId}-error` : slot.hint ? `${fieldId}-hint` : undefined}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void pickImage(slot.id, file);
                }}
                className="block w-full text-body text-fg file:mr-3 file:rounded-md file:border-0 file:bg-surface-3 file:px-3 file:py-2 file:text-body file:text-fg"
              />
              {draft.pending && <p className="text-body text-fg-muted">Uploading…</p>}
              {message && (
                <p id={`${fieldId}-error`} className="text-body text-fg">
                  {message}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-line p-5">
        {(formError || error) && (
          <p data-testid="template-error" role="alert" className="mb-3 rounded-md bg-surface-3 px-3 py-2 text-body text-fg">
            {formError || error}
          </p>
        )}
        {!model && (
          <p className="mb-3 text-body text-fg-muted">
            {modelsReady ? "This model isn't in the video list." : "Model list is still loading."}
          </p>
        )}
        {model && gate && !gate.available && (
          <div className="mb-3">
            <UnlockHint hint={availabilityHint(gate.needs)} onOpen={onOpenKeys} />
          </div>
        )}
        <button
          type="submit"
          data-testid="template-generate"
          disabled={submitting || blocked}
          className={`flex w-full items-center justify-center gap-2 rounded-md py-3 text-body font-semibold disabled:cursor-not-allowed ${
            blocked ? "bg-surface-3 text-fg-muted" : "bg-accent text-accent-fg disabled:opacity-40"
          }`}
        >
          {submitting ? (
            <span className="size-4 animate-spin rounded-full border-2 border-accent-fg/30 border-t-accent-fg motion-reduce:animate-none" />
          ) : (
            "Generate"
          )}
          <span className="text-label font-normal opacity-80">
            {template.resolution} · {template.duration}s
            {cost !== undefined && ` · ~$${cost.toFixed(2)}`}
          </span>
        </button>
      </div>
    </form>
  );
}
