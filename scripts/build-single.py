"""Build one self-contained index.html (JS, CSS, models, textures inlined) for artifact hosting.
Usage: VITE_ENTRY=index npx vite build --outDir .scratch/single-build && python3 -I scripts/build-single.py .scratch/single-build <out.html> [title]
(VITE_ENTRY=index -> party footballbro, =classic -> classic game)"""
import base64, glob, json, os, struct, sys

build, out = sys.argv[1], sys.argv[2]
title = sys.argv[3] if len(sys.argv) > 3 else "Golazo"
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
chars = os.path.join(root, 'public/assets/characters')
png = 'data:image/png;base64,' + base64.b64encode(open(os.path.join(chars, 'Textures/colormap.png'), 'rb').read()).decode()
models = {}
# Footballbro's beans are built in code; only Soccerbro needs the Kenney minis
for f in (sorted(glob.glob(os.path.join(chars, '*.glb'))) if title == 'Soccerbro' else []):
    b = open(f, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    rest = b[20 + jl:]
    # drop the external texture: the page assigns the palette itself (artifact pages cannot fetch)
    for k in ('images', 'textures', 'samplers'):
        j.pop(k, None)
    for m in j.get('materials', []):
        m.get('pbrMetallicRoughness', {}).pop('baseColorTexture', None)
    js_ = json.dumps(j, separators=(',', ':')).encode()
    js_ += b' ' * ((4 - len(js_) % 4) % 4)
    body = struct.pack('<II', len(js_), 0x4E4F534A) + js_ + rest
    glb = struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body
    models[os.path.basename(f)[:-4]] = base64.b64encode(glb).decode()
js = open(glob.glob(os.path.join(build, 'assets/*.js'))[0]).read().replace('</script', '<\\/script')
css = open(glob.glob(os.path.join(build, 'assets/*.css'))[0]).read()
with open(out, 'w') as o:
    o.write('<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">\n<title>' + title + '</title>\n')
    o.write('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lilita+One&family=Russo+One&family=Nunito:wght@600;800;900&display=swap">\n')
    o.write('<style>:root{color-scheme:dark}' + css + '</style>\n<div id="game"></div><div id="ui"></div>\n')
    o.write('<script>window.__FB_MODELS=' + json.dumps(models) + ';window.__FB_PALETTE=' + json.dumps(png) + ';</script>\n')
    o.write('<script type="module">' + js + '</script>\n')
print('wrote', out, os.path.getsize(out) // 1024, 'KB')
