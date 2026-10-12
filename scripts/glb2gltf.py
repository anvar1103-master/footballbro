"""Convert every .glb in a folder to glTF JSON with embedded base64 buffers (*.gltf.json)."""
import base64, json, os, struct, sys

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
for name in sorted(os.listdir(src)):
    if not name.endswith('.glb'):
        continue
    b = open(os.path.join(src, name), 'rb').read()
    jlen = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jlen])
    off = 20 + jlen
    blen = struct.unpack('<I', b[off:off + 4])[0]
    binc = b[off + 8: off + 8 + blen]
    j['buffers'][0]['uri'] = 'data:application/octet-stream;base64,' + base64.b64encode(binc).decode()
    out = os.path.join(dst, name[:-4] + '.gltf.json')
    json.dump(j, open(out, 'w'), separators=(',', ':'))
