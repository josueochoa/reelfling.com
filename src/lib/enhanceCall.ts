// The only place Enhance talks to a provider. The key is attached after the host check
// and never written into the URL, the body, or an error string.

import { assertFalApiUrl } from "./providers/fal";
import { isOpenRouterHost } from "./providers/openrouter";
import { ProviderError } from "./providers/types";
import {
  ENHANCE_MODEL,
  EnhanceError,
  enhanceMessages,
  familyGuide,
  restoreShield,
  shieldPrompt,
  type EnhanceMessage,
  type EnhanceProvider,
} from "./enhance";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Sync OpenAI-compatible passthrough. The queue host only returns a ticket. */
const FAL_CHAT_URL = "https://fal.run/openrouter/router/openai/v1/chat/completions";

function scrub(text: string, secret: string) {
  if (!secret || !text.includes(secret)) return text;
  return text.split(secret).join("[redacted]");
}

function failureMessage(body: unknown, status: number, secret: string): string {
  if (body && typeof body === "object") {
    const rec = body as { error?: unknown; message?: unknown };
    const err = rec.error && typeof rec.error === "object" ? (rec.error as { message?: unknown }) : undefined;
    const message =
      typeof err?.message === "string" ? err.message : typeof rec.error === "string" ? rec.error : typeof rec.message === "string" ? rec.message : "";
    if (message) return scrub(message, secret);
  }
  return `Enhance failed (${status})`;
}

function completionText(body: unknown): string {
  const read = (value: unknown): string => {
    if (!value || typeof value !== "object") return "";
    const choices = (value as { choices?: unknown }).choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    if (!first || typeof first !== "object") return "";
    const content = (first as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  };
  if (!body || typeof body !== "object") return "";
  const rec = body as { output?: unknown; data?: unknown };
  return read(body) || read(rec.output) || read(rec.data);
}

function assertTarget(provider: EnhanceProvider, apiKey: string): string {
  const url = provider === "openrouter" ? OPENROUTER_CHAT_URL : FAL_CHAT_URL;
  if (provider === "fal") {
    assertFalApiUrl(url, apiKey);
    return url;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !isOpenRouterHost(parsed.hostname) || parsed.search || parsed.username || parsed.password) {
    throw new ProviderError("Refusing to send the API key to a non-OpenRouter host", 502);
  }
  if (apiKey && url.includes(apiKey)) throw new ProviderError("Refusing a URL that contains the API key", 502);
  return url;
}

/** One chat completion on the user's key. Returns the model's text, with the key scrubbed. */
export async function completeEnhance(provider: EnhanceProvider, apiKey: string, messages: readonly EnhanceMessage[]): Promise<string> {
  const url = assertTarget(provider, apiKey);
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  if (provider === "openrouter") {
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("HTTP-Referer", "https://reelfling.com");
    headers.set("X-Title", "ReelFling");
  } else {
    headers.set("Authorization", `Key ${apiKey}`);
  }
  const payload = JSON.stringify({
    model: ENHANCE_MODEL,
    temperature: 0.4,
    max_tokens: 1200,
    messages,
  });
  if (apiKey && payload.includes(apiKey)) throw new ProviderError("Refusing to send the API key in the request body", 502);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ProviderError(scrub((e as Error).message || "The enhance request failed", apiKey), 502);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new ProviderError(provider === "fal" ? "fal redirected; refusing to follow" : "OpenRouter redirected; refusing to follow", 502);
  }
  const text = await res.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError(`${provider === "fal" ? "fal" : "OpenRouter"} returned non-JSON (${res.status})`, res.ok ? 502 : res.status || 502);
    }
  }
  if (!res.ok) {
    const status = res.status === 401 || res.status === 403 ? 400 : res.status >= 400 && res.status < 500 ? res.status : 502;
    throw new ProviderError(failureMessage(parsed, res.status, apiKey), status);
  }
  const content = completionText(parsed).trim();
  if (!content) throw new ProviderError("The model returned an empty rewrite", 502);
  return scrub(content, apiKey);
}

export interface RewriteInput {
  provider: EnhanceProvider;
  apiKey: string;
  prompt: string;
  family: string;
  cameras: readonly string[];
  looks: readonly string[];
  references: readonly string[];
}

/** Shields mentions and chips, calls the model, and restores them. */
export async function rewritePrompt(input: RewriteInput): Promise<string> {
  const shield = shieldPrompt(input.prompt);
  const messages = enhanceMessages({
    prompt: shield.text,
    family: input.family,
    guide: familyGuide(input.family),
    cameras: input.cameras,
    looks: input.looks,
    references: input.references,
    marker: shield.marker,
  });
  const text = await completeEnhance(input.provider, input.apiKey, messages);
  try {
    return restoreShield(text, shield);
  } catch (e) {
    if (e instanceof EnhanceError) throw e;
    throw new EnhanceError("The rewrite changed a reference or chip. Try again.");
  }
}
