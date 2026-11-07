import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLipsyncBody } from "./lipsync";
import { FAL_VIDEO_ENDPOINTS } from "./registry/generated";
import {
  formatSeconds,
  klingBilledSeconds,
  lipsyncEstimate,
  lipsyncLimitError,
  lipsyncUsd,
  mismatchNotice,
  perSecond,
  syncOutputSeconds,
} from "./lipsyncQuote";

const VIDEO = "uploads/clip.mp4";
const AUDIO = "uploads/voice.wav";
const SYNC = "fal:fal-ai/sync-lipsync/v3";
const KLING = "fal:fal-ai/kling-video/lipsync/audio-to-video";
const VEED = "fal:veed/lipsync/v2";
const LATENT = "fal:fal-ai/latentsync";

describe("lip sync body mapping", () => {
  it("maps each endpoint onto its published fields", () => {
    assert.deepEqual(buildLipsyncBody(SYNC, VIDEO, AUDIO, { sync_mode: "bounce" }), {
      sync_mode: "bounce",
      video_url: `upload:${VIDEO}`,
      audio_url: `upload:${AUDIO}`,
    });
    assert.deepEqual(buildLipsyncBody(SYNC, VIDEO, AUDIO, {}), {
      sync_mode: "cut_off",
      video_url: `upload:${VIDEO}`,
      audio_url: `upload:${AUDIO}`,
    });
    assert.deepEqual(buildLipsyncBody(KLING, VIDEO, AUDIO, {}), {
      video_url: `upload:${VIDEO}`,
      audio_url: `upload:${AUDIO}`,
    });
    assert.deepEqual(buildLipsyncBody(VEED, VIDEO, AUDIO, {}), {
      video_url: `upload:${VIDEO}`,
      audio_url: `upload:${AUDIO}`,
    });
    assert.deepEqual(buildLipsyncBody(LATENT, VIDEO, AUDIO, { loop_mode: "pingpong", guidance_scale: 1.4 }), {
      loop_mode: "pingpong",
      guidance_scale: 1.4,
      video_url: `upload:${VIDEO}`,
      audio_url: `upload:${AUDIO}`,
    });
    assert.deepEqual(buildLipsyncBody(LATENT, VIDEO, AUDIO, {}, { video: 10, audio: 2 }), {
      guidance_scale: 1,
      video_url: `upload:${VIDEO}`,
      audio_url: `upload:${AUDIO}`,
    });
    assert.equal(buildLipsyncBody(LATENT, VIDEO, AUDIO, {}, { video: 4, audio: 8 }).loop_mode, "loop");
  });

  it("rejects fields the schema does not list", () => {
    assert.throws(() => buildLipsyncBody(SYNC, VIDEO, AUDIO, { options: { sync_mode: "loop" } }), /Unknown tool setting/);
    assert.throws(() => buildLipsyncBody(SYNC, VIDEO, AUDIO, { enable_safety_checker: false }), /Unknown tool setting/);
    assert.throws(() => buildLipsyncBody(KLING, VIDEO, AUDIO, { sync_mode: "loop" }), /Unknown tool setting/);
    assert.throws(() => buildLipsyncBody(VEED, VIDEO, AUDIO, { prompt: "hello" }), /Unknown tool setting/);
    assert.throws(() => buildLipsyncBody(LATENT, VIDEO, AUDIO, { guidance_scale: 0.5 }), /below 1/);
    assert.throws(() => buildLipsyncBody(LATENT, VIDEO, AUDIO, { guidance_scale: 3 }), /above 2/);
    assert.throws(() => buildLipsyncBody(LATENT, VIDEO, AUDIO, { loop_mode: "cut_off" }), /isn't one of the listed choices/);
    assert.throws(() => buildLipsyncBody(SYNC, VIDEO, AUDIO, { sync_mode: "stretch" }), /isn't one of the listed choices/);
  });

  it("stays off the studio video allowlist", () => {
    for (const endpoint of [
      "fal-ai/sync-lipsync/v3",
      "fal-ai/kling-video/lipsync/audio-to-video",
      "veed/lipsync/v2",
      "fal-ai/latentsync",
    ]) {
      assert.equal(FAL_VIDEO_ENDPOINTS.has(endpoint), false, endpoint);
    }
  });
});

describe("lip sync duration mismatch", () => {
  it("describes sync-3's mode for each direction", () => {
    const audioLonger = mismatchNotice(SYNC, { video: 4, audio: 8.64, option: "cut_off" });
    assert.match(audioLonger ?? "", /Audio is longer/);
    assert.match(audioLonger ?? "", /Cut off clips the extra audio/);
    assert.match(mismatchNotice(SYNC, { video: 10, audio: 1.74, option: "loop" }) ?? "", /Loop trims the video/);
    assert.match(mismatchNotice(SYNC, { video: 4, audio: 8, option: "bounce" }) ?? "", /forward, then backward/);
    assert.match(mismatchNotice(SYNC, { video: 10, audio: 2, option: "silence" }) ?? "", /pads the rest of the video/);
    assert.match(mismatchNotice(SYNC, { video: 4, audio: 8, option: "remap" }) ?? "", /slows the video/);
    assert.equal(mismatchNotice(SYNC, { video: 4, audio: 4, option: "loop" }), undefined);
    assert.match(mismatchNotice(SYNC, { video: 4 }) ?? "", /can't be checked/);
    assert.equal(mismatchNotice(SYNC, {}), undefined);
  });

  it("describes Kling and VEED, which publish no trim or loop field", () => {
    assert.match(mismatchNotice(KLING, { video: 4, audio: 8 }) ?? "", /no trim or loop setting/);
    assert.match(mismatchNotice(KLING, { video: 8, audio: 4 }) ?? "", /no trim or loop setting/);
    assert.match(mismatchNotice(VEED, { video: 3, audio: 9 }) ?? "", /no trim or loop setting/);
    assert.equal(mismatchNotice(VEED, { video: 5, audio: 5.02 }), undefined);
  });

  it("describes LatentSync loop mode only when audio is longer", () => {
    assert.match(mismatchNotice(LATENT, { video: 4, audio: 9, option: "pingpong" }) ?? "", /Ping-pong/);
    assert.match(mismatchNotice(LATENT, { video: 9, audio: 4, option: "loop" }) ?? "", /no trim/);
    assert.match(mismatchNotice(LATENT, { video: 4, audio: undefined }) ?? "", /can't be checked/);
  });

  it("enforces Kling's published duration and size limits", () => {
    const pair = (video: number, audio: number, bytes = 1000, type = "video/mp4") =>
      lipsyncLimitError(KLING, { duration: video, contentType: type }, { duration: audio, bytes, contentType: "audio/wav" }, "Kling LipSync");
    assert.equal(pair(4, 8), undefined);
    assert.match(pair(12, 8) ?? "", /12s/);
    assert.match(pair(12, 8) ?? "", /2–10s/);
    assert.match(pair(1, 8) ?? "", /2–10s/);
    assert.match(pair(4, 1) ?? "", /2–60s/);
    assert.match(pair(4, 8, 6_000_000) ?? "", /5 MB/);
    assert.match(pair(4, 8, 1000, "video/webm") ?? "", /MP4 or MOV/);
    assert.match(
      lipsyncLimitError(KLING, { contentType: "video/mp4" }, { duration: 8, contentType: "audio/wav" }, "Kling LipSync") ?? "",
      /no duration/,
    );
    assert.equal(
      lipsyncLimitError(SYNC, { duration: 30, contentType: "video/mp4" }, { duration: 2, contentType: "audio/wav" }, "sync-3"),
      undefined,
    );
    assert.equal(formatSeconds(8.64), "8.6s");
  });
});

describe("lip sync cost", () => {
  it("prices sync-3 per second from the published per-minute rate", () => {
    assert.equal(perSecond(8 / 60), "$0.133/s");
    assert.equal(syncOutputSeconds("cut_off", 4, 8.64), 4);
    assert.equal(syncOutputSeconds("loop", 4, 8.64), 8.64);
    assert.equal(syncOutputSeconds("bounce", 10, 1.74), 1.74);
    assert.equal(syncOutputSeconds("silence", 10, 1.74), 10);
    assert.equal(syncOutputSeconds("remap", 10, 1.74), 1.74);
    assert.ok(Math.abs((lipsyncUsd(SYNC, { video: 4, audio: 8.64, option: "cut_off" }) ?? 0) - (4 * 8) / 60) < 1e-9);
    assert.ok(Math.abs((lipsyncUsd(SYNC, { video: 4, audio: 8.64, option: "silence" }) ?? 0) - (8.64 * 8) / 60) < 1e-9);
    const line = lipsyncEstimate(SYNC, { video: 4, audio: 8, option: "loop" });
    assert.match(line?.text ?? "", /\$0\.133\/s/);
    assert.match(line?.text ?? "", /\$8\/min/);
    assert.equal(line?.usd, (8 * 8) / 60);
  });

  it("prices Kling per input video second, rounded up to 5 seconds", () => {
    assert.equal(klingBilledSeconds(3), 5);
    assert.equal(klingBilledSeconds(5), 5);
    assert.equal(klingBilledSeconds(7), 10);
    assert.equal(klingBilledSeconds(10), 10);
    assert.equal(lipsyncUsd(KLING, { video: 3, audio: 20 }), 0.07);
    assert.equal(lipsyncUsd(KLING, { video: 7, audio: 2 }), 0.14);
    const line = lipsyncEstimate(KLING, { video: 3 });
    assert.match(line?.text ?? "", /\$0\.014\/s/);
    assert.equal(line?.usd, 0.07);
  });

  it("prices VEED per output second and skips a total when the lengths differ", () => {
    assert.equal(lipsyncUsd(VEED, { video: 4, audio: 4 }), 0.28);
    assert.equal(lipsyncUsd(VEED, { video: 4, audio: 8 }), undefined);
    const matched = lipsyncEstimate(VEED, { video: 4, audio: 4 });
    assert.match(matched?.text ?? "", /\$0\.07\/s/);
    assert.equal(matched?.usd, 0.28);
    const differed = lipsyncEstimate(VEED, { video: 4, audio: 8 });
    assert.match(differed?.text ?? "", /\$0\.07\/s/);
    assert.equal(differed?.usd, undefined);
  });

  it("prices LatentSync at $0.20 up to 40s, then $0.005 per output second", () => {
    assert.equal(lipsyncUsd(LATENT, { video: 10, audio: 4 }), 0.2);
    assert.equal(lipsyncUsd(LATENT, { video: 4, audio: 40 }), 0.2);
    assert.ok(Math.abs((lipsyncUsd(LATENT, { video: 4, audio: 41 }) ?? 0) - 0.205) < 1e-9);
    const line = lipsyncEstimate(LATENT, { video: 4, audio: 50 });
    assert.match(line?.text ?? "", /\$0\.005\/s/);
    assert.equal(line?.usd, 0.25);
    assert.match(lipsyncEstimate(LATENT, { video: 6 })?.text ?? "", /\$0\.005\/s/);
    assert.equal(lipsyncEstimate(LATENT, { video: 6 })?.usd, undefined);
  });
});
