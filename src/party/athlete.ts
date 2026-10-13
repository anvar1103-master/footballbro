import * as THREE from 'three';
import { GLTFLoader, GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { TeamInfo } from '../sim/team';
import { Bro, BRO } from './bro';

/**
 * Footballbro athletes: the Mixamo "Xbot" mannequin (realistic proportions) wearing a kit painted
 * by bind-pose height zones, plus Fall Guys-style clumsiness layered on top of the walk/run clips:
 * floppy spring-driven arms and head, squash & stretch on jumps/landings, windmilling arms when
 * airborne or off balance, ragdoll flailing when down.
 */

const HEIGHT = 1.8;
const GK_KITS = ['#2ec4b6', '#ffd60a', '#222222', '#c77dff'];
const SKIN = ['#f1c9a5', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#5c3a21', '#d9a37b'];
const HAIR = ['#1c1410', '#3b2414', '#6b4423', '#a8742f', '#e4c48a', '#111111', '#7a2e12'];

let asset: GLTF | null = null;
let bind = { minY: 0, h: 1 };

export async function loadAthlete(onProgress?: (f: number) => void) {
  const loader = new GLTFLoader();
  // single-file builds embed the GLB as base64 (artifact pages cannot fetch)
  const inline = (window as unknown as { __FB_MODELS?: Record<string, string> }).__FB_MODELS?.xbot;
  asset = inline
    ? await loader.parseAsync(Uint8Array.from(atob(inline), (c) => c.charCodeAt(0)).buffer, '')
    : await loader.loadAsync(import.meta.env.BASE_URL + 'assets/athlete/xbot.glb', (e) => e.total && onProgress?.(e.loaded / e.total));
  asset.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && /Surface/.test(m.name)) {
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      bind = { minY: bb.min.y, h: bb.max.y - bb.min.y };
    }
  });
  onProgress?.(1);
}

interface Kit {
  shirt: string;
  shorts: string;
  socks: string;
  boots: string;
  skin: string;
  gloves: string | null;
}

/** standard material whose colour comes from the bind-pose height of each vertex (shirt, shorts, socks…) */
function kitMaterial(kit: Kit, dark: number) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0 });
  const col = (c: string) => ({ value: new THREE.Color(c) });
  const u = {
    uMin: { value: bind.minY },
    uH: { value: bind.h },
    uDark: { value: dark },
    cShirt: col(kit.shirt),
    cShorts: col(kit.shorts),
    cSocks: col(kit.socks),
    cBoots: col(kit.boots),
    cSkin: col(kit.skin),
    cGloves: col(kit.gloves ?? kit.skin),
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBind;
        uniform float uMin, uH, uDark;
        uniform vec3 cShirt, cShorts, cSocks, cBoots, cSkin, cGloves;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float h = (vBind.y - uMin) / uH;
          float ax = abs(vBind.x) / uH;
          vec3 k;
          if (h < 0.055) k = cBoots;
          else if (h < 0.27) k = cSocks;
          else if (h < 0.40) k = cSkin;
          else if (h < 0.535) k = cShorts;
          else if (h < 0.815) k = ax < 0.235 ? cShirt : (ax > 0.4 ? cGloves : cSkin);
          else k = cSkin;
          diffuseColor.rgb = k * uDark;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'fb-kit';
  return mat;
}

function hairMesh(style: number, color: string) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.95 });
  const g = new THREE.Group();
  if (style === 0) return g; // shaved
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.118, 18, 10, 0, Math.PI * 2, 0, Math.PI * (style === 3 ? 0.62 : 0.5)), m);
  cap.scale.set(1, style === 2 ? 1.3 : 0.9, 1.1);
  if (style === 3) cap.scale.setScalar(1.25); // big curls
  g.add(cap);
  if (style === 4) {
    const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.12, 4, 8), m);
    tail.position.set(0, -0.05, -0.12);
    tail.rotation.x = 0.5;
    g.add(tail);
  }
  g.traverse((o) => (o.castShadow = true));
  return g;
}

