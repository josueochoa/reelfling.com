"use client";

import { useImperativeHandle, useRef, useState } from "react";
import { segmentPrompt, type RefCounts, type RefKind } from "@/lib/mentions";

export interface MentionItem {
  token: string; // "@Image 2"
  kind: RefKind;
  n: number;
  thumb?: string;
  detail?: string;
}

export interface PromptEditorHandle {
  insert: (token: string) => void;
}

interface Props {
  ref?: React.Ref<PromptEditorHandle>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  mentions: MentionItem[];
  counts: RefCounts;
}

const ALIASES: Record<RefKind, string[]> = { Image: ["image", "img"], Video: ["video", "vid"], Audio: ["audio"] };

function matches(item: MentionItem, query: string) {
  const q = query.toLowerCase();
  return ALIASES[item.kind].some((a) => `${a}${item.n}`.startsWith(q) || (q.length <= a.length && a.startsWith(q)));
}

// Shared box metrics so the highlight layer lines up with the textarea text.
const BOX = "px-3.5 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words";

export function PromptEditor({ ref, value, onChange, onSubmit, placeholder, mentions, counts }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<{ start: number; query: string; active: number } | null>(null);

  const options = popup ? mentions.filter((m) => matches(m, popup.query)) : [];
  const showPopup = popup !== null && options.length > 0;

  function setCaret(pos: number) {
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    });
  }

  function detect(text: string, caret: number) {
    const m = text.slice(0, caret).match(/(^|[\s([{"'])@(\w*)$/);
    setPopup(m ? { start: caret - m[2].length - 1, query: m[2], active: 0 } : null);
  }

  function choose(item: MentionItem) {
    if (!popup) return;
    const caret = taRef.current?.selectionStart ?? value.length;
    const after = value.slice(caret);
    const next = value.slice(0, popup.start) + item.token + (after.startsWith(" ") ? "" : " ") + after;
    onChange(next);
    setPopup(null);
    setCaret(popup.start + item.token.length + 1);
  }

  useImperativeHandle(ref, () => ({
    insert(token) {
      const ta = taRef.current;
      const caret = ta && document.activeElement === ta ? ta.selectionStart : value.length;
      const before = value.slice(0, caret);
      const after = value.slice(caret);
      const lead = before === "" || /\s$/.test(before) ? "" : " ";
      const trail = after.startsWith(" ") ? "" : " ";
      onChange(before + lead + token + trail + after);
      setCaret(before.length + lead.length + token.length + 1);
    },
  }));

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (showPopup) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setPopup((p) => p && { ...p, active: (p.active + d + options.length) % options.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(options[Math.min(popup!.active, options.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPopup(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
  }

  return (
    <div className="relative">
      <div className="relative rounded-xl border border-white/10 bg-white/[0.03] focus-within:border-accent/60">
        <div
          ref={backdropRef}
          aria-hidden
          className={`pointer-events-none absolute inset-0 overflow-hidden text-transparent ${BOX}`}
        >
          {segmentPrompt(value, counts).map((s, i) =>
            s.mention ? (
              <mark
                key={i}
                className={`rounded-sm text-transparent ${s.mention === "ok" ? "bg-accent/25" : "bg-red-500/35"}`}
              >
                {s.text}
              </mark>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
          {/* keeps a trailing newline from collapsing */}
          {"​"}
        </div>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            detect(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => detect(value, e.currentTarget.selectionStart)}
          onBlur={() => setPopup(null)}
          onScroll={(e) => {
            if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          rows={5}
          placeholder={placeholder}
          className={`relative block max-h-80 min-h-32 w-full resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-zinc-600 ${BOX}`}
        />
      </div>

      {showPopup && (
        <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-panel p-1 shadow-2xl shadow-black/60">
          {options.map((item, i) => (
            <li key={item.token}>
              <button
                // mousedown, not click, so the textarea keeps focus
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(item);
                }}
                onMouseEnter={() => setPopup((p) => p && { ...p, active: i })}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm ${
                  i === popup!.active ? "bg-white/10" : ""
                }`}
              >
                <MentionThumb item={item} />
                <span className="text-zinc-100">{item.token}</span>
                {item.detail && (
                  <span className="min-w-0 flex-1 truncate text-right text-xs text-zinc-500">{item.detail}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MentionThumb({ item }: { item: MentionItem }) {
  if (item.thumb)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={item.thumb} alt="" className="size-8 shrink-0 rounded-md object-cover" />;
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-white/10 text-xs text-zinc-300">
      {item.kind === "Video" ? "▶" : "♪"}
    </span>
  );
}
