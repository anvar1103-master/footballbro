import * as THREE from 'three';
import { GLTFLoader, GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PLAYER } from '../sim/config';
import { CHARACTER_MODELS, TeamInfo } from '../sim/team';
import type { PlayerView } from './view';

/**
 * Kenney "Mini Characters" (CC0) with runtime kit recolouring.
 * The models use a shared 512x512 palette texture (16 columns x 4 bands of gradient swatches).
 * We find which swatches each model uses for shirt / shorts / socks by looking at the
 * skinning joint of every vertex, then paint those swatches with team colours.
 */

const SW = 32; // swatch width (px)
const SH = 128; // swatch band height (px)

interface KitMap {
  shirt: Set<string>;
  shorts: Set<string>;
  socks: Set<string>;
}

interface ModelAsset {
  gltf: GLTF;
  kit: KitMap;
  clips: Map<string, THREE.AnimationClip>;
}

const assets = new Map<string, ModelAsset>();
let paletteImage: HTMLImageElement | ImageBitmap | null = null;
const kitTextures = new Map<string, THREE.Texture>();

function swatchKey(u: number, v: number) {
  const x = Math.min(15, Math.max(0, Math.floor(u * 16)));
  const y = Math.min(3, Math.max(0, Math.floor(v * 4)));
  return `${x},${y}`;
}

function analyseKit(gltf: GLTF): KitMap {
  let body: THREE.SkinnedMesh | null = null;
  let head: THREE.SkinnedMesh | null = null;
  gltf.scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
      if (o.name.includes('head')) head = o as THREE.SkinnedMesh;
      else body = o as THREE.SkinnedMesh;
    }
  });
  const kit: KitMap = { shirt: new Set(), shorts: new Set(), socks: new Set() };
  if (!body || !head) return kit;
  const count = (mesh: THREE.SkinnedMesh) => {
    const g = mesh.geometry;
    const uv = g.getAttribute('uv');
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    const pos = g.getAttribute('position');
    const bones = mesh.skeleton.bones;
    const parts = new Map<string, Map<string, { n: number; y: number }>>();
    for (let i = 0; i < uv.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) {
          bw = w;
          best = si.getComponent(i, k);
        }
      }
      const name = bones[best]?.name ?? 'root';
      const part = name.startsWith('leg') ? 'legs' : name.startsWith('arm') ? 'arms' : name;
      const key = swatchKey(uv.getX(i), uv.getY(i));
      if (!parts.has(part)) parts.set(part, new Map());
      const m = parts.get(part)!;
      const e = m.get(key) ?? { n: 0, y: 0 };
      e.n++;
      e.y += pos.getY(i);
      m.set(key, e);
    }
    return parts;
  };
  const bp = count(body);
  const hp = count(head);
  const headSw = new Map<string, number>();
  for (const m of hp.values()) for (const [k, e] of m) headSw.set(k, (headSw.get(k) ?? 0) + e.n);
  const arms = bp.get('arms') ?? new Map();
  // skin = swatch shared by hands and the head with the most head usage
  let skin = '';
  let sc = -1;
  for (const k of arms.keys()) {
    const c = headSw.get(k) ?? 0;
    if (c > sc) {
      sc = c;
      skin = k;
    }
  }
  const torso = bp.get('torso') ?? new Map();
  for (const k of [...arms.keys(), ...torso.keys()]) if (k !== skin) kit.shirt.add(k);
  const legs = [...(bp.get('legs') ?? new Map()).entries()]
    .filter(([k]) => k !== skin && !kit.shirt.has(k))
    .map(([k, e]) => ({ k, y: e.y / e.n }))
    .sort((a, b) => b.y - a.y);
  if (legs[0]) kit.shorts.add(legs[0].k);
  if (legs.length > 2) kit.socks.add(legs[1].k);
  return kit;
}

