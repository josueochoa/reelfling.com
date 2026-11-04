// A custom palette becomes a JPEG in the user's uploads, through the same
// library path as any other reference. Nothing here calls a provider.

import { PALETTE_SWATCH_NAME, type LookChoice } from "@/lib/registry/looks";
import type { Library, LibraryItem } from "./library";

export async function paletteSwatchFile(colors: readonly string[]): Promise<File> {
  const stripe = 64;
  const canvas = document.createElement("canvas");
  canvas.width = stripe * colors.length;
  canvas.height = stripe;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't draw the palette swatch");
  colors.forEach((color, index) => {
    ctx.fillStyle = color;
    ctx.fillRect(index * stripe, 0, stripe, stripe);
  });
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((drawn) => (drawn ? resolve(drawn) : reject(new Error("Couldn't draw the palette swatch"))), "image/jpeg", 0.92);
  });
  return new File([blob], PALETTE_SWATCH_NAME, { type: "image/jpeg" });
}

/** Uploads a swatch and resolves with its library key once it is stored. */
export async function uploadPaletteSwatch(library: Pick<Library, "add" | "whenReady">, colors: readonly string[]): Promise<LibraryItem> {
  const file = await paletteSwatchFile(colors);
  const { items, errors } = await library.add([file]);
  if (errors.length || !items[0]) throw new Error(errors[0] || "Couldn't store the palette swatch");
  const ready = await library.whenReady(items[0].id);
  if (!ready.key) throw new Error("Couldn't store the palette swatch");
  return ready;
}

export interface SwatchMemory {
  key: string;
  colors: string;
}

/**
 * Reuses a stored swatch when the colors have not changed. Otherwise uploads a
 * new one the same way as any reference image. `keys` is the reference list
 * the request should send, with the swatch included once.
 */
export async function resolvePaletteSwatch(
  library: Pick<Library, "add" | "whenReady">,
  choice: LookChoice,
  current: SwatchMemory | undefined,
  keys: readonly string[],
  hasKey: (key: string) => boolean,
): Promise<{ memory?: SwatchMemory; keys: string[]; added?: LibraryItem }> {
  const colors = (choice.colors ?? []).join(",");
  if (!colors) return { keys: [...keys] };
  const reuse = current?.colors === colors && hasKey(current.key) ? current.key : undefined;
  const added = reuse ? undefined : await uploadPaletteSwatch(library, choice.colors ?? []);
  const key = reuse ?? added?.key;
  if (!key) throw new Error("Couldn't store the palette swatch");
  const next = keys.includes(key) ? [...keys] : [...keys, key];
  return { memory: { key, colors }, keys: next, added };
}

export function swatchItem(items: readonly LibraryItem[], key: string | undefined): LibraryItem | undefined {
  if (!key) return undefined;
  return items.find((item) => item.key === key && item.status === "ready");
}
