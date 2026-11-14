// Writes two files next to the engine:
//   engine.json    what was built, and from which commit
//   defaults.json  default talents per spec, read from upstream's season profiles
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SEASONS } from "./seasons.mjs";

const src = process.env.SIMC_SRC;
const out = process.env.SIMC_OUT;
if (!src || !out) throw new Error("SIMC_SRC and SIMC_OUT are required");

const env = (name) => process.env[name] || "";
const git = (args) => {
  try {
    return execSync(`git -C ${src} ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const revision = env("SIMC_REVISION") || git("rev-parse HEAD");
if (!revision) throw new Error("Could not tell which commit is being built. Set SIMC_REVISION.");

const engine = {
  name: "SimulationCraft",
  license: "GPL-3.0",
  // The exact source of this build is at `${source}/tree/${simcRevision}`.
  source: env("SIMC_SOURCE_URL") || "https://github.com/simulationcraft/simc",
  simcRevision: revision,
  // The newest upstream commit in this build. Its date tells how fresh the game data is.
  upstreamRevision: env("SIMC_UPSTREAM_REVISION") || revision,
  simcCommitDate: env("SIMC_UPSTREAM_DATE") || git("show -s --format=%cI HEAD"),
  emscripten: execSync("emcc --version", { encoding: "utf8" }).split("\n")[0],
  threading: false,
  networking: false,
  ptr: process.env.SIMC_USE_PTR === "1",
  flags: env("SIMC_FLAGS"),
  wasmBytes: statSync(path.join(out, "simc.wasm")).size,
  builtAt: new Date().toISOString(),
};
writeFileSync(path.join(out, "engine.json"), `${JSON.stringify(engine, null, 2)}\n`);

// A spec can have several profiles (one per hero talent tree). All are kept, shortest name first.
// Profiles from an older season are used only for specs the newest season does not have.
const defaults = {};
SEASONS.forEach((season, index) => {
  const dir = path.join(src, "profiles", season);
  let files = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".simc"));
  } catch {
    return;
  }
  const newer = SEASONS.slice(0, index);
  for (const file of files.sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    const text = readFileSync(path.join(dir, file), "utf8");
    const head = text.match(/^([a-z_]+)="([^"]+)"/m);
    const spec = text.match(/^spec=([a-z_]+)/m);
    const talents = text.match(/^talents=(\S+)/m);
    if (!head || !spec || !talents) continue;
    const list = (defaults[`${head[1]}:${spec[1]}`] ??= []);
    if (list.some((entry) => entry.talents === talents[1])) continue;
    if (list.some((entry) => newer.some((name) => entry.name.startsWith(name)))) continue;
    list.push({ name: head[2], talents: talents[1] });
  }
});
if (Object.keys(defaults).length === 0) throw new Error(`No season profiles found in profiles/ (${SEASONS.join(", ")})`);
writeFileSync(path.join(out, "defaults.json"), `${JSON.stringify(defaults)}\n`);

console.log(`[wasm] staged: simc.wasm ${(engine.wasmBytes / 1048576).toFixed(1)} MiB, ${Object.keys(defaults).length} specs in defaults.json`);
