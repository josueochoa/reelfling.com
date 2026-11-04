import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { falQueueInput } from "./providers/fal";
import { isOpenRouterHost } from "./providers/openrouter";
import { isVideo } from "./registry";
import { availabilityError, availabilityHint } from "./registry/availability";
import { ALL_MODELS } from "./registry/generated";
import { rewritePrompt } from "./enhanceCall";
import {
  ENHANCE_MODEL,
  applyNativeExpansion,
  enhanceAvailability,
  enhanceMessages,
  enhanceProvider,
  expansionChoice,
  familyGuide,
  nativeExpansionOf,
  restoreShield,
  shieldPrompt,
  wordDiff,
} from "./enhance";

const KEY = "sk-or-v1-test-key-do-not-leak-9f3a";
const FAL_KEY = "fal-placeholder-key-do-not-leak-9f3a";

interface Call {
  url: string;
  authorization: string | null;
  body: string | undefined;
}

const calls: Call[] = [];
const originalFetch = globalThis.fetch;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function install(handler: (call: Call) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

function video(endpoint: string) {
  const model = ALL_MODELS.find((item) => isVideo(item) && item.routes.some((route) => route.endpoint === endpoint));
  assert.ok(model && isVideo(model), endpoint);
  return model;
}

describe("mentions and chips", () => {
  it("keeps @mentions and #chips verbatim through a rewrite", () => {
    const original = "El gato de @Image 1 corre #push-in junto a @Video 2 y @Imagen 3";
    const shield = shieldPrompt(original);
    assert.equal(shield.text.includes("@Image"), false);
    assert.equal(shield.text.includes("@Video"), false);
    assert.equal(shield.text.includes("@Imagen"), false);
    assert.equal(shield.text.includes("#push-in"), false);
    assert.deepEqual(shield.tokens, ["@Image 1", "#push-in", "@Video 2", "@Imagen 3"]);
    const rewritten = shield.text.replace("corre", "salta con fuerza").replace("junto a", "al lado de");
    assert.equal(
      restoreShield(rewritten, shield),
      "El gato de @Image 1 salta con fuerza #push-in al lado de @Video 2 y @Imagen 3",
    );
  });

  it("rejects a rewrite that drops or rewrites a protected token", () => {
    const shield = shieldPrompt("corre #push-in con @Image 1");
    assert.throws(() => restoreShield("solo texto", shield));
    const dropped = shield.text.replace(`[[${shield.marker}0]]`, "acercamiento");
    assert.throws(() => restoreShield(dropped, shield));
    const doubled = `${shield.text} ${shield.text}`;
    assert.throws(() => restoreShield(doubled, shield));
  });

  it("protects a #chip that is not a known camera id", () => {
    const shield = shieldPrompt("night market #warm-dusk");
    assert.deepEqual(shield.tokens, ["#warm-dusk"]);
    assert.equal(restoreShield(shield.text.replace("night", "noche"), shield), "noche market #warm-dusk");
  });
});

describe("language instruction", () => {
  it("tells the model to keep Spanish unless the user asks for English", () => {
    const prompt = "Un barco de papel bajo la lluvia";
    const messages = enhanceMessages({
      prompt,
      family: "Wan",
      guide: familyGuide("Wan"),
      cameras: ["Push in: Move closer to the subject."],
      looks: ["Warm dusk"],
      references: ["@Image 1 (barco)"],
      marker: "RF",
    });
    const system = messages[0].content;
    assert.match(system, /Keep the prompt's language\. A Spanish prompt stays Spanish unless the user asks for English\./);
    assert.match(system, /Wan/);
    assert.match(system, /subject, the action, the place, and the light/);
    assert.match(system, /Push in: Move closer to the subject\./);
    assert.match(system, /Warm dusk/);
    assert.match(system, /@Image 1 \(barco\)/);
    assert.equal(messages[1].content, prompt);
  });
});

describe("native expansion", () => {
  it("sends the Wan and MiniMax flags and does not call the LLM", () => {
    let hits = 0;
    globalThis.fetch = (() => {
      hits++;
      return Promise.resolve(new Response(""));
    }) as typeof fetch;

    const wan = video("alibaba/wan-3.0/text-to-video");
    const wanImage = video("alibaba/wan-3.0/image-to-video");
    const mini = video("minimax/h3/text-to-video");
    const miniRef = video("minimax/h3/reference-to-video");
    const extend = video("minimax/h3-max/extend-video");
    const openrouterWan = ALL_MODELS.find((model) => model.id === "openrouter:alibaba/wan-3.0");
    assert.ok(openrouterWan && isVideo(openrouterWan));

    assert.equal(expansionChoice(true, wan).callLlm, false);
    assert.equal(expansionChoice(true, wan).flag?.field, "enable_prompt_expansion");
    assert.equal(expansionChoice(true, wan).flag?.value, true);
    assert.equal(expansionChoice(false, wan).callLlm, true);
    assert.equal(expansionChoice(false, wan).flag, null);

    const wanBody = applyNativeExpansion(falQueueInput({ prompt: "hola @Image 1" }, wan.inputs), wan, true);
    assert.equal(wanBody.enable_prompt_expansion, true);
    assert.equal(wanBody.prompt, "hola @Image 1");
    const wanImageBody = applyNativeExpansion(falQueueInput({ prompt: "hola" }, wanImage.inputs), wanImage, true);
    assert.equal(wanImageBody.enable_prompt_expansion, true);
    const miniBody = applyNativeExpansion(falQueueInput({ prompt: "hola" }, mini.inputs), mini, true);
    assert.equal(miniBody.prompt_expansion_mode, "balanced");
    const refBody = applyNativeExpansion(falQueueInput({ prompt: "hola" }, miniRef.inputs), miniRef, true);
    assert.equal(refBody.prompt_expansion_mode, "balanced");

    const off = applyNativeExpansion(falQueueInput({ prompt: "hola" }, wan.inputs), wan, false);
    assert.equal("enable_prompt_expansion" in off, false);
    assert.equal(nativeExpansionOf(extend), null);
    assert.equal(nativeExpansionOf(openrouterWan), null);
    assert.equal(hits, 0);
  });
});

describe("enhance availability", () => {
  it("is unavailable without an OpenRouter or fal key, and open with either", () => {
    const none = enhanceAvailability(new Set());
    assert.equal(none.available, false);
    assert.deepEqual(none.needs, ["fal", "openrouter"]);
    assert.equal(availabilityHint(none.needs), "needs a fal or OpenRouter key");
    assert.equal(availabilityError(none.needs), "This needs a fal or OpenRouter key.");
    assert.equal(enhanceAvailability(new Set(["modelark", "argolink"])).available, false);
    assert.equal(enhanceAvailability(new Set(["openrouter"])).available, true);
    assert.equal(enhanceAvailability(new Set(["fal"])).available, true);
    assert.equal(enhanceProvider(new Set(["openrouter", "fal"])), "openrouter");
    assert.equal(enhanceProvider(new Set(["fal"])), "fal");
    assert.equal(enhanceProvider(new Set(["modelark"])), null);
  });
});

describe("enhance call", () => {
  const prompt = "El gato de @Image 1 corre #push-in";

  it("calls OpenRouter chat completions, then restores mentions and chips", async () => {
    install((call) => {
      const body = JSON.parse(call.body ?? "{}") as {
        model: string;
        messages: { role: string; content: string }[];
      };
      assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(new URL(call.url).search, "");
      assert.equal(isOpenRouterHost(new URL(call.url).hostname), true);
      assert.equal(call.authorization, `Bearer ${KEY}`);
      assert.equal(body.model, ENHANCE_MODEL);
      assert.equal(call.body?.includes(KEY), false);
      assert.match(body.messages[0].content, /Spanish prompt stays Spanish unless the user asks for English/);
      assert.equal(body.messages[1].content.includes("@Image 1"), false);
      assert.equal(body.messages[1].content.includes("#push-in"), false);
      const rewritten = body.messages[1].content.replace("corre", "salta");
      return json(200, { choices: [{ message: { content: rewritten } }] });
    });
    const result = await rewritePrompt({
      provider: "openrouter",
      apiKey: KEY,
      prompt,
      family: "Wan",
      cameras: ["Push in: Move closer to the subject."],
      looks: [],
      references: ["@Image 1 (gato)"],
    });
    assert.equal(result, "El gato de @Image 1 salta #push-in");
    assert.equal(result.includes(KEY), false);
  });

  it("calls the fal OpenRouter router with the same model", async () => {
    install((call) => {
      const body = JSON.parse(call.body ?? "{}") as { model: string; messages: { content: string }[] };
      assert.equal(call.url, "https://fal.run/openrouter/router/openai/v1/chat/completions");
      assert.equal(call.authorization, `Key ${FAL_KEY}`);
      assert.equal(body.model, ENHANCE_MODEL);
      assert.equal(call.body?.includes(FAL_KEY), false);
      assert.equal(call.url.includes(FAL_KEY), false);
      return json(200, { choices: [{ message: { content: body.messages[1].content.replace("corre", "brinca") } }] });
    });
    const result = await rewritePrompt({
      provider: "fal",
      apiKey: FAL_KEY,
      prompt,
      family: "MiniMax",
      cameras: [],
      looks: ["Warm dusk"],
      references: ["@Image 1 (gato)"],
    });
    assert.equal(result, "El gato de @Image 1 brinca #push-in");
    const sent = JSON.parse(calls[0].body ?? "{}") as { messages: { content: string }[] };
    assert.match(sent.messages[0].content, /Warm dusk/);
  });

  it("scrubs the key out of a provider error", async () => {
    install(() => json(401, { error: { message: `invalid key ${KEY}` } }));
    await assert.rejects(
      () =>
        rewritePrompt({
          provider: "openrouter",
          apiKey: KEY,
          prompt: "hola",
          family: "Wan",
          cameras: [],
          looks: [],
          references: [],
        }),
      (error: Error) => {
        assert.equal(error.message.includes(KEY), false);
        assert.match(error.message, /\[redacted\]/);
        return true;
      },
    );
  });
});

describe("word diff", () => {
  it("marks changed words and keeps the rest", () => {
    assert.deepEqual(
      wordDiff("a paper boat", "a red boat").map((part) => `${part.kind}:${part.text}`),
      ["same:a ", "del:paper ", "add:red ", "same:boat"],
    );
  });
});
