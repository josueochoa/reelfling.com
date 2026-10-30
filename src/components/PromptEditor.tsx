"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { convertHiggsfieldMentions, segmentPrompt, type RefCounts, type RefKind } from "@/lib/mentions";

export interface MentionItem {
  token: string; // "@Image 2"
  kind: RefKind;
  n: number;
  thumb?: string;
  /** A playable URL for a video (e.g. a local upload's object URL); its first frame is shown. */
  preview?: string;
  detail?: string;
}

/** The mention under the pointer, and where to anchor its tooltip (viewport coords). */
interface Hover {
  index: number;
  kind: RefKind;
  n: number;
  x: number;
  top: number;
  bottom: number;
}

const TOOLTIP_W = 176; // w-44
const TOOLTIP_MAX_H = 170;

export interface PromptEditorHandle {
  insert: (token: string) => void;
}

interface Props {
  ref?: React.Ref<PromptEditorHandle>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** Files pasted into the prompt (e.g. a screenshot): attach them as references. */
  onPasteFiles?: (files: File[]) => void;
  placeholder: string;
  mentions: MentionItem[];
  counts: RefCounts;
}

const ALIASES: Record<RefKind, string[]> = {
  Image: ["image", "img", "imagen"],
  Video: ["video", "vid", "vídeo"],
  Audio: ["audio"],
};

function matches(item: MentionItem, query: string) {
  const q = query.toLowerCase();
  return ALIASES[item.kind].some((a) => `${a}${item.n}`.startsWith(q) || (q.length <= a.length && a.startsWith(q)));
}

// Shared box metrics so the highlight layer lines up with the textarea text.
const BOX = "px-3.5 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words";

export function PromptEditor({ ref, value, onChange, onSubmit, onPasteFiles, placeholder, mentions, counts }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<{ start: number; query: string; active: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  /**
   * The highlight layer sits under the textarea, so mentions never get mouse events.
   * Instead, find the mention whose rendered box (one per wrapped line) holds the pointer.
   */
  function onMouseMove(e: React.MouseEvent) {
    const marks = backdropRef.current?.querySelectorAll<HTMLElement>("mark") ?? [];
    for (const [index, mark] of [...marks].entries()) {
      for (const r of mark.getClientRects()) {
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
        if (hover?.index !== index)
          setHover({
            index,
            kind: mark.dataset.kind as RefKind,
            n: Number(mark.dataset.n),
            x: r.left + r.width / 2,
            top: r.top,
            bottom: r.bottom,
          });
        return;
      }
    }
    if (hover) setHover(null);
  }
  const hovered = hover && mentions.find((m) => m.kind === hover.kind && m.n === hover.n);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Pasting a Higgsfield prompt turns its "@[Imagen 2](image_2)" mentions into "@Image 2". */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // Files win over any text that came along (a copied image often brings its HTML too).
    const files = [...e.clipboardData.files];
    if (files.length && onPasteFiles) {
      e.preventDefault();
      onPasteFiles(files.map(namePasted));
      return;
    }
    const { text, count } = convertHiggsfieldMentions(e.clipboardData.getData("text/plain"));
    if (!count) return; // a normal paste
    e.preventDefault();
    const ta = e.currentTarget;
    // execCommand keeps the paste on the browser's undo stack, and fires onChange.
    if (!document.execCommand("insertText", false, text)) {
      const { selectionStart: start, selectionEnd: end } = ta;
      onChange(value.slice(0, start) + text + value.slice(end));
      setCaret(start + text.length);
    }
    setNotice(`Converted ${count} Higgsfield ${count === 1 ? "reference" : "references"}`);
  }

  /**
   * Keeps the highlight layer exactly under the textarea's text. clientWidth excludes the
   * scrollbar, so lines wrap at the same place even when a classic (non-overlay) scrollbar
   * appears; then the scroll offsets match too.
   */
  function syncBackdrop() {
    const ta = taRef.current;
    const bd = backdropRef.current;
    if (!ta || !bd) return;
    bd.style.width = `${ta.clientWidth}px`;
    bd.style.height = `${ta.clientHeight}px`;
    bd.scrollTop = ta.scrollTop;
  }

  // After every render (the text changed), and whenever the textarea resizes.
  useLayoutEffect(syncBackdrop);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const observer = new ResizeObserver(syncBackdrop);
    observer.observe(ta);
    return () => observer.disconnect();
  }, []);

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
          className={`pointer-events-none absolute top-0 left-0 overflow-hidden text-transparent ${BOX}`}
        >
          {segmentPrompt(value, counts).map((s, i) =>
            s.mention ? (
              <mark
                key={i}
                data-kind={s.kind}
                data-n={s.n}
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
          onPaste={onPaste}
          onScroll={() => {
            syncBackdrop();
            setHover(null);
          }}
          onMouseMove={onMouseMove}
          onMouseLeave={() => setHover(null)}
          rows={5}
          placeholder={placeholder}
          className={`relative block max-h-80 min-h-32 w-full resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-zinc-600 ${BOX}`}
        />
      </div>
      {hover && !showPopup && (
        // Fixed, so the scrolling side panel can't clip it.
        <div
          role="tooltip"
          // Centered on the mention but kept on screen; flips below it near the top.
          className={`pointer-events-none fixed z-50 -translate-x-1/2 ${
            hover.top > TOOLTIP_MAX_H ? "-translate-y-full pb-2" : "pt-2"
          }`}
          style={{
            left: Math.min(Math.max(hover.x, TOOLTIP_W / 2 + 8), window.innerWidth - TOOLTIP_W / 2 - 8),
            top: hover.top > TOOLTIP_MAX_H ? hover.top : hover.bottom,
          }}
        >
          <div className="w-44 rounded-lg border border-white/10 bg-panel p-1.5 shadow-2xl shadow-black/60">
            {hovered ? <MentionPreview item={hovered} /> : null}
            <p className={`px-0.5 pt-1 text-xs ${hovered ? "text-zinc-300" : "text-red-300"}`}>
              {hovered ? (
                <>
                  {hovered.token}
                  {hovered.detail && <span className="block truncate text-zinc-500">{hovered.detail}</span>}
                </>
              ) : (
                `No ${hover.kind.toLowerCase()} ${Number.isNaN(hover.n) ? "" : `${hover.n} `}attached`
              )}
            </p>
          </div>
        </div>
      )}

      {notice && (
        <p role="status" className="mt-1.5 text-xs text-accent">
          {notice}
        </p>
      )}

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

/** The tooltip's picture: the image, a video's first frame, or an icon. */
function MentionPreview({ item }: { item: MentionItem }) {
  const box = "aspect-video w-full rounded-md bg-black object-cover";
  if (item.thumb)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={item.thumb} alt="" className={box} />;
  if (item.preview) return <video src={`${item.preview}#t=0.1`} muted playsInline preload="metadata" className={box} />;
  return (
    <div className={`${box} grid place-items-center text-2xl text-zinc-500`}>{item.kind === "Video" ? "▶" : "♪"}</div>
  );
}

/** Screenshots and copied images arrive as "image.png"; give them a findable name. */
function namePasted(file: File) {
  if (!/^image\.\w+$/.test(file.name)) return file;
  const stamp = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }).replace(/[/:]/g, "-");
  return new File([file], `Pasted image ${stamp}.${file.name.split(".").pop()}`, { type: file.type });
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
