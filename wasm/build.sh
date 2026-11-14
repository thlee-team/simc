#!/usr/bin/env bash
# Builds SimulationCraft as WebAssembly for browsers: one thread, no networking, no PTR data.
# Runs inside the Emscripten container (see docker-build.sh):
#   /src  this repository
#   /out  where the engine files are written
set -euo pipefail

src="${SIMC_SRC:-/src}"
out="${SIMC_OUT:-/out}"
jobs="${SIMC_BUILD_JOBS:-$(nproc)}"
use_ptr="${SIMC_USE_PTR:-0}"
recipe="${src}/wasm"
dist="$(mktemp -d)"
mkdir -p "${out}"

# The repository is mounted from the host, so git sees a different owner.
git config --global --add safe.directory "${src}" 2>/dev/null || true

# -fwasm-exceptions: simc reports errors with C++ exceptions, and wasm exceptions are faster than the JS kind.
opts="-DSC_NO_THREADING -DSC_USE_PTR=${use_ptr} -fwasm-exceptions"

# -O2 at link time runs wasm-opt and shrinks the glue script.
# INITIAL_MEMORY is 96 MiB. A 6,000 iteration run fits in it, and memory can still grow.
# INVOKE_RUN=0: the worker calls main itself. HEAPU8 lets it read how much memory a run used.
link_flags="-O2 -fwasm-exceptions -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node"
link_flags+=" -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=100663296 -sSTACK_SIZE=8388608"
link_flags+=" -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS,HEAPU8"

make_args=(CXX=em++ FLAVOR=WebAssembly LINK_LIBS= "MODULE=${dist}/simc.mjs" NO_DEBUG=1 SC_NO_NETWORKING=1)

echo "[wasm] building with -j${jobs}"
started=$(date +%s)
make -C "${src}/engine" -j"${jobs}" release "${make_args[@]}" "OPTS=${opts}" "LINK_FLAGS=${link_flags}" | grep -v "Compiling" || true
[[ -f "${dist}/simc.wasm" ]] || { echo "[wasm] build failed: simc.wasm is missing"; exit 1; }
echo "[wasm] built in $(( $(date +%s) - started ))s"

cp "${dist}/simc.mjs" "${dist}/simc.wasm" "${out}/"
cp "${recipe}/worker.js" "${out}/worker.js"
SIMC_SRC="${src}" SIMC_OUT="${out}" SIMC_USE_PTR="${use_ptr}" SIMC_FLAGS="${opts} ${link_flags}" node "${recipe}/stage.mjs"
SIMC_SRC="${src}" SIMC_OUT="${out}" node "${recipe}/smoke.mjs"
