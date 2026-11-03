"use client";

// The phrase on a grayed model, tool, or mode. It names providers and opens the keys dialog.

export function UnlockHint({ hint, onOpen }: { hint: string; onOpen: () => void }) {
  if (!hint) return null;
  return (
    <button
      type="button"
      data-testid="unlock-hint"
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onOpen();
      }}
      className="text-left text-xs text-zinc-400 underline decoration-white/20 hover:text-zinc-200"
    >
      {hint}
    </button>
  );
}
