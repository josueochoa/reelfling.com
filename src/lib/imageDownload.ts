// The generated image, as a response to stream into R2.
// ArgoLink's `url` results are public links (kept about 7 days), often on a CDN rather
// than the API host, and the docs do not require the API key to read them. Never send
// the key here: a 401/403 must not be retried with Authorization against that URL.

export async function downloadGeneratedImage(item: { url?: string; b64_json?: string }): Promise<Response> {
  if (item.b64_json) {
    const bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { "content-type": "image/jpeg", "content-length": String(bytes.length) } });
  }
  if (!item.url) throw new Error("ArgoLink returned an image without data");
  const res = await fetch(item.url);
  if (!res.ok) throw new Error(`Couldn't download the generated image (${res.status})`);
  return res;
}
