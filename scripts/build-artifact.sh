#!/usr/bin/env bash
# Builds a single-folder bundle for hosting where .glb isn't served (e.g. claude.ai artifacts):
# models are converted to embedded glTF JSON (*.gltf.json) and CSS is inlined into index.html.
# Usage: scripts/build-artifact.sh <outDir>
set -euo pipefail
OUT=${1:?outDir}
VITE_MODEL_EXT=.gltf.json npx vite build --outDir "$OUT/build" --emptyOutDir >/dev/null
rm -rf "$OUT/assets" && mkdir -p "$OUT/assets"
cp "$OUT/build/assets/"*.js "$OUT/assets/"
mkdir -p "$OUT/assets/characters/Textures"
cp public/assets/characters/Textures/colormap.png "$OUT/assets/characters/Textures/"
python3 -I scripts/glb2gltf.py public/assets/characters "$OUT/assets/characters"
JS=$(cd "$OUT/assets" && ls *.js)
{
  echo '<title>Footballbro</title>'
  echo '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lilita+One&family=Russo+One&family=Nunito:wght@600;800&display=swap">'
  echo '<style>:root{color-scheme:dark}'; cat "$OUT/build/assets/"*.css; echo '</style>'
  echo '<div id="game"></div><div id="ui"></div>'
  echo "<script type=\"module\" src=\"assets/$JS\"></script>"
} > "$OUT/index.html"
rm -rf "$OUT/build"
echo "artifact bundle in $OUT"
