#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
PACKAGE_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$PACKAGE_ROOT/build/wasm"

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc not found"
  exit 1
fi

mkdir -p "$OUT_DIR"

emcc \
  "$PACKAGE_ROOT/native/collision_core.cpp" \
  "$PACKAGE_ROOT/native/wasm_exports.cpp" \
  -O3 \
  -std=c++17 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=web \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_FUNCTIONS='["_avara_find_segment_impact","_avara_find_ray_distance"]' \
  -s EXPORTED_RUNTIME_METHODS='["cwrap","getValue","setValue","_malloc","_free"]' \
  -o "$OUT_DIR/avara_native_core.js"
