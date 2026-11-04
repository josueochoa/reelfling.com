import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GenerateRequest } from "../types";
import { applyCameraMoves } from "./camera";
import { ALL_MODELS } from "./generated";
import { getModel, isImage, isVideo, type ImageModel, type VideoModel } from "./index";
import {
  applyLook,
  applySavedLook,
  compileLook,
  keptLook,
  lookGroups,
  paletteUsesSwatch,
  type LookChoice,
} from "./looks";

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
    assert.equal(compiled.seedance, "Rain. Look: tight framing, held close to the subject.");
    assert.equal(compiled.kling, "Rain. Visual: tight framing, held close to the subject.");
    assert.equal(compiled.google, "Rain. Style: tight framing, held close to the subject.");
    assert.equal(compiled.nano, "Rain. Direction: tight framing, held close to the subject.");
    assert.equal(compiled.gpt, "Rain. Style direction: tight framing, held close to the subject.");
    assert.equal(new Set(Object.values(compiled)).size, 5);

    const full = compileLook(seedance, "Rain", desk);
    assert.match(full.prompt, /Look: tight framing, held close to the subject/);
    assert.match(full.prompt, /a compressed perspective/);
    assert.match(full.prompt, /shallow depth of field/);
    assert.match(full.prompt, /lit from a side window/);
    assert.match(full.prompt, /black ink with a single lime accent/);
    assert.match(full.prompt, /set in the home-tape decade/);
    const framing = full.prompt.indexOf("tight framing");
    const era = full.prompt.indexOf("home-tape");
    assert.ok(framing !== -1 && framing < era);
  });

  it("describes framing, perspective, and focus instead of naming hardware", () => {
    const models = [
      video("seedance-2.5"),
      video("openrouter:kwaivgi/kling-v3.0-pro"),
      video("openrouter:google/veo-3.1-fast"),
      image("nano-banana-2.1"),
      image("gpt-image-2.5-sunburst"),
    ];
    const hardware = /\b(cameras?|lenses|lens|apertures?|glass|rigs?|viewfinders?|tripods?)\b/i;
    const imperative = /^(Make it|Show |In frame,)/;
    const shot = /framing|perspective|depth of field|focus|view|edges|falloff|move|steady/;
    for (const group of lookGroups) {
      if (group.id !== "camera" && group.id !== "lens" && group.id !== "aperture") continue;
      for (const option of group.options) {
        if (option.id === "auto") continue;
        for (const model of models) {
          const line = compileLook(model, "Rain.", { [group.id]: option.id }).prompt.slice("Rain. ".length);
          assert.equal(hardware.test(line), false, `${model.family} ${option.id}: ${line}`);
          assert.equal(imperative.test(line), false, line);
          assert.match(line, shot, line);
        }
      }
    }
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
    assert.match(looked.prompt, /Look: soft edges and a gentle falloff/);
    const sent = applyCameraMoves(model, looked);
    assert.match(sent.prompt, /soft edges and a gentle falloff/);
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
    assert.match(nanoSwatch.prompt, /Direction: match the attached color swatch/);
    assert.equal(nanoSwatch.prompt.includes("#c6f432"), false);

    const written = compileLook(text, "Rain.", choice);
    assert.equal(written.swatch, false);
    assert.match(written.prompt, /Look: palette colors #112233, #c6f432, #abcdef, #010203, #ff00aa/);
    assert.equal(written.prompt.includes("#ffffff"), false);

    const kling = compileLook(video("openrouter:kwaivgi/kling-v3.0-pro"), "Rain.", { palette: "custom", colors: ["#112233"] });
    assert.match(kling.prompt, /Visual: palette colors #112233/);
    assert.notEqual(kling.prompt, written.prompt);
  });

  it("keeps start, middle, and end frames and writes the palette as text", () => {
    const model = video("dreamina-seedance-2-0-260128");
    assert.equal(model.capabilities.frames.start, true);
    assert.equal(model.capabilities.frames.middle, false);
    assert.equal(model.capabilities.frames.end, true);
    assert.ok(model.capabilities.references.image > 0);
    const choice: LookChoice = { palette: "custom", colors: five };
    assert.equal(paletteUsesSwatch(model, choice, "frames"), false);
    assert.equal(paletteUsesSwatch(model, choice, "references"), true);

    const req: GenerateRequest & { look?: LookChoice } = {
      model: model.id,
      prompt: "Rain.",
      mode: "frames",
      ratio: "16:9",
      resolution: "720p",
      duration: 5,
      look: choice,
      firstFrame: "upload:uploads/start.jpg",
      middleFrames: ["upload:uploads/mid.jpg"],
      lastFrame: "upload:uploads/end.jpg",
      continueFrom: "gen-1",
    };
    const sent = applyLook(model, req);
    assert.equal(sent.mode, "frames");
    assert.equal(sent.firstFrame, req.firstFrame);
    assert.deepEqual(sent.middleFrames, req.middleFrames);
    assert.equal(sent.lastFrame, req.lastFrame);
    assert.equal(sent.continueFrom, req.continueFrom);
    assert.equal("look" in sent, false);
    assert.match(sent.prompt, /palette colors #112233, #c6f432, #abcdef, #010203, #ff00aa/);
    assert.equal(sent.prompt.includes("color swatch"), false);

    const asRefs = compileLook(model, "Rain.", choice, "references");
    assert.equal(asRefs.swatch, true);
    assert.equal(asRefs.prompt.includes("#112233"), false);
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
    assert.equal(stored.prompt.includes("tight framing"), false);
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