export async function loadCharacters(onProgress?: (f: number) => void) {
  const loader = new GLTFLoader();
  const base = import.meta.env.BASE_URL + 'assets/characters/';
  let done = 0;
  await Promise.all(
    CHARACTER_MODELS.map(async (name) => {
      // single-file builds embed texture-less GLBs as base64 in window.__FB_MODELS (no fetch needed)
      const inline = (window as unknown as { __FB_MODELS?: Record<string, string> }).__FB_MODELS?.[name];
      const gltf = inline
        ? await loader.parseAsync(Uint8Array.from(atob(inline), (c) => c.charCodeAt(0)).buffer, '')
        : await loader.loadAsync(base + name + (import.meta.env.VITE_MODEL_EXT ?? '.glb'));
      if (inline) await applyInlinePalette(gltf);
      const clips = new Map<string, THREE.AnimationClip>();
      for (const c of gltf.animations) clips.set(c.name, c);
      gltf.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = false;
          (o as THREE.Mesh).frustumCulled = false;
        }
      });
      assets.set(name, { gltf, kit: analyseKit(gltf), clips });
      done++;
      onProgress?.(done / CHARACTER_MODELS.length);
    }),
  );
  // palette image for recolouring
  const anyMesh = findMesh(assets.get(CHARACTER_MODELS[0])!.gltf.scene);
  const map = (anyMesh?.material as THREE.MeshStandardMaterial).map;
  paletteImage = (map?.image as HTMLImageElement) ?? null;
}

let inlinePalette: Promise<THREE.Texture> | null = null;
/** Single-file build: palette PNG comes as a data: URI and is assigned to every material. */
function applyInlinePalette(gltf: GLTF) {
  const src = (window as unknown as { __FB_PALETTE?: string }).__FB_PALETTE!;
  inlinePalette ??= new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const t = new THREE.Texture(img);
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      res(t);
    };
    img.onerror = rej;
    img.src = src;
  });
  return inlinePalette.then((t) => {
    gltf.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m) {
        m.map = t;
        m.color.set(0xffffff);
        m.needsUpdate = true;
      }
    });
  });
}

function findMesh(root: THREE.Object3D) {
  let m: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (!m && (o as THREE.Mesh).isMesh) m = o as THREE.Mesh;
  });
  return m as THREE.Mesh | null;
}

function paintSwatches(ctx: CanvasRenderingContext2D, keys: Set<string>, color: string) {
  const c = new THREE.Color(color);
  for (const k of keys) {
    const [sx, sy] = k.split(',').map(Number);
    const img = ctx.getImageData(sx * SW, sy * SH, SW, SH);
    const d = img.data;
    // keep the original vertical shading gradient (relative luminance)
    let mean = 0;
    for (let i = 0; i < d.length; i += 4) mean += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    mean /= d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      const f = Math.max(0.6, Math.min(1.3, l / (mean || 1)));
      d[i] = Math.min(255, c.r * 255 * f);
      d[i + 1] = Math.min(255, c.g * 255 * f);
      d[i + 2] = Math.min(255, c.b * 255 * f);
    }
    ctx.putImageData(img, sx * SW, sy * SH);
  }
}

function kitTexture(model: string, shirt: string, shorts: string, socks: string) {
  const key = `${model}|${shirt}|${shorts}|${socks}`;
  const hit = kitTextures.get(key);
  if (hit) return hit;
  const a = assets.get(model)!;
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 512;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  if (paletteImage) ctx.drawImage(paletteImage as CanvasImageSource, 0, 0, 512, 512);
  paintSwatches(ctx, a.kit.shirt, shirt);
  paintSwatches(ctx, a.kit.shorts, shorts);
  paintSwatches(ctx, a.kit.socks, socks);
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  kitTextures.set(key, tex);
  return tex;
}

const GK_KITS = ['#2ec4b6', '#ffd60a', '#222222', '#c77dff'];

/** One on-pitch character: model clone + mixer + animation state. */
export class PlayerActor {
  root = new THREE.Group();
  inner = new THREE.Group();
  mixer: THREE.AnimationMixer;
  actions = new Map<string, THREE.AnimationAction>();
  current = '';
  currentAction: THREE.AnimationAction | null = null;
  lastActionT = 0;

