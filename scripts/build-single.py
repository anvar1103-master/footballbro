"""Build one self-contained index.html (JS, CSS, models, textures inlined) for artifact hosting.
Usage: npx vite build --outDir .scratch/single-build && python3 -I scripts/build-single.py .scratch/single-build <out.html>"""
import base64, glob, json, os, struct, sys

build, out = sys.argv[1], sys.argv[2]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
chars = os.path.join(root, 'public/assets/characters')
png = 'data:image/png;base64,' + base64.b64encode(open(os.path.join(chars, 'Textures/colormap.png'), 'rb').read()).decode()
models = {}
for f in sorted(glob.glob(os.path.join(chars, '*.glb'))):
    b = open(f, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack('<I', b[off:off + 4])[0]
    j['buffers'][0]['uri'] = 'data:application/octet-stream;base64,' + base64.b64encode(b[off + 8:off + 8 + bl]).decode()
    for im in j.get('images', []):
        im['uri'] = png
    models[os.path.basename(f)[:-4]] = json.dumps(j, separators=(',', ':'))
js = open(glob.glob(os.path.join(build, 'assets/*.js'))[0]).read().replace('</script', '<\\/script')
css = open(glob.glob(os.path.join(build, 'assets/*.css'))[0]).read()
with open(out, 'w') as o:
    o.write('<title>Footballbro</title>\n')
    o.write('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lilita+One&family=Russo+One&family=Nunito:wght@600;800&display=swap">\n')
    o.write('<style>:root{color-scheme:dark}' + css + '</style>\n<div id="game"></div><div id="ui"></div>\n')
    o.write('<script>window.__FB_MODELS=' + json.dumps(models) + ';</script>\n')
    o.write('<script type="module">' + js + '</script>\n')
print('wrote', out, os.path.getsize(out) // 1024, 'KB')
