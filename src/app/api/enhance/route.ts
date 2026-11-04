import { errorResponse, requireUser } from "@/lib/auth";
import { rewritePrompt } from "@/lib/enhanceCall";
import { enhanceAvailability, enhanceProvider } from "@/lib/enhance";
import { getCredentials, listKeys } from "@/lib/keys";
import { availabilityError } from "@/lib/registry/availability";
import { cameraPreset } from "@/lib/registry/camera";

const MAX_PROMPT = 8000;

function stringList(value: unknown, max: number, length: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.replace(/[\r\n]+/g, " ").trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, length));
    if (out.length >= max) break;
  }
  return out;
}

/** Rewrites a prompt on the user's OpenRouter or fal key. The key stays on the server. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      prompt?: unknown;
      family?: unknown;
      cameras?: unknown;
      looks?: unknown;
      references?: unknown;
    };
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) return Response.json({ error: "Write a prompt first." }, { status: 400 });
    if (prompt.length > MAX_PROMPT) return Response.json({ error: "That prompt is too long to enhance." }, { status: 400 });

    const keyed = new Set((await listKeys(user.id)).map((key) => key.provider));
    const gate = enhanceAvailability(keyed);
    if (!gate.available) return Response.json({ error: availabilityError(gate.needs) }, { status: 400 });
    const provider = enhanceProvider(keyed);
    const creds = provider ? await getCredentials(user.id, provider) : undefined;
    if (!provider || !creds) return Response.json({ error: availabilityError(gate.needs) }, { status: 400 });

    const family = typeof body.family === "string" ? body.family.slice(0, 80) : "";
    const cameras = stringList(body.cameras, 3, 40).flatMap((id) => {
      const preset = cameraPreset(id);
      return preset ? [`${preset.name}: ${preset.description}`] : [];
    });
    const next = await rewritePrompt({
      provider,
      apiKey: creds.apiKey,
      prompt,
      family,
      cameras,
      looks: stringList(body.looks, 8, 40),
      references: stringList(body.references, 30, 120),
    });
    return Response.json({ prompt: next });
  } catch (e) {
    return errorResponse(e);
  }
}
