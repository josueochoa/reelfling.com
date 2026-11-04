import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GenerateRequest } from "../types";
import { applyCameraMoves } from "./camera";
import { ALL_MODELS } from "./generated";
import { getModel, isImage, isVideo, type ImageModel, type VideoModel } from "./index";
import { applyLook, applySavedLook, compileLook, keptLook, paletteUsesSwatch, type LookChoice } from "./looks";

function video(id: string): VideoModel {
  const model = getModel(id) ?? ALL_MODELS.find((entry) => entry.id === id);
  assert.ok(model && isVideo(model), id);
  return model;
}

function image(id: string): ImageModel {
  const model = getModel(id) ?? ALL_MODELS.find((entry) => entry.id === id);
  assert.ok(model && isImage(model), id);
  return model;
}

const desk: LookChoice = {
  camera: "pocket",
  lens: "reach-glass",
  aperture: "wide-open",
  lighting: "window-side",
  palette: "ink-lime",
  era: "tape-decade",
};

const five = ["#112233", "#c6f432", "#abcdef", "#010203", "#ff00aa"];

describe("look prompt compilation", () => {
  it("adds nothing for Auto and uses a different line per family", () => {
    const seedance = video("seedance-2.5");
    assert.equal(compileLook(seedance, "Rain.", {}).prompt, "Rain.");
    assert.equal(compileLook(seedance, "Rain.", { camera: "auto", lens: "auto" }).prompt, "Rain.");
    assert.equal(compileLook(seedance, "Rain.", { camera: "not-a-chip" }).prompt, "Rain.");

    const choice = { camera: "pocket" };
    const compiled = {
      seedance: compileLook(seedance, "Rain.", choice).prompt,
      kling: compileLook(video("openrouter:kwaivgi/kling-v3.0-pro"), "Rain.", choice).prompt,
      google: compileLook(video("openrouter:google/veo-3.1-fast"), "Rain.", choice).prompt,
      nano: compileLook(image("nano-banana-2.1"), "Rain.", choice).prompt,
      gpt: compileLook(image("gpt-image-2.5-sunburst"), "Rain.", choice).prompt,
    };
    assert.equal(compiled.seedance, "Rain. Look: a small pocket camera.");
    assert.equal(compiled.kling, "Rain. Visual: a small pocket camera.");
    assert.equal(compiled.google, "Rain. In frame, a small pocket camera.");
    assert.equal(compiled.nano, "Rain. Make it a small pocket camera.");
    assert.equal(compiled.gpt, "Rain. Style direction: a small pocket camera.");
    assert.equal(new Set(Object.values(compiled)).size, 5);

    const full = compileLook(seedance, "Rain", desk);
    assert.match(full.prompt, /Look: a small pocket camera/);
    assert.match(full.prompt, /a long reach lens/);
    assert.match(full.prompt, /the aperture wide open/);
    assert.match(full.prompt, /light from a side window/);
    assert.match(full.prompt, /black ink with a single lime accent/);
    assert.match(full.prompt, /the home-tape decade/);
    const pocket = full.prompt.indexOf("pocket camera");
    const era = full.prompt.indexOf("home-tape");
    assert.ok(pocket !== -1 && pocket < era);
  });

  it("keeps the user's prompt and sends the compiled copy to the provider", () => {
    const model = video("seedance-2.5");
    const req: GenerateRequest & { look?: LookChoice } = {
      model: model.id,
      prompt: "a paper boat",
      mode: "frames",
      ratio: "16:9",
      resolution: "720p",
      duration: 5,
      look: { lens: "soft-glass" },
      cameraMoves: ["push-in"],
    };
    const looked = applyLook(model, req);
    assert.equal("look" in looked, false);
    assert.match(looked.prompt, /Look: a soft diffused lens/);
    const sent = applyCameraMoves(model, looked);
    assert.match(sent.prompt, /soft diffused lens/);
    assert.match(sent.prompt, /pushes in/);
    assert.equal(req.prompt, "a paper boat");
  });
});

describe("custom palette", () => {
  const choice: LookChoice = { palette: "custom", colors: [...five, "#ffffff"] };

  it("attaches a swatch on models with image references and writes colors otherwise", () => {
    const refs = video("seedance-2.5");
    const text = video("seedance-1-0-pro-250528");
    const nano = image("nano-banana-2.1");
    assert.equal(refs.capabilities.references.image > 0, true);
    assert.equal(text.capabilities.references.image, 0);
    assert.equal(nano.capabilities.references.image > 0, true);

    const swatch = compileLook(refs, "Rain.", choice);
    assert.equal(swatch.swatch, true);
    assert.equal(paletteUsesSwatch(refs, choice), true);
    assert.match(swatch.prompt, /attached color swatch/);
    for (const color of five) assert.equal(swatch.prompt.includes(color), false);
    assert.equal(swatch.prompt.includes("#ffffff"), false);

    const nanoSwatch = compileLook(nano, "Rain.", choice);
    assert.equal(nanoSwatch.swatch, true);
    assert.match(nanoSwatch.prompt, /Make it match the attached color swatch/);
    assert.equal(nanoSwatch.prompt.includes("#c6f432"), false);

    const written = compileLook(text, "Rain.", choice);
    assert.equal(written.swatch, false);
    assert.match(written.prompt, /Look: palette colors #112233, #c6f432, #abcdef, #010203, #ff00aa/);
    assert.equal(written.prompt.includes("#ffffff"), false);

    const kling = compileLook(video("openrouter:kwaivgi/kling-v3.0-pro"), "Rain.", { palette: "custom", colors: ["#112233"] });
    assert.match(kling.prompt, /Visual: palette colors #112233/);
    assert.notEqual(kling.prompt, written.prompt);
  });

  it("drops a custom palette that has no colors", () => {
    const model = video("seedance-2.5");
    assert.equal(compileLook(model, "Rain.", { palette: "custom" }).prompt, "Rain.");
    assert.equal(compileLook(model, "Rain.", { palette: "custom", colors: ["red"] }).prompt, "Rain.");
  });
});

describe("saved look Reuse", () => {
  it("applies every chip in one click and restores them after Reuse", () => {
    const saved = {
      id: "look-1",
      name: "Desk",
      choice: { ...desk, palette: "custom" as const, colors: [...five, "nope"] },
    };
    const applied = applySavedLook(saved);
    assert.deepEqual(applied, { ...desk, palette: "custom", colors: five });

    const model = video("seedance-2.5");
    const first = compileLook(model, "a paper boat", applied);
    const stored = {
      prompt: "a paper boat",
      look: applied,
      lookSwatch: "uploads/palette-swatch.jpg",
      references: ["uploads/palette-swatch.jpg"],
    };
    assert.equal(stored.prompt.includes("pocket"), false);
    assert.equal(stored.references.includes(stored.lookSwatch), true);

    const restored = keptLook(stored.look);
    assert.deepEqual(restored, applied);
    const again = compileLook(model, stored.prompt, restored);
    assert.equal(again.prompt, first.prompt);
    assert.equal(again.swatch, true);
    assert.equal(again.prompt.includes("#112233"), false);

    const textOnly = video("seedance-1-0-pro-250528");
    const asText = compileLook(textOnly, stored.prompt, restored);
    assert.equal(asText.swatch, false);
    assert.match(asText.prompt, /#112233/);
    assert.match(asText.prompt, /#ff00aa/);
  });
});
