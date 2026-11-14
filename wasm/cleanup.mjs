// Deletes old builds from the R2 bucket that publish.mjs uploads to.
//   node wasm/cleanup.mjs [--dry-run]
//
// A build is deleted when the build after it was published more than 7 days ago. Normally that is
// 7 days after it stopped being the one pages load. The newest 3 builds are always kept, however old,
// and so is the one latest.json names.
// Only folders directly under <prefix>/ that are named like a build are touched.
// With --dry-run it prints what it would delete and deletes nothing.
//
// The script goes by folder names alone. A folder left by a failed upload counts as a build, and when
// latest.json was pointed back at an older build by hand, the builds after it still count as having
// replaced it. In those cases a build can be deleted sooner than 7 days after pages stopped loading it.
//
// Environment: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PREFIX.
// The keys must be allowed to read, list and delete objects. Limit them to this one bucket.
//
// This script runs with the upload keys. Keep it free of imports other than Node's own modules and r2.mjs.
import { prefixFromEnv, send, targetFromEnv } from "./r2.mjs";

const KEEP_DAYS = 7;
const KEEP_NEWEST = 3;
// publish.mjs names a build folder after the minute it was published (UTC) and its commit, like 20261115-0817-61d87939263e.
const BUILD_NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-[0-9a-f]{12}$/;
// What a file in a build folder can be called. Objects with any other kind of name are never deleted.
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const args = process.argv.slice(2);
// A mistyped --dry-run must not turn into a real run.
if (args.some((arg) => arg !== "--dry-run")) throw new Error("usage: node wasm/cleanup.mjs [--dry-run]");
const dryRun = args.includes("--dry-run");
const prefix = prefixFromEnv();
const target = targetFromEnv();

/**
 * What one listing holds under `query.prefix`: the text of every <tag> element, so "Key" for objects and "Prefix" for folders.
 * The text is taken as it stands in the XML, and the answer also repeats the prefix that was asked for,
 * so every name has to be checked before it is used.
 */
async function list(query, tag) {
  const response = await send(target, { method: "GET", query: { "list-type": "2", ...query }, failure: `${query.prefix}: listing failed` });
  const xml = await response.text();
  // One answer holds up to 1000 names. There are far fewer here, so a longer listing means something is wrong.
  if (/<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)) throw new Error(`${query.prefix}: more entries than one listing can hold`);
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((match) => match[1]);
}

// The build that pages load right now. It is read from the bucket itself, because a cache may answer for the public address.
const pointer = `${prefix}/latest.json`;
const text = await (await send(target, { method: "GET", key: pointer, failure: `${pointer}: read failed` })).text();
let live;
try {
  live = JSON.parse(text)?.build;
} catch {
  // Not JSON. The check below reports it without printing the text.
}
if (typeof live !== "string" || !BUILD_NAME.test(live)) throw new Error(`${pointer} does not name a build`);

const builds = [];
for (const folder of await list({ prefix: `${prefix}/`, delimiter: "/" }, "Prefix")) {
  const name = folder.slice(prefix.length + 1, -1);
  if (folder === `${prefix}/${name}/` && BUILD_NAME.test(name)) builds.push(name);
}
// A listing without the live build cannot be trusted to show the rest.
if (!builds.includes(live)) throw new Error(`the listing does not show ${live}, the build that ${pointer} names`);

const publishedAt = (name) => {
  const [, year, month, day, hour, minute] = name.match(BUILD_NAME).map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
};
const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
// Names start with the time, so sorting them puts the oldest first, and the build after builds[at] is builds[at + 1].
builds.sort();
const old = builds.filter((name, at) => at < builds.length - KEEP_NEWEST && name !== live && publishedAt(builds[at + 1]) < cutoff);

let left = 0;
for (const name of old) {
  const folder = `${prefix}/${name}/`;
  const keys = await list({ prefix: folder }, "Key");
  const files = keys.filter((key) => key.startsWith(folder) && FILE_NAME.test(key.slice(folder.length)));
  if (!dryRun) for (const key of files) await send(target, { method: "DELETE", key, failure: `${key}: delete failed` });
  left += keys.length - files.length;
  console.log(`${dryRun ? "would delete" : "deleted"} ${files.length} of ${keys.length} objects in ${folder}`);
}
console.log(`builds kept: ${builds.length - old.length}`);
if (left) {
  // Worth a look, but not a failure. On GitHub Actions this line becomes an annotation on the run.
  const message = `Objects with unexpected names in old build folders were left alone: ${left}. Delete them by hand if they are not needed.`;
  console.log(`${process.env.GITHUB_ACTIONS ? "::warning::" : ""}${message}`);
}
