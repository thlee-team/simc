#!/usr/bin/env bash
# Runs wasm/build.sh inside a pinned Emscripten container.
#   wasm/docker-build.sh <output dir>
# The container gets no network. The build does not need one.
set -euo pipefail

image="emscripten/emsdk:6.0.10@sha256:d4d9b9a07e28f8795ebca83b4b3bf98febb65f956e1364ac32483eea3d99bd8f"

out="${1:?usage: wasm/docker-build.sh <output dir>}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "${out}"
out="$(cd "${out}" && pwd)"

# .git is read-only so the build cannot leave settings behind that git would act on later.
docker run --rm --network none \
  -v "${repo}:/src" -v "${repo}/.git:/src/.git:ro" -v "${out}:/out" \
  -e SIMC_REVISION -e SIMC_SOURCE_URL \
  -e SIMC_UPSTREAM_REVISION -e SIMC_UPSTREAM_DATE \
  -e SIMC_BUILD_JOBS -e SIMC_USE_PTR \
  "${image}" bash /src/wasm/build.sh
