// A module worker around the SimulationCraft engine. A page talks to it with plain messages:
//   in   { type: "run", id, profile: string, args?: string[] }
//   out  { type: "ready" }, { type: "log", id, line }, { type: "done", id, json, timing }, { type: "error", id, message, log }
//
// The engine file is downloaded once. When a page starts several workers it connects the first one (the lead)
// to each of the others with a MessagePort, and the lead hands them the compiled engine. Several workers
// downloading the same large file at once can make the browser abort the responses.
//   in   { type: "peer", port }  to the lead: a port to one other worker
//        { type: "lead", port }  to the others: a port from the lead
// The port carries { type: "engine", module } or { type: "engine-error", message }.
import createSimc from "./simc.mjs";

/** The compiled engine (WebAssembly.Module), one per worker. Every run gets a fresh instance, so no state leaks between runs. */
let compiled = null;
/** Ports to the other workers, known to the lead. */
const peers = [];

function sendEngine(port) {
  compiled.then(
    (module) => port.postMessage({ type: "engine", module }),
    (error) => port.postMessage({ type: "engine-error", message: String(error && error.message ? error.message : error) }),
  );
}

/** The lead (or a worker on its own) downloads and compiles the engine. */
function compileEngine() {
  if (!compiled) {
    compiled = WebAssembly.compileStreaming(fetch(new URL("./simc.wasm", import.meta.url)));
    for (const port of peers) sendEngine(port);
  }
  return compiled;
}

/** The other workers wait for the engine from the lead. */
function awaitEngineFrom(port) {
  compiled = new Promise((resolve, reject) => {
    port.onmessage = (event) => {
      const message = event.data;
      if (message && message.type === "engine") resolve(message.module);
      else if (message && message.type === "engine-error") reject(new Error(message.message));
    };
  });
}

async function run({ id, profile, args }) {
  const log = [];
  const emit = (line) => {
    log.push(line);
    if (log.length > 400) log.shift();
    self.postMessage({ type: "log", id, line });
  };
  try {
    const t0 = performance.now();
    const wasmModule = await compileEngine();
    const t1 = performance.now();
    const simc = await createSimc({
      instantiateWasm(imports, receive) {
        WebAssembly.instantiate(wasmModule, imports).then((instance) => receive(instance, wasmModule));
        return {};
      },
      print: emit,
      printErr: emit,
    });
    const t2 = performance.now();
    simc.FS.writeFile("/input.simc", profile);
    let code;
    try {
      code = simc.callMain(["/input.simc", "json2=/report.json", "output=/report.txt", ...(args ?? [])]);
    } catch (error) {
      if (error && error.name === "ExitStatus") code = error.status;
      else throw error;
    }
    const t3 = performance.now();
    if (code !== 0) {
      self.postMessage({ type: "error", id, message: `simc exited with code ${code}`, log });
      return;
    }
    const json = simc.FS.readFile("/report.json", { encoding: "utf8" });
    self.postMessage({
      type: "done",
      id,
      json,
      // memoryBytes: the size of the engine memory when the run ended
      timing: { compileMs: t1 - t0, instantiateMs: t2 - t1, runMs: t3 - t2, memoryBytes: simc.HEAPU8 ? simc.HEAPU8.length : 0 },
    });
  } catch (error) {
    self.postMessage({ type: "error", id, message: String(error && error.message ? error.message : error), log });
  }
}

/** A worker runs one simulation at a time. Requests that overlap wait their turn. */
let chain = Promise.resolve();
self.onmessage = (event) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "run") chain = chain.then(() => run(message));
  else if (message.type === "peer") {
    peers.push(message.port);
    if (compiled) sendEngine(message.port);
  } else if (message.type === "lead" && !compiled) awaitEngineFrom(message.port);
};

self.postMessage({ type: "ready" });
