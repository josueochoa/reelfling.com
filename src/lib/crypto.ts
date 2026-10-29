import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

let cachedKey: Buffer | undefined;

/** 32-byte key for API-key encryption, derived from AUTH_SECRET. */
function encryptionKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must be set (32+ chars). See .env.example.");
  cachedKey = Buffer.from(hkdfSync("sha256", secret, "seedance-studio", "api-keys", 32));
  return cachedKey;
}

/** AES-256-GCM. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encrypt(plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ct]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decrypt(payload: string) {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1") throw new Error("Unknown ciphertext version");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
