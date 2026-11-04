// Named looks, stored as JSON on the user row. The generation record stores
// the chips for Reuse; this list is what a click applies later.

import { first, run } from "./db";
import { keptLook, lookIsEmpty, SAVED_LOOK_MAX, type LookChoice, type SavedLook } from "./registry/looks";

function parseStored(raw: string | null | undefined): SavedLook[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const looks: SavedLook[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as { id?: unknown; name?: unknown; choice?: unknown };
      if (typeof rec.id !== "string" || typeof rec.name !== "string") continue;
      const choice = keptLook(rec.choice);
      if (lookIsEmpty(choice)) continue;
      const name = rec.name.trim().slice(0, 40);
      if (!name) continue;
      looks.push({ id: rec.id, name, choice });
      if (looks.length >= SAVED_LOOK_MAX) break;
    }
    return looks;
  } catch {
    return [];
  }
}

export async function listLooks(userId: string): Promise<SavedLook[]> {
  const row = await first<{ looks: string | null }>("SELECT looks FROM users WHERE id = ?", userId);
  return parseStored(row?.looks);
}

async function writeLooks(userId: string, looks: readonly SavedLook[]) {
  await run("UPDATE users SET looks = ? WHERE id = ?", JSON.stringify(looks), userId);
}

/** Adds one look. Returns the list, or an error string. */
export async function addLook(userId: string, name: string, choice: LookChoice): Promise<SavedLook[] | string> {
  const clean = name.trim().slice(0, 40);
  if (!clean) return "Name the look";
  const kept = keptLook(choice);
  if (lookIsEmpty(kept)) return "Pick a look before saving";
  const current = await listLooks(userId);
  if (current.length >= SAVED_LOOK_MAX) return `Up to ${SAVED_LOOK_MAX} saved looks`;
  const next = [...current, { id: crypto.randomUUID(), name: clean, choice: kept }];
  await writeLooks(userId, next);
  return next;
}

export async function deleteLook(userId: string, id: string): Promise<SavedLook[]> {
  const next = (await listLooks(userId)).filter((look) => look.id !== id);
  await writeLooks(userId, next);
  return next;
}
