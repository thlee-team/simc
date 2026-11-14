# WebAssembly build

This folder builds SimulationCraft as a WebAssembly module that runs in a browser.
It is an addition in this fork and is not part of upstream SimulationCraft.

The build has one thread, no networking and no PTR data. A page gets parallel runs by
starting several workers and merging their reports.

## Build

Docker is the only requirement.

```bash
wasm/docker-build.sh out
```

This compiles the engine in a pinned Emscripten container, runs one short simulation under
Node as a check, and writes these files to `out/`:

| File | What it is |
|---|---|
| `simc.wasm`, `simc.mjs` | The engine and the glue script made by Emscripten |
| `worker.js` | A module worker around the engine |
| `engine.json` | Which commit was built, with which flags, and when |
| `defaults.json` | Default talents per spec, read from the season profiles |
| `sample-report.json` | The report of the check run |

## Using the worker

Start `worker.js` as a module worker and exchange plain messages with it.

- Send `{ type: "run", id, profile }`, where `profile` is SimulationCraft input text.
- Receive `{ type: "done", id, json, timing }`, where `json` is the JSON report as text,
  or `{ type: "error", id, message, log }`.

The comment at the top of `worker.js` describes how several workers share one download of the engine.

## Automatic builds

The `wasm-engine` workflow merges new upstream commits, builds, and uploads the result.
Each build is uploaded to its own folder, and `latest.json` names the one pages load,
normally the newest.

After an upload, a separate job deletes old builds. A build is deleted when the build after
it was published more than 7 days ago. The newest 3 builds are always kept, however old, and
so is the one `latest.json` names. The comment at the top of `cleanup.mjs` has the details.

With the environment variables listed there, `node wasm/cleanup.mjs --dry-run` prints what
would be deleted without deleting anything.

Upstream changes under `.github/` are never merged automatically. The workflow stops and
asks for someone to read them first.

## License

SimulationCraft is licensed under GPL-3.0, and so is everything in this folder.
The exact source of a build is this repository at the commit named in its `engine.json`.
