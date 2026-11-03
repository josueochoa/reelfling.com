import {
  CAMERA_MOVE_IDS,
  type CameraMove,
  type VideoModel,
  type VideoTask,
} from "./types";

const LABELS: Record<CameraMove, string> = {
  static: "Static",
  "push-in": "Push in",
  "pull-out": "Pull out",
  "pan-left": "Pan left",
  "pan-right": "Pan right",
  "tilt-up": "Tilt up",
  "tilt-down": "Tilt down",
  orbit: "Orbit",
  "crane-up": "Crane up",
  handheld: "Handheld",
  "dolly-zoom": "Dolly zoom",
};

export const CAMERA_MOVES: readonly { id: CameraMove; label: string }[] = CAMERA_MOVE_IDS.map((id) => ({
  id,
  label: LABELS[id],
}));

export function isCameraMove(value: string): value is CameraMove {
  return (CAMERA_MOVE_IDS as readonly string[]).includes(value);
}

export function cameraMoveLabel(id: string | undefined): string | undefined {
  if (!id || !isCameraMove(id)) return undefined;
  return LABELS[id];
}

/** Tasks where a line in the prompt can change the camera. The others hide the picker. */
const PROMPT_TASKS = new Set<VideoTask>(["t2v", "i2v", "ref2v"]);

function allowsPrompt(model: VideoModel): boolean {
  const camera = model.capabilities.camera;
  if (camera && camera.prompt === false) return false;
  if (camera && camera.prompt === true) return true;
  // No native parameter in the catalog. Generative tasks still follow a prompt line.
  return PROMPT_TASKS.has(model.task);
}

/** Presets the composer can offer. Empty means the picker is hidden. */
export function cameraMovesFor(model: VideoModel): CameraMove[] {
  if (allowsPrompt(model)) return [...CAMERA_MOVE_IDS];
  const camera = model.capabilities.camera;
  if (!camera || !camera.native) return [];
  const native = camera.native;
  return CAMERA_MOVE_IDS.filter((id) => {
    const binding = native[id];
    return binding?.param === "camera_fixed" && typeof binding.value === "boolean";
  });
}

/** The move Reuse puts back, or nothing when this model would ignore it. */
export function keptCameraMove(model: VideoModel, move: string | undefined): CameraMove | undefined {
  if (!move || !isCameraMove(move)) return undefined;
  return cameraMovesFor(model).includes(move) ? move : undefined;
}
