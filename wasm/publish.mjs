// Uploads a finished build to an R2 bucket, then points latest.json at it.
//   node wasm/publish.mjs <build dir> [--dry-run]
//
// Every build goes to its own folder and is never changed afterwards:
//   <prefix>/<build id>/simc.wasm, simc.mjs, worker.js, engine.json, defaults.json, sample-report.json, LICENSE.txt
//   <prefix>/latest.json   names the build that pages should load
// latest.json is written last, so a page never sees a build that is only half uploaded.
//
// Environment: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PREFIX, SIMC_REVISION,
// and optionally SIMC_UPSTREAM_REVISION and SIMC_UPSTREAM_DATE.
// With ENGINE_PUBLIC_BASE (the public address of <prefix>) the upload is read back over that address:
// the build before latest.json moves, and latest.json afterwards, in case a cache still serves the old one.
//
// This script runs with the upload keys. Keep it free of imports other than Node's own modules and r2.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prefixFromEnv, send, sha256, targetFromEnv } from "./r2.mjs";

const MIB = 1048576;
// Taken from the build directory. These files come out of compiling and running upstream code,
// so they are uploaded as they are and never run here.
const BUILT = [
  { name: "simc.wasm", type: "application/wasm", limit: 200 * MIB },
  { name: "simc.mjs", type: "text/javascript", limit: 2 * MIB },
  { name: "engine.json", type: "application/json", limit: MIB },
  { name: "defaults.json", type: "application/json", limit: MIB },
  { name: "sample-report.json", type: "application/json", limit: 8 * MIB },
];
// Taken from this checkout, not from the build directory.
const OWN = [
  { name: "worker.js", type: "text/javascript", from: new URL("./worker.js", import.meta.url) },
  { name: "LICENSE.txt", type: "text/plain; charset=utf-8", from: new URL("../LICENSE", import.meta.url) },
];

// A build folder never changes, so it can be cached for good.
const KEEP_FOREVER = "public, max-age=31536000, immutable";
// latest.json changes with every build, so it is cached for 15 minutes only.
// A short cache still keeps a flood of requests away from the bucket.
const POINTER_MAX_AGE = 15 * 60;
const BRIEFLY = `public, max-age=${POINTER_MAX_AGE}`;

const put = (target, key, body, type, cacheControl) =>
  send(target, { method: "PUT", key, headers: { "content-type": type, "cache-control": cacheControl }, body, failure: `${key}: upload failed` });

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dir = args.find((arg) => !arg.startsWith("--"));
if (!dir) throw new Error("usage: node wasm/publish.mjs <build dir> [--dry-run]");

const optional = (name, pattern) => {
  const value = process.env[name] ?? "";
  if (value && !pattern.test(value)) throw new Error(`${name} has an unexpected format`);
  return value || null;
};
const COMMIT = /^[0-9a-f]{40}$/;
const revision = process.env.SIMC_REVISION ?? "";
if (!COMMIT.test(revision)) throw new Error("SIMC_REVISION must be a full commit id");
const upstreamRevision = optional("SIMC_UPSTREAM_REVISION", COMMIT);
const upstreamDate = optional("SIMC_UPSTREAM_DATE", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
const prefix = prefixFromEnv();
const target = targetFromEnv({ optional: dryRun });
const publicBase = (process.env.ENGINE_PUBLIC_BASE ?? "").replace(/\/+$/, "");

const files = [
  ...BUILT.map(({ name, type, limit }) => {
    const body = readFileSync(path.join(dir, name));
    if (body.length > limit) throw new Error(`${name} is larger than expected`);
    return { name, type, body };
  }),
  ...OWN.map(({ name, type, from }) => ({ name, type, body: readFileSync(fileURLToPath(from)) })),
];
const engine = JSON.parse(files.find((file) => file.name === "engine.json").body.toString("utf8"));
if (engine.simcRevision !== revision) throw new Error("The build directory holds a build of another commit");

const now = new Date();
const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
const build = `${stamp}-${revision.slice(0, 12)}`;
const latest = {
  build,
  revision,
  upstreamRevision,
  upstreamDate,
  builtAt: now.toISOString(),
  files: Object.fromEntries(files.map((file) => [file.name, { bytes: file.body.length, sha256: sha256(file.body) }])),
};

for (const file of files) {
  const key = `${prefix}/${build}/${file.name}`;
  if (!dryRun) await put(target, key, file.body, file.type, KEEP_FOREVER);
  console.log(`${dryRun ? "would upload" : "uploaded"} ${key} (${(file.body.length / MIB).toFixed(2)} MiB)`);
}

if (publicBase && !dryRun) {
  const response = await fetch(`${publicBase}/${build}/engine.json`);
  if (!response.ok) throw new Error(`The uploaded build cannot be read back (${response.status}). latest.json was not changed.`);
  const seen = await response.json();
  if (seen.simcRevision !== revision) throw new Error("The uploaded build reads back differently. latest.json was not changed.");
  console.log("read the upload back over the public address");
}

const pointer = `${prefix}/latest.json`;
if (!dryRun) await put(target, pointer, Buffer.from(`${JSON.stringify(latest, null, 2)}\n`), "application/json", BRIEFLY);
console.log(`${dryRun ? "would point" : "pointed"} ${pointer} at ${build}`);

if (publicBase && !dryRun) {
  // Pages read latest.json over the public address, so wait until the new one is what they get.
  // A cache may keep serving the previous one until it expires.
  const deadline = Date.now() + (POINTER_MAX_AGE + 180) * 1000;
  for (;;) {
    const seen = await fetch(`${publicBase}/latest.json`)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    if (seen && seen.build === build) break;
    if (Date.now() > deadline) {
      throw new Error("latest.json was uploaded, but the public address still serves an older one. A cache in front of the bucket is holding it.");
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  console.log("the public address serves the new latest.json");

  const wasm = await fetch(`${publicBase}/${build}/simc.wasm`);
  const encoding = wasm.headers.get("content-encoding");
  await wasm.body?.cancel();
  console.log(`simc.wasm is served ${encoding ? `compressed (${encoding})` : "without compression"}`);
}
