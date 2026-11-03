#!/usr/bin/env node
// Moves files from the old one-bucket-per-workspace layout into the shared bucket (R2_BUCKET),
// under "<workspace id>/". Each asset is copied (and its thumbnail), then its row is pointed
// at the shared bucket, so the app serves it from there. The app keeps working throughout:
// rows not moved yet still point at their old bucket. Safe to re-run. Old buckets are left
// alone; delete them once you've checked.
//
//   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=reelfling-media \
//     node scripts/migrate-r2-buckets.mjs [--apply] [--local] [--persist-to <dir>]
//
// Without --apply it only lists what it would move. The R2 token needs read access to the old
// buckets and write access to the new one. --local / --persist-to go to `wrangler d1 execute`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const d1Args = args.includes("--local") ? ["--local"] : ["--remote"];
const persist = args.indexOf("--persist-to");
if (persist !== -1) d1Args.push("--persist-to", args[persist + 1]);

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT } = process.env;
if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !(R2_ACCOUNT_ID || R2_ENDPOINT)) {
  console.error("Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.");
  process.exit(1);
}
const endpoint = (R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
const client = new AwsClient({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  service: "s3",
  region: "auto",
});

const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`;

function d1(sql) {
  const dir = mkdtempSync(join(tmpdir(), "d1-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql);
  try {
    const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", ...d1Args, "--json", "--file", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    return JSON.parse(out)[0]?.results ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Server-side copy within the account: no bytes pass through here. */
async function copy(fromBucket, fromKey, toKey) {
  const url = `${endpoint}/${R2_BUCKET}/${toKey}`;
  const source = `/${fromBucket}/${fromKey.split("/").map(encodeURIComponent).join("/")}`;
  const res = await client.fetch(url, { method: "PUT", headers: { "x-amz-copy-source": source } });
  if (res.ok) return;
  const xml = await res.text();
  throw new Error(`${res.status} ${xml.match(/<Code>([^<]+)/)?.[1] ?? ""} copying ${fromBucket}/${fromKey}`);
}

const rows = d1(
  `SELECT workspace_id, key, bucket, bytes, json_extract(meta, '$.thumb') AS thumb FROM assets
   WHERE bucket != ${sqlString(R2_BUCKET)} ORDER BY workspace_id`,
);
const buckets = [...new Set(rows.map((r) => r.bucket))];
const bytes = rows.reduce((n, r) => n + r.bytes, 0);
console.log(
  `${rows.length} files (${(bytes / 1024 ** 2).toFixed(1)} MB) in ${buckets.length} old buckets → ${R2_BUCKET}`,
);
if (!apply) {
  for (const r of rows.slice(0, 20)) console.log(`  ${r.bucket}/${r.key} → ${r.workspace_id}/${r.key}`);
  if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);
  console.log("Dry run. Add --apply to move them.");
  process.exit(0);
}

let moved = 0;
const failed = [];
const updates = [];
const flush = () => {
  if (updates.length) d1(updates.splice(0).join("\n"));
};
for (const r of rows) {
  try {
    await copy(r.bucket, r.key, `${r.workspace_id}/${r.key}`);
    if (r.thumb) await copy(r.bucket, r.thumb, `${r.workspace_id}/${r.thumb}`);
    // Only if it's still where we found it (not deleted or moved meanwhile).
    updates.push(
      `UPDATE assets SET bucket = ${sqlString(R2_BUCKET)} WHERE workspace_id = ${sqlString(r.workspace_id)}
       AND key = ${sqlString(r.key)} AND bucket = ${sqlString(r.bucket)};`,
    );
    moved++;
    if (updates.length >= 50) flush();
  } catch (e) {
    failed.push(`${r.bucket}/${r.key}: ${e.message}`);
  }
}
flush();
console.log(`Moved ${moved} of ${rows.length}.`);
if (failed.length) {
  console.log(`${failed.length} failed (still served from their old bucket; re-run to retry):`);
  for (const f of failed) console.log(`  ${f}`);
  process.exitCode = 1;
}
console.log(`Old buckets, untouched: ${buckets.join(", ") || "none"}`);