  constructor(public view: PlayerView, info: TeamInfo, teamIndex: number, oppInfo: TeamInfo) {
    const name = CHARACTER_MODELS[view.model];
    const a = assets.get(name)!;
    const model = skeletonClone(a.gltf.scene);
    const gk = view.role === 'GK';
    const gkColor = GK_KITS.find((c) => c !== info.primary && c !== oppInfo.primary) ?? GK_KITS[teamIndex];
    const tex = kitTexture(name, gk ? gkColor : info.primary, gk ? '#222222' : info.secondary, gk ? gkColor : info.accent);
    model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isMesh) {
        const src = mesh.material as THREE.MeshStandardMaterial;
        const mat = new THREE.MeshStandardMaterial({ map: src.map, roughness: 0.75, metalness: 0 });
        if (!mesh.name.includes('head')) mat.map = tex;
        mesh.material = mat;
        mesh.castShadow = true;
      }
    });
    model.scale.setScalar(PLAYER.modelScale);
    this.inner.add(model);
    this.root.add(this.inner);
    this.mixer = new THREE.AnimationMixer(model);
    for (const [n, clip] of a.clips) this.actions.set(n, this.mixer.clipAction(clip));
    this.play('idle', 0);
  }

  play(name: string, fade = 0.15, once = false, timeScale = 1) {
    const act = this.actions.get(name);
    if (!act) return;
    if (this.current === name && !once) {
      act.timeScale = timeScale;
      return;
    }
    act.reset();
    act.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    act.clampWhenFinished = once;
    act.timeScale = timeScale;
    act.enabled = true;
    act.setEffectiveWeight(1);
    if (this.currentAction && this.currentAction !== act) act.crossFadeFrom(this.currentAction, fade, false);
    act.play();
    this.currentAction = act;
    this.current = name;
  }

  update(v: PlayerView, dt: number) {
    this.view = v;
    this.root.position.set(v.x, 0, v.z);
    this.root.rotation.y = Math.atan2(v.fx, v.fz);
    this.inner.rotation.set(0, 0, 0);
    this.inner.position.set(0, 0, 0);
    const restart = v.actionT < this.lastActionT; // a new action started
    this.lastActionT = v.actionT;
    switch (v.anim) {
      case 'idle':
        this.play('idle');
        break;
      case 'walk':
        this.play('walk', 0.2, false, Math.max(0.6, v.speed / 2.4));
        break;
      case 'run':
        this.play('sprint', 0.2, false, Math.max(0.7, v.speed / 6.5));
        break;
      case 'kick':
        if (this.current !== 'attack-kick-right' || restart) this.play('attack-kick-right', 0.06, true, 1.6);
        break;
      case 'tackle':
        if (this.current !== 'attack-kick-left' || restart) this.play('attack-kick-left', 0.06, true, 1.4);
        break;
      case 'throw':
        if (this.current !== 'holding-both-shoot' || restart) this.play('holding-both-shoot', 0.1, true, 1.0);
        break;
      case 'hold':
        this.play('holding-both', 0.15);
        break;
      case 'slide': {
        this.play('sit', 0.08, true, 2);
        const k = Math.min(1, v.actionT / 0.15);
        this.inner.rotation.x = -0.55 * k;
        this.inner.position.y = -0.35 * k;
        break;
      }
      case 'fallen':
        if (this.current !== 'die') this.play('die', 0.12, true, 1.6);
        break;
      case 'dive': {
        this.play('jump', 0.08, true, 1.2);
        const reach = Math.max(0.15, v.actionDur - 0.45);
        const k = Math.min(1, v.actionT / reach);
        const side = v.diveSide;
        // roll sideways and lift: stretched horizontal dive
        this.inner.rotation.z = -side * 1.35 * Math.sin(Math.min(1, k * 1.2) * Math.PI * 0.5);
        const lift = Math.max(0, v.diveH - 0.6) * Math.sin(Math.min(1, k) * Math.PI) + 0.3 * Math.sin(Math.min(1, k) * Math.PI);
        this.inner.position.y = lift;
        if (k >= 1) this.inner.position.y = Math.max(0, lift);
        break;
      }
      case 'header': {
        if (this.current !== 'jump' || restart) this.play('jump', 0.05, true, 1.5);
        const k = Math.min(1, v.actionT / 0.5);
        this.inner.position.y = Math.sin(k * Math.PI) * 0.45;
        break;
      }
      case 'celebrate':
        this.play(Math.floor(v.actionT / 1.6) % 2 ? 'jump' : 'emote-yes', 0.2);
        break;
      default:
        this.play('idle');
    }
    this.mixer.update(dt);
  }
}
