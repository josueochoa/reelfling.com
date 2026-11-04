// Last frame of a finished video, drawn in the browser. The media URL has to be
// same-origin bytes: /api/generations/:id/video redirects to R2, and a canvas
// that paints that video is tainted, so toBlob throws.

/** Seeking to duration itself is often a blank frame. Stop just short of it. */
export const LAST_FRAME_EPSILON_S = 0.05;

export function lastFrameTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const epsilon = Math.min(LAST_FRAME_EPSILON_S, duration / 2);
  return Math.max(0, duration - epsilon);
}

/** Same-origin MP4. The route streams the file instead of redirecting. */
export const generationBytesUrl = (id: string) => `/api/generations/${encodeURIComponent(id)}/video?bytes=1`;

const jpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't encode the last frame"))), "image/jpeg", 0.92),
  );

/**
 * Seek near the end and return a JPEG of that frame.
 * `src` must be same-origin. Do not set crossOrigin: the generation route's
 * redirect to storage would taint the canvas.
 */
export function extractLastFrame(src: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Couldn't read the last frame of this video"));
    };
    const draw = () => {
      if (settled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        if (!canvas.width || !canvas.height) return fail();
        const ctx = canvas.getContext("2d");
        if (!ctx) return fail();
        ctx.drawImage(video, 0, 0);
        void jpeg(canvas).then(
          (blob) => {
            if (settled) return;
            settled = true;
            resolve(blob);
          },
          fail,
        );
      } catch {
        fail();
      }
    };
    video.onerror = fail;
    video.onloadeddata = () => {
      const target = lastFrameTime(video.duration);
      if (Math.abs(video.currentTime - target) < 0.001) draw();
      else video.currentTime = target;
    };
    video.onseeked = draw;
    video.src = src;
  });
}
