#!/usr/bin/env bash
# Build the Yandex Games package: golazo-yandex.zip with index.html in the root (relative paths, local fonts,
# the SDK is loaded from /sdk.js which Yandex serves itself).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=.scratch/yandex
rm -rf "$OUT" && mkdir -p "$OUT"
VITE_ENTRY=index npx vite build --outDir "$OUT" --emptyOutDir
rm -rf "$OUT"/party.html "$OUT"/classic.html "$OUT"/assets/characters
(cd "$OUT" && rm -f ../golazo-yandex.zip && zip -qr ../golazo-yandex.zip .)
echo "zip: $(du -h .scratch/golazo-yandex.zip | cut -f1)"; unzip -l .scratch/golazo-yandex.zip | tail -15
