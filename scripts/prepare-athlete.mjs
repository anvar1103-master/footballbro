// Prepares public/assets/athlete/xbot.glb from three.js examples/models/gltf/Xbot.glb (Mixamo):
// keeps idle/walk/run, removes hips root motion and finger/eye tracks, prunes unused data.
// Usage: npm i --no-save @gltf-transform/core@4 @gltf-transform/functions@4 && node scripts/prepare-athlete.mjs Xbot.glb public/assets/athlete/xbot.glb
import { NodeIO } from '@gltf-transform/core';
import { prune, dedup } from '@gltf-transform/functions';
const io = new NodeIO();
const doc = await io.read(process.argv[2]);
const keep = new Set(['idle', 'walk', 'run']);
for (const a of doc.getRoot().listAnimations()) if (!keep.has(a.getName())) a.dispose();
// drop root motion in x/z on the hips so the clips run in place
for (const a of doc.getRoot().listAnimations()) {
  for (const ch of a.listChannels()) {
    const n = ch.getTargetNode();
    if (n && n.getName() === 'mixamorig:Hips' && ch.getTargetPath() === 'translation') {
      const out = ch.getSampler().getOutput(); const arr = out.getArray().slice();
      const x0 = arr[0], z0 = arr[2];
      for (let i = 0; i < arr.length; i += 3) { arr[i] = x0; arr[i + 2] = z0; }
      out.setArray(arr);
    }
  }
}
for (const a of doc.getRoot().listAnimations())
  for (const ch of a.listChannels()) {
    const n = ch.getTargetNode();
    if (n && /Hand(Thumb|Index|Middle|Ring|Pinky)|_End|Eye/.test(n.getName())) { ch.getSampler().dispose(); ch.dispose(); }
  }
await doc.transform(prune({ keepLeaves: true }), dedup());
await io.write(process.argv[3], doc);
for (const a of doc.getRoot().listAnimations()) console.log(a.getName(), a.listChannels().length);
