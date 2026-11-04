"use client";

// Any fal endpoint: an id plus a JSON input. Field errors from a 422 render here, inline.

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { shouldCancelFal, shouldPollFal, type FalFieldError, type FalJobView } from "@/lib/falTypes";
import { availabilityFor, availabilityHint } from "@/lib/registry/availability";
import { assetFileUrl } from "@/lib/uploads";
import { api, type Me } from "./api";
import { UnlockHint } from "./UnlockHint";

export interface FalTabHandle {
  reload: () => void;
}

const POLL_MS = 4000;
const needsPoll = (job: FalJobView) => shouldPollFal(job.status);

const STATUS_LABEL: Record<FalJobView["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))}s</>;
}

function FieldErrors({ fields }: { fields?: FalFieldError[] }) {
  if (!fields?.length) return null;
  return (
    <ul className="space-y-1" aria-live="polite">
      {fields.map((field) => (
        <li key={`${field.field}:${field.message}`} className="text-xs text-red-300">
          <span className="font-mono text-red-200">{field.field}</span>
          <span className="text-zinc-500"> — </span>
          {field.message}
        </li>
      ))}
    </ul>
  );
}

function OutputPreview({ output }: { output: FalJobView["outputs"][number] }) {
  const src = assetFileUrl(output.key);
  if (output.contentType.startsWith("video/"))
    return <video src={src} controls playsInline className="max-h-80 w-full rounded-lg bg-black" />;
  if (output.contentType.startsWith("audio/")) return <audio src={src} controls className="w-full" />;
  if (output.contentType.startsWith("image/"))
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" className="max-h-80 w-full rounded-lg object-contain bg-black" />
    );
  return (
    <a href={assetFileUrl(output.key, { download: true })} className="text-xs text-zinc-300 underline">
      Download
    </a>
  );
}

export function FalStudio({
  ref,
  me,
  onOpenKeys,
}: {
  ref?: React.Ref<FalTabHandle>;
  me: Me | null;
  onOpenKeys: () => void;
}) {
  const [jobs, setJobs] = useState<FalJobView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [endpointId, setEndpointId] = useState("");
  const [input, setInput] = useState('{\n  "prompt": ""\n}');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FalFieldError[]>([]);
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const falAvail = me ? availabilityFor(["fal"], new Set(me.keys.map((key) => key.provider))) : null;
  const needsKey = !!falAvail && !falAvail.available;
  const falHint = falAvail ? availabilityHint(falAvail.needs) : "";

  const upsert = useCallback((job: FalJobView) => {
    setJobs((prev) => {
      const i = prev.findIndex((item) => item.id === job.id);
      if (i === -1) return [job, ...prev];
      const next = [...prev];
      next[i] = job;
      return next;
    });
  }, []);

  const reload = useCallback(() => {
    api("/api/fal")
      .then(async (res) => {
        if (res.ok) setJobs(await res.json());
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useImperativeHandle(ref, () => ({ reload }), [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const timer = setInterval(() => {
      const pending = jobsRef.current.filter(needsPoll);
      void Promise.all(
        pending.map(async (job) => {
          try {
            const res = await api(`/api/fal/${job.id}`);
            if (res.ok) upsert(await res.json());
          } catch {
            // A 401 sends the user to /login. Anything else must not reject the timer.
          }
        }),
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [upsert]);

  async function submit() {
    if (needsKey) return;
    setError(null);
    setFields([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      setError("Input isn't valid JSON");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("Input must be a JSON object");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api("/api/fal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpointId, input: parsed }),
      });
      const body = (await res.json()) as FalJobView & { error?: string; fields?: FalFieldError[] };
      if (res.status === 422) {
        setFields(body.fields?.length ? body.fields : [{ field: "input", message: body.error ?? "fal rejected this input" }]);
        return;
      }
      if (!res.ok) {
        setError(body.error ?? `Request failed (${res.status})`);
        return;
      }
      upsert(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(job: FalJobView) {
    setJobs((prev) => prev.filter((item) => item.id !== job.id));
    const res = await api(`/api/fal/${job.id}`, { method: "DELETE" });
    if (!res.ok) reload();
  }

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto px-4 pt-4 pb-80">
        {!loaded ? null : jobs.length === 0 ? (
          <div className="grid h-[55%] place-items-center text-center">
            <div>
              <p className="text-lg font-medium text-zinc-300">No fal jobs yet</p>
              <p className="mt-1 max-w-md text-sm text-zinc-500">
                Paste any endpoint id and a JSON input. Results are saved to Assets even if you close this tab.
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {jobs.map((job) => (
              <article key={job.id} className="rounded-2xl border border-white/5 bg-panel p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          job.status === "failed"
                            ? "bg-red-400/15 text-red-300"
                            : job.status === "succeeded"
                              ? "bg-accent/15 text-accent"
                              : "bg-white/10 text-zinc-300"
                        }`}
                      >
                        {STATUS_LABEL[job.status]}
                      </span>
                      <p className={`truncate text-xs ${job.tool ? "text-zinc-200" : "font-mono text-zinc-400"}`}>
                        {job.tool?.name ?? job.endpointId}
                      </p>
                    </div>
                    {job.prompt && <p className="mt-2 line-clamp-3 text-sm text-zinc-200">{job.prompt}</p>}
                    {needsPoll(job) && (
                      <div className="mt-3">
                        <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                          <div className="shimmer h-full w-1/2 rounded-full bg-accent/80" />
                        </div>
                        <p className="mt-1.5 text-[11px] text-zinc-500">
                          {STATUS_LABEL[job.status]}
                          {job.queuePosition !== undefined ? ` · position ${job.queuePosition}` : ""}
                          {" · "}
                          <Elapsed since={job.createdAt} />
                        </p>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => void remove(job)}
                    className="shrink-0 rounded-lg px-2 py-1 text-xs text-zinc-500 hover:text-red-300"
                  >
                    {shouldCancelFal(job.status) ? "Cancel" : "Delete"}
                  </button>
                </div>
                {(job.status === "failed" || job.error) && (
                  <div className="mt-3 space-y-1">
                    <FieldErrors fields={job.fields} />
                    {job.error && !job.fields?.length && <p className="text-xs text-red-300">{job.error}</p>}
                  </div>
                )}
                {job.outputs.length > 0 && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {job.outputs.map((output) => (
                      <OutputPreview key={output.key} output={output} />
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4">
        <form
          className="pointer-events-auto mx-auto max-w-3xl space-y-2 rounded-2xl border border-white/10 bg-panel/95 p-3 shadow-2xl shadow-black/40 backdrop-blur"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {needsKey && (
            <div className="px-1">
              <UnlockHint hint={falHint} onOpen={onOpenKeys} />
            </div>
          )}
          <input
            value={endpointId}
            onChange={(e) => setEndpointId(e.target.value)}
            placeholder="Endpoint id, e.g. fal-ai/flux/schnell"
            aria-label="fal endpoint id"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-sm outline-none focus:border-accent/60"
          />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="fal JSON input"
            spellCheck={false}
            rows={5}
            className="w-full resize-y rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-sm outline-none focus:border-accent/60"
          />
          <p className="px-1 text-[11px] text-zinc-500">
            Library files go in as <span className="font-mono">upload:your-key</span> and are sent as signed links.
          </p>
          <FieldErrors fields={fields} />
          {error && <p className="px-1 text-xs text-red-300">{error}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting || needsKey || !endpointId.trim()}
              className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed ${
                needsKey ? "cursor-not-allowed bg-white/10 text-zinc-500" : "bg-accent text-ink disabled:opacity-40"
              }`}
            >
              {submitting ? "Submitting…" : "Run"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
