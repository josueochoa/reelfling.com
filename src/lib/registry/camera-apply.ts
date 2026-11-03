// Server only. The composer stores the preset id and never shows these sentences.

import type { GenerateRequest } from "../types";
import { cameraMovesFor, isCameraMove } from "./camera";
import type { CameraMove, VideoModel } from "./types";

const INSTRUCTIONS: Record<CameraMove, string> = {
  static: "The camera is locked off and does not pan, tilt, zoom, or drift.",
  "push-in": "The camera slowly pushes in toward the subject.",
  "pull-out": "The camera slowly pulls back, revealing more of the scene.",
  "pan-left": "The camera pans smoothly to the left.",
  "pan-right": "The camera pans smoothly to the right.",
  "tilt-up": "The camera tilts up.",
  "tilt-down": "The camera tilts down.",
  orbit: "The camera orbits around the subject.",
  "crane-up": "The camera cranes upward, rising while keeping the subject in frame.",
  handheld: "The camera is handheld, with a light natural sway.",
  "dolly-zoom":
    "The camera dollies in while the lens zooms out, so the subject stays the same size and the background stretches.",
};

function nativeFixed(model: VideoModel, move: CameraMove): boolean | undefined {
  const camera = model.capabilities.camera;
  if (!camera) return undefined;
  const binding = camera.native?.[move];
  if (!binding || binding.param !== "camera_fixed" || typeof binding.value !== "boolean") return undefined;
  return binding.value;
}

function withInstruction(prompt: string, instruction: string): string {
  const base = prompt.trim();
  if (!base) return instruction;
  if (base.endsWith(instruction)) return base;
  return /[.!?…]$/.test(base) ? `${base} ${instruction}` : `${base}. ${instruction}`;
}

/**
 * The request a provider should see. A verified native parameter is sent as that
 * field and the prompt is left alone. Otherwise a camera sentence is appended.
 * The user's prompt and the preset id stay on the generation record.
 */
export function applyCameraMove(model: VideoModel, req: GenerateRequest): GenerateRequest {
  const { cameraMove, ...rest } = req;
  if (!cameraMove || !isCameraMove(cameraMove) || !cameraMovesFor(model).includes(cameraMove)) return rest;
  const fixed = nativeFixed(model, cameraMove);
  if (fixed !== undefined) return { ...rest, cameraFixed: fixed };
  const prompted: GenerateRequest = { ...rest, prompt: withInstruction(req.prompt, INSTRUCTIONS[cameraMove]) };
  delete prompted.cameraFixed;
  return prompted;
}
