// Runs the built engine once under Node with an upstream sample profile.
// The build fails if this fails. The report is kept as sample-report.json.
//   node smoke.mjs [profile path] [iterations]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SEASONS } from "./seasons.mjs";

const src = process.env.SIMC_SRC ?? "/src";
const out = process.env.SIMC_OUT ?? "/out";
const { default: createSimc } = await import(`${out}/simc.mjs`);

const sample = SEASONS.map((season) => path.join(src, "profiles", season, `${season}_Warrior_Fury.simc`)).find((file) => existsSync(file));
const profilePath = process.argv[2] ?? sample;
if (!profilePath) throw new Error(`No sample profile found in profiles/ (${SEASONS.join(", ")})`);
const iterations = Number(process.argv[3] ?? 300);
const profile = `${readFileSync(profilePath, "utf8")}\niterations=${iterations}\nthreads=1\nprogressbar_type=1\n`;

const lines = [];
const t0 = performance.now();
const simc = await createSimc({ print: (line) => lines.push(line), printErr: (line) => lines.push(line) });
const t1 = performance.now();
simc.FS.writeFile("/input.simc", profile);
let code;
try {
  code = simc.callMain(["/input.simc", "json2=/report.json", "output=/report.txt"]);
} catch (error) {
  if (error && error.name === "ExitStatus") code = error.status;
  else throw error;
}
const t2 = performance.now();
if (code !== 0) {
  console.error(lines.slice(-40).join("\n"));
  console.error(`[wasm] smoke test failed: exit ${code}`);
  process.exit(1);
}
const json = simc.FS.readFile("/report.json", { encoding: "utf8" });
const report = JSON.parse(json);
const player = report.sim.players[0];
const dps = player.collected_data.dps.mean;
if (!(dps > 0)) {
  console.error(`[wasm] smoke test failed: ${player.name} did no damage`);
  process.exit(1);
}
writeFileSync(`${out}/sample-report.json`, json);
console.log(
  `[wasm] smoke test ok: ${player.name} ${Math.round(dps).toLocaleString("en-US")} dps, ` +
    `${iterations} iterations in ${Math.round(t2 - t1)} ms, start-up ${Math.round(t1 - t0)} ms, simc ${report.version} ${report.git_revision ?? ""}`,
);
