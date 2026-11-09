// Keys whose format names their provider, so one pasted into the wrong box is caught
// before another provider rejects it with a confusing message.

import { PROVIDER_INFO, type ProviderId } from "./registry";

const FORMATS: [ProviderId, RegExp][] = [
  ["openrouter", /^sk-or-/i],
  // fal: "<key id>:<secret>".
  ["fal", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}$/i],
];

/** Why this key doesn't belong in `provider`'s box, or null. */
export function wrongBoxError(provider: ProviderId, apiKey: string): string | null {
  const owner = FORMATS.find(([, format]) => format.test(apiKey.trim()))?.[0];
  if (!owner || owner === provider) return null;
  const label = PROVIDER_INFO[owner].label;
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  return `This looks like ${article} ${label} key. Paste it in the ${label} box instead of ${PROVIDER_INFO[provider].label}.`;
}
