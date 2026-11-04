import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { contrastRatio, moveIndex, placePopover, redactSecrets, trapIndex, typeaheadIndex } from "./a11y";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

function token(name: string) {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `missing ${name} in globals.css`);
  return match[1];
}

describe("design tokens", () => {
  const ink = token("--color-ink");
  const panel = token("--color-panel");
  const surface3 = token("--color-surface-3");
  const fg = token("--color-fg");
  const muted = token("--color-fg-muted");
  const subtle = token("--color-fg-subtle");
  const accent = token("--color-accent");
  const accentFg = token("--color-accent-fg");
  const lineStrong = token("--color-line-strong");

  it("keeps reelfling lime and near-black ink", () => {
    assert.equal(accent, "#c6f432");
    assert.equal(ink, "#0b0b0d");
    assert.equal(accentFg, "#0b0b0d");
  });

  it("meets AA for body text and the accent fill", () => {
    assert.ok(contrastRatio(fg, ink) >= 4.5, `fg on ink ${contrastRatio(fg, ink)}`);
    assert.ok(contrastRatio(fg, panel) >= 4.5, `fg on panel ${contrastRatio(fg, panel)}`);
    assert.ok(contrastRatio(muted, panel) >= 4.5, `fg-muted on panel ${contrastRatio(muted, panel)}`);
    assert.ok(contrastRatio(subtle, surface3) >= 4.5, `fg-subtle on surface-3 ${contrastRatio(subtle, surface3)}`);
    assert.ok(contrastRatio(accentFg, accent) >= 4.5, `accent-fg on accent ${contrastRatio(accentFg, accent)}`);
    assert.ok(contrastRatio(lineStrong, panel) >= 3, `line-strong on panel ${contrastRatio(lineStrong, panel)}`);
  });

  it("defines radius, type, and motion scales", () => {
    for (const snippet of [
      "--radius-sm: 6px",
      "--radius-md: 10px",
      "--radius-lg: 14px",
      "--radius-xl: 20px",
      "--text-label: 11px",
      "--text-body: 13px",
      "--text-title: 15px",
      "--text-display: 28px",
      "--duration-fast: 120ms",
      "--duration-base: 200ms",
      "--duration-slow: 320ms",
      "--color-accent-soft: rgb(198 244 50 / 0.12)",
    ]) {
      assert.ok(css.includes(snippet), snippet);
    }
  });
});

describe("popover placement", () => {
  const viewport = { width: 800, height: 600 };
  const popover = { width: 200, height: 180 };

  it("opens below the anchor when there is room", () => {
    const placed = placePopover(
      { top: 40, left: 40, right: 140, bottom: 72, width: 100, height: 32 },
      popover,
      viewport,
    );
    assert.equal(placed.side, "bottom");
    assert.equal(placed.top, 80);
    assert.equal(placed.left, 40);
  });

  it("flips above when the bottom edge would clip", () => {
    const placed = placePopover(
      { top: 520, left: 40, right: 140, bottom: 552, width: 100, height: 32 },
      popover,
      viewport,
      "bottom",
    );
    assert.equal(placed.side, "top");
    assert.equal(placed.top, 520 - 8 - 180);
  });

  it("shifts left so the panel stays inside the viewport", () => {
    const placed = placePopover(
      { top: 40, left: 760, right: 792, bottom: 72, width: 32, height: 32 },
      popover,
      viewport,
      "bottom",
      "start",
    );
    assert.ok(placed.left + popover.width <= viewport.width - 8);
  });
});

describe("keyboard indexes", () => {
  it("wraps arrow movement", () => {
    assert.equal(moveIndex(-1, 1, 3), 0);
    assert.equal(moveIndex(-1, -1, 3), 2);
    assert.equal(moveIndex(2, 1, 3), 0);
    assert.equal(moveIndex(0, -1, 3), 2);
  });

  it("traps tab at both ends", () => {
    assert.equal(trapIndex(2, 3, false), 0);
    assert.equal(trapIndex(0, 3, true), 2);
    assert.equal(trapIndex(-1, 3, false), 0);
    assert.equal(trapIndex(-1, 3, true), 2);
    assert.equal(trapIndex(1, 3, false), 2);
  });

  it("type-ahead matches a prefix and wraps", () => {
    const labels = ["Auto", "16:9", "9:16", "1:1"];
    assert.equal(typeaheadIndex(labels, "1", -1, false), 1);
    assert.equal(typeaheadIndex(labels, "1", 1, false), 3);
    assert.equal(typeaheadIndex(labels, "16", 1, true), 1);
    assert.equal(typeaheadIndex(labels, "z", 0, true), 0);
  });
});

describe("secret redaction", () => {
  it("never leaves a key in a toast message", () => {
    const key = "sk-or-v1-abcDEF1234567890wxyz";
    const out = redactSecrets(`Provider rejected this key: ${key}`);
    assert.equal(out.includes(key), false);
    assert.equal(out.includes("abcDEF"), false);
    assert.match(out, /rejected this key/);
  });

  it("keeps ordinary sentences and shows only last4 of a raw token", () => {
    assert.match(redactSecrets("Image must be under 10 MB"), /10 MB/);
    assert.match(redactSecrets("This model doesn't take videos as references."), /videos as references/);
    const token = "abcdEFGHijkl1234567890MNOP";
    const out = redactSecrets(`Save failed ${token}`);
    assert.equal(out.includes(token), false);
    assert.match(out, /…MNOP/);
  });
});