/** damped spring, under-damped on purpose (the jiggle) */
class Spring {
  x = 0;
  v = 0;
  constructor(public k: number, public c: number) {}
  step(drive: number, dt: number) {
    this.v += (drive - this.k * this.x - this.c * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

const AX = new THREE.Vector3(1, 0, 0); // character's left (model faces +z)
const AZ = new THREE.Vector3(0, 0, 1); // forward
const AY = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _v = new THREE.Vector3();

export class AthleteActor {
  root = new THREE.Group();
  model: THREE.Object3D;
  stars: THREE.Group;
  private mixer: THREE.AnimationMixer;
  private acts: Record<'idle' | 'walk' | 'run', THREE.AnimationAction>;
  private bone: Record<string, THREE.Object3D> = {};
  private baseScale: number;
  private modelQ = new THREE.Quaternion();
  private lastVel = new THREE.Vector3();
  private lastVy = 0;
  private wasGrounded = true;
  private armFwd = new Spring(70, 7);
  private armOut = new Spring(60, 6);
  private headFwd = new Spring(110, 7);
  private headSide = new Spring(110, 7);
  private squash = new Spring(160, 9);
  private flail = Math.random() * 10;
  private seed = Math.random() * 10;

  constructor(public bro: Bro, info: TeamInfo, teamIndex: number, oppInfo: TeamInfo) {
    if (!asset) throw new Error('athlete model not loaded');
    this.model = SkeletonUtils.clone(asset.scene);
    const rnd = (n: number) => Math.abs(Math.sin(bro.id * 12.9898 + n * 78.233) * 43758.5453) % 1;
    const gk = bro.role === 'GK';
    const gkColor = GK_KITS.find((c) => c !== info.primary && c !== oppInfo.primary) ?? GK_KITS[teamIndex];
    const kit: Kit = {
      shirt: gk ? gkColor : info.primary,
      shorts: gk ? '#222222' : info.secondary,
      socks: gk ? gkColor : info.accent === info.secondary ? info.primary : info.accent,
      boots: ['#151515', '#f4f4f4', '#ff3d00', '#1e88e5'][Math.floor(rnd(1) * 4)],
      skin: SKIN[Math.floor(rnd(2) * SKIN.length)],
      gloves: gk ? '#f0f0f0' : null,
    };
    const surface = kitMaterial(kit, 1);
    const joints = kitMaterial(kit, 0.72);
    this.model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        m.material = /Joints/.test(m.name) ? joints : surface;
        m.castShadow = true;
        m.frustumCulled = false;
      }
      if ((o as THREE.Bone).isBone) this.bone[o.name.replace('mixamorig:', '').replace('mixamorig', '')] = o;
    });
    // size: a little variety in height
    this.baseScale = 1;
    this.model.updateMatrixWorld(true);
    const h = new THREE.Box3().setFromObject(this.model, true);
    const height = HEIGHT * (0.95 + rnd(3) * 0.08);
    this.baseScale = height / Math.max(0.1, h.max.y - h.min.y);
    this.model.scale.setScalar(this.baseScale);
    this.model.position.y = -BRO.centerY;
    this.root.add(this.model);
    this.root.updateMatrixWorld(true);
    // hair on the head bone, sized in metres
    const head = this.bone.Head;
    const top = this.bone.HeadTop_End;
    if (head) {
      const hair = hairMesh(Math.floor(rnd(4) * 5), HAIR[Math.floor(rnd(5) * HAIR.length)]);
      const ws = head.getWorldScale(new THREE.Vector3()).x;
      hair.scale.setScalar(1 / ws);
      const len = top ? top.position.length() : 0.2 / ws;
      hair.position.set(0, len * 0.5, 0);
      // tilt the cap slightly back: find "forward" in head space
      const fwd = AZ.clone().applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()).invert());
      hair.position.addScaledVector(fwd, -0.006 / ws);
      hair.quaternion.setFromUnitVectors(AY, AY.clone().applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()).invert()));
      head.add(hair);
    }

    this.mixer = new THREE.AnimationMixer(this.model);
    const clip = (n: string) => asset!.animations.find((a) => a.name === n)!;
    this.acts = { idle: this.mixer.clipAction(clip('idle')), walk: this.mixer.clipAction(clip('walk')), run: this.mixer.clipAction(clip('run')) };
    for (const a of Object.values(this.acts)) {
      a.play();
      a.setEffectiveWeight(0);
      a.time = rnd(6) * a.getClip().duration;
    }
    this.acts.idle.setEffectiveWeight(1);

    // dizzy stars
    this.stars = new THREE.Group();
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffe14d });
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), starMat);
      s.position.set(Math.cos((i / 3) * Math.PI * 2) * 0.3, 0, Math.sin((i / 3) * Math.PI * 2) * 0.3);
      this.stars.add(s);
    }
    this.stars.visible = false;
  }

  /** rotate a bone about an axis given in the character's (model) space */
  private turn(name: string, axis: THREE.Vector3, angle: number) {
    const b = this.bone[name];
    if (!b || !b.parent || Math.abs(angle) < 1e-4) return;
    b.parent.getWorldQuaternion(_qp).invert();
    _a.copy(axis).applyQuaternion(this.modelQ).applyQuaternion(_qp).normalize();
    b.quaternion.premultiply(_q.setFromAxisAngle(_a, angle));
  }

  update(dt: number, time: number) {
    const b = this.bro;
    const p = b.body.translation();
    const r = b.body.rotation();
    this.root.position.set(p.x, p.y, p.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);
    if (dt <= 0) return;

    // ---- locomotion clips, blended by speed ----
    const sp = b.speed;
    const up = b.state === 'up' || b.state === 'getup';
    const wRun = up ? THREE.MathUtils.smoothstep(sp, 2.6, 4.5) : 0;
    const wWalk = up ? THREE.MathUtils.smoothstep(sp, 0.3, 1.2) * (1 - wRun) : 0;
    const wIdle = 1 - wRun - wWalk;
    this.acts.run.setEffectiveWeight(wRun).setEffectiveTimeScale(THREE.MathUtils.clamp(sp / 5.2, 0.8, 1.6));
    this.acts.walk.setEffectiveWeight(wWalk).setEffectiveTimeScale(THREE.MathUtils.clamp(sp / 1.4, 0.7, 2));
    this.acts.idle.setEffectiveWeight(wIdle);
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
    this.model.getWorldQuaternion(this.modelQ);

    // ---- springs driven by the body's acceleration (in the character's frame) ----
    const v = b.body.linvel();
    _v.set(v.x, v.y, v.z);
    const acc = _v.clone().sub(this.lastVel).divideScalar(dt);
    this.lastVel.copy(_v);
    const inv = this.modelQ.clone().invert();
    acc.applyQuaternion(inv);
    acc.clampLength(0, 40);
    const yawRate = b.body.angvel().y;
    const armF = this.armFwd.step(-acc.z * 0.06, dt); // arms lag behind when speeding up
    const armO = this.armOut.step(Math.abs(acc.x) * 0.05 + Math.abs(yawRate) * 0.25 + Math.max(0, -acc.y) * 0.03, dt);
    const headF = this.headFwd.step(-acc.z * 0.035, dt);
    const headS = this.headSide.step(-acc.x * 0.035 + yawRate * 0.05, dt);
    // squash on landing, stretch on take-off
    const vy = v.y;
    if (b.grounded && !this.wasGrounded && this.lastVy < -1.5) this.squash.v += Math.min(4, -this.lastVy * 0.6);
    if (!b.grounded && this.wasGrounded && vy > 1.5) this.squash.v -= 2.2;
    this.wasGrounded = b.grounded;
    this.lastVy = vy;
    const sq = THREE.MathUtils.clamp(this.squash.step(0, dt), -0.18, 0.22);
    const sy = 1 - sq;
    const sxz = 1 + sq * 0.5;
    this.model.scale.set(this.baseScale * sxz, this.baseScale * sy, this.baseScale * sxz);

    const run = Math.min(1, sp / 6);
    this.flail += dt * 15;
    const f = this.flail;
    const T = (n: string, ax: THREE.Vector3, a: number) => this.turn(n, ax, a);

    if (b.state === 'down') {
      // ragdoll-ish flailing on the floor
      T('LeftArm', AZ, 1.1 + Math.sin(f) * 0.9);
      T('RightArm', AZ, -1.1 - Math.cos(f * 1.1) * 0.9);
      T('LeftArm', AX, Math.sin(f * 0.8) * 0.8);
      T('RightArm', AX, Math.cos(f * 0.9) * 0.8);
      T('LeftUpLeg', AX, Math.sin(f * 0.9) * 0.7 - 0.3);
      T('RightUpLeg', AX, Math.cos(f * 0.8) * 0.7 - 0.3);
      T('LeftLeg', AX, 0.6 + Math.sin(f * 1.2) * 0.4);
      T('RightLeg', AX, 0.6 + Math.cos(f * 1.3) * 0.4);
      T('Head', AY, Math.sin(f * 0.5) * 0.5);
    } else if (b.state === 'dive') {
      // superman: arms stretched forward, legs kicking back
      T('LeftArm', AX, -2.5 + Math.sin(f) * 0.15);
      T('RightArm', AX, -2.5 + Math.cos(f) * 0.15);
      T('LeftUpLeg', AX, 0.35 + Math.sin(f * 1.4) * 0.3);
      T('RightUpLeg', AX, 0.35 - Math.sin(f * 1.4) * 0.3);
      T('Head', AX, -0.4);
    } else if (b.state === 'getup') {
      T('LeftArm', AX, -0.9);
      T('RightArm', AX, -0.9);
      T('Spine', AX, 0.5);
    } else {
      // --- upright: clumsy layers on top of the clip ---
      const airborne = !b.grounded;
      const wobble = THREE.MathUtils.clamp((1 - b.uprightness) * 6, 0, 1); // off balance
      // floppy arms: lag + loose outward flapping, more when running
      const flap = 0.25 + 0.3 * run + armO + wobble * 1.3;
      T('LeftArm', AZ, flap + Math.sin(f * 0.7 + this.seed) * 0.12 * run);
      T('RightArm', AZ, -flap - Math.cos(f * 0.7 + this.seed) * 0.12 * run);
      T('LeftArm', AX, armF);
      T('RightArm', AX, armF);
      if (airborne) {
        // windmill arms, paddling legs
        T('LeftArm', AZ, 1.6 + Math.sin(f * 1.6) * 0.5);
        T('RightArm', AZ, -1.6 - Math.sin(f * 1.6 + 1) * 0.5);
        T('LeftUpLeg', AX, Math.sin(f * 1.2) * 0.5);
        T('RightUpLeg', AX, -Math.sin(f * 1.2) * 0.5);
      } else if (wobble > 0.05) {
        // flailing to keep balance
        T('LeftArm', AX, Math.sin(f * 1.5) * 1.2 * wobble);
        T('RightArm', AX, Math.cos(f * 1.5) * 1.2 * wobble);
      }
      if (b.kickT >= 0) {
        // big swing of the right leg: wind-up then follow-through, body leans back
        const t = Math.min(1, b.kickT / 0.4);
        const swing = t < 0.25 ? (t / 0.25) * 0.9 : 0.9 - ((t - 0.25) / 0.75) * 2.7;
        T('RightUpLeg', AX, swing * (1 - Math.max(0, t - 0.8) * 3));
        T('RightLeg', AX, t < 0.35 ? 1.1 : 0.2);
        T('Spine', AX, -0.25 * Math.sin(t * Math.PI));
        T('LeftArm', AZ, 0.8 * Math.sin(t * Math.PI));
        T('RightArm', AZ, -0.8 * Math.sin(t * Math.PI));
      } else if (b.charging) {
        T('RightUpLeg', AX, 0.7);
        T('RightLeg', AX, 1.0);
        T('LeftArm', AZ, 0.6);
        T('RightArm', AZ, -0.6);
      }
      if (b.shoveT >= 0) {
        const k = Math.sin(Math.min(1, b.shoveT / 0.3) * Math.PI);
        T('LeftArm', AX, -1.5 * k);
        T('RightArm', AX, -1.5 * k);
        T('Spine', AX, 0.3 * k);
      }
      // wobbly head: lags and bobbles
      T('Neck', AX, headF + Math.sin(f * 0.9) * 0.05 * run);
      T('Neck', AZ, headS);
      T('Spine1', AZ, -headS * 0.5);
    }

    this.stars.visible = b.dizzy > 0 && b.state !== 'up';
    if (this.stars.visible) {
      this.stars.position.set(p.x, p.y + 1.1, p.z);
      this.stars.rotation.y = time * 6;
    }
  }
}
