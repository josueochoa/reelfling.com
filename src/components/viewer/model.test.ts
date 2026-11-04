import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { contrastRatio } from "../ui/a11y";
import {
  clock,
  detailRoute,
  promptParts,
  scrubberAria,
  seekTo,
  toolbarFlags,
  viewerKeyAction,
} from "./model";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

function token(name: string) {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, name);
  return match[1];
}

describe("viewer keyboard shortcuts", () => {
  it("plays and pauses on Space unless a control has the key", () => {
    assert.deepEqual(viewerKeyAction({ key: " ", target: "other" }), { type: "play" });
    assert.deepEqual(viewerKeyAction({ key: " ", target: "slider" }), { type: "play" });
    assert.deepEqual(viewerKeyAction({ key: " ", target: "control" }), { type: "ignore" });
    assert.deepEqual(viewerKeyAction({ key: " ", target: "field" }), { type: "ignore" });
  });

  it("steps with the arrow keys and seeks with Shift", () => {
    assert.deepEqual(viewerKeyAction({ key: "ArrowRight", target: "other" }), { type: "step", delta: 1 });
    assert.deepEqual(viewerKeyAction({ key: "ArrowLeft", target: "other" }), { type: "step", delta: -1 });
    assert.deepEqual(viewerKeyAction({ key: "ArrowRight", shiftKey: true, target: "other" }), {
      type: "seek",
      seconds: 5,
    });
    assert.deepEqual(viewerKeyAction({ key: "ArrowLeft", shiftKey: true, target: "other" }), {
      type: "seek",
      seconds: -5,
    });
  });

  it("seeks when the scrubber has focus", () => {
    assert.deepEqual(viewerKeyAction({ key: "ArrowRight", target: "slider" }), { type: "seek", seconds: 1 });
    assert.deepEqual(viewerKeyAction({ key: "ArrowLeft", shiftKey: true, target: "slider" }), {
      type: "seek",
      seconds: -5,
    });
    assert.equal(seekTo(2, 10, Number.NEGATIVE_INFINITY), 0);
    assert.equal(seekTo(2, 10, Number.POSITIVE_INFINITY), 10);
    assert.equal(seekTo(2, 10, 5), 7);
    assert.equal(seekTo(2, 10, -5), 0);
  });

  it("toggles fullscreen on F and closes on Escape", () => {
    assert.deepEqual(viewerKeyAction({ key: "f", target: "other" }), { type: "fullscreen" });
    assert.deepEqual(viewerKeyAction({ key: "F", target: "control" }), { type: "fullscreen" });
    assert.deepEqual(viewerKeyAction({ key: "Escape", target: "other" }), { type: "close" });
    assert.deepEqual(viewerKeyAction({ key: "f", target: "field" }), { type: "ignore" });
  });

  it("leaves arrow keys to the tabs", () => {
    assert.deepEqual(viewerKeyAction({ key: "ArrowRight", target: "tab" }), { type: "ignore" });
  });
});

describe("scrubber aria-valuetext", () => {
  it("uses m:ss for the current time", () => {
    assert.equal(clock(0), "0:00");
    assert.equal(clock(65), "1:05");
    assert.equal(clock(9.9), "0:09");
    const aria = scrubberAria(65.4, 90);
    assert.equal(aria.role, "slider");
    assert.equal(aria["aria-valuemin"], 0);
    assert.equal(aria["aria-valuemax"], 90);
    assert.equal(aria["aria-valuenow"], 65);
    assert.equal(aria["aria-valuetext"], "1:05");
    assert.match(aria["aria-valuetext"], /^\d+:\d{2}$/);
  });

  it("clamps the spoken time to the duration", () => {
    assert.equal(scrubberAria(40, 12)["aria-valuetext"], "0:12");
    assert.equal(scrubberAria(Number.NaN, 0)["aria-valuetext"], "0:00");
  });
});

describe("viewer copy", () => {
  it("marks @mentions and leaves the rest", () => {
    const parts = promptParts("Hello @Image 1 and @Video 2.");
    assert.deepEqual(
      parts.filter((part) => part.mention).map((part) => part.text),
      ["@Image 1", "@Video 2"],
    );
  });

  it("reads a route only when the generation has a string one", () => {
    assert.equal(detailRoute(undefined), undefined);
    assert.equal(detailRoute(""), undefined);
    assert.equal(detailRoute("  "), undefined);
    assert.equal(detailRoute(" argolink "), "argolink");
  });

  it("pins upscale and leaves every other tool for More", () => {
    const flags = toolbarFlags(
      [
        { name: "SeedVR", menu: "Upscale", accepts: "video" },
        { name: "Cutout", accepts: "image" },
        { name: "Remove background", accepts: "video" },
      ],
      "video",
    );
    assert.deepEqual(flags, { upscale: true, more: true });
    assert.deepEqual(
      toolbarFlags([{ name: "SeedVR", menu: "Upscale", accepts: "video" }], "video"),
      { upscale: true, more: false },
    );
  });
});

describe("viewer contrast", () => {
  it("meets AA for inspector text on the panel", () => {
    const panel = token("--color-panel");
    assert.ok(contrastRatio(token("--color-fg"), panel) >= 4.5);
    assert.ok(contrastRatio(token("--color-fg-muted"), panel) >= 4.5);
    assert.ok(contrastRatio(token("--color-accent-fg"), token("--color-accent")) >= 4.5);
  });
});
