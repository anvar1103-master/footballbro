import * as THREE from 'three';
import type { TeamInfo } from '../sim/team';
import { Bro, BRO } from './bro';

/**
 * Fall Guys-style jelly beans built entirely in code: a glossy capsule body (exactly the physics
 * capsule) with a team pattern and number, googly eyes that follow the ball, a mouth, stubby legs,
 * floppy arms and a silly hat. Everything squashes, stretches and flails.
 */

const OUTLINE = new THREE.MeshBasicMaterial({ color: 0x1a1030, side: THREE.BackSide });
const WHITE = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
const BLACK = new THREE.MeshStandardMaterial({ color: 0x15121c, roughness: 0.3 });
const MOUTH = new THREE.MeshStandardMaterial({ color: 0x3a1020, roughness: 0.6 });
const BLUSH = new THREE.MeshBasicMaterial({ color: 0xff7a9a, transparent: true, opacity: 0.55, depthWrite: false });

const BODY_LEN = BRO.halfHeight * 2; // capsule straight part
const R = BRO.radius;
const TOP = BRO.halfHeight + R; // 0.76 above the centre

type Pattern = 'solid' | 'stripes' | 'half' | 'dots' | 'zig' | 'belly';
const PATTERNS: Pattern[] = ['solid', 'stripes', 'half', 'dots', 'zig', 'belly'];

function bodyTexture(primary: string, secondary: string, pattern: Pattern, num: number) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = primary;
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = secondary;
  // canvas x = around the body (0/512 = front, 256 = back), y = top → bottom
  if (pattern === 'stripes') for (let y = 70; y < 256; y += 46) g.fillRect(0, y, 512, 18);
  if (pattern === 'half') g.fillRect(0, 150, 512, 106);
  if (pattern === 'dots')
    for (let i = 0; i < 46; i++) {
      g.beginPath();
      g.arc((i * 97) % 512, 40 + ((i * 53) % 200), 9, 0, Math.PI * 2);
      g.fill();
    }
  if (pattern === 'zig') {
    g.beginPath();
    g.moveTo(0, 150);
    for (let x = 0; x <= 512; x += 32) g.lineTo(x, x % 64 ? 130 : 160);
    g.lineTo(512, 256);
    g.lineTo(0, 256);
    g.fill();
  }
  if (pattern === 'belly') {
    for (const x of [0, 512]) {
      g.beginPath();
      g.ellipse(x, 165, 80, 60, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  // face area: a lighter visor so the eyes pop
  g.fillStyle = 'rgba(255,255,255,0.28)';
  for (const x of [0, 512]) {
    g.beginPath();
    g.ellipse(x, 62, 92, 46, 0, 0, Math.PI * 2);
    g.fill();
  }
  // number on the back
  g.font = 'bold 74px "Lilita One", "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.strokeText(String(num), 256, 118);
  g.fillStyle = pattern === 'solid' || pattern === 'belly' ? secondary : '#ffffff';
  g.fillText(String(num), 256, 118);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function std(color: THREE.ColorRepresentation, rough = 0.5) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough });
}

/** silly hats; `crown` is reserved for the human */
function makeHat(kind: number, color: string, crown: boolean) {
  const g = new THREE.Group();
  if (crown) {
    const gold = new THREE.MeshStandardMaterial({ color: 0xffc83d, metalness: 0.7, roughness: 0.25, emissive: 0x553300, emissiveIntensity: 0.3 });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.12, 20, 1, true), gold);
    ring.material.side = THREE.DoubleSide;
    g.add(ring);
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 6), gold);
      const a = (i / 5) * Math.PI * 2;
      sp.position.set(Math.cos(a) * 0.19, 0.12, Math.sin(a) * 0.19);
      g.add(sp);
      const gem = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), std([0xff3b6b, 0x3bc8ff, 0x7dff6b][i % 3], 0.2));
      gem.position.set(Math.cos(a) * 0.215, 0, Math.sin(a) * 0.215);
      g.add(gem);
    }
    g.position.y = 0.05;
    g.rotation.z = 0.15;
    return g;
  }
  switch (kind) {
    case 0: {
      // party cone
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.4, 16), std(color, 0.6));
      cone.position.y = 0.2;
      const pom = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), std(0xffffff, 0.9));
      pom.position.y = 0.42;
      g.add(cone, pom);
      g.rotation.z = -0.25;
      break;
    }
    case 1: {
      // propeller beanie
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(color, 0.6));
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12), std(0x333333));
      stick.position.y = 0.28;
      const prop = new THREE.Group();
      prop.name = 'spin';
      prop.position.y = 0.34;
      for (const s of [-1, 1]) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.01, 0.06), std(s > 0 ? 0xff4d6d : 0x4dd2ff, 0.5));
        blade.position.x = s * 0.11;
        prop.add(blade);
      }
      g.add(cap, stick, prop);
      g.position.y = -0.04;
      break;
    }
    case 2: {
      // bunny ears
      for (const s of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.28, 4, 8), std(0xffffff, 0.8));
        ear.position.set(s * 0.1, 0.22, 0);
        ear.rotation.z = -s * 0.25;
        ear.name = 'ear';
        const inner = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.2, 4, 6), std(0xffa3c4, 0.8));
        inner.position.set(0, 0, 0.03);
        ear.add(inner);
        g.add(ear);
      }
      break;
    }
    case 3: {
      // top hat
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.03, 20), std(0x1c1c24, 0.4));
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.17, 0.3, 20), std(0x1c1c24, 0.4));
      top.position.y = 0.16;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.172, 0.172, 0.06, 20), std(color, 0.5));
      band.position.y = 0.05;
      g.add(brim, top, band);
      g.rotation.z = 0.12;
      break;
    }
    case 4: {
      // viking horns
      const helm = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(0x9aa3b5, 0.35));
      helm.material.metalness = 0.5;
      g.add(helm);
      for (const s of [-1, 1]) {
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.26, 10), std(0xfff1d6, 0.6));
        horn.position.set(s * 0.25, 0.12, 0);
        horn.rotation.z = -s * 0.9;
        g.add(horn);
      }
      g.position.y = -0.06;
      break;
    }
    case 5: {
      // flower
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.18), std(0x3fae49));
      stem.position.y = 0.09;
      const centre = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), std(0xffd23f));
      centre.position.y = 0.2;
      g.add(stem, centre);
      for (let i = 0; i < 6; i++) {
        const pet = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), std(0xff7ab8, 0.6));
        const a = (i / 6) * Math.PI * 2;
        pet.position.set(Math.cos(a) * 0.075, 0.2, Math.sin(a) * 0.075);
        pet.scale.set(1, 0.5, 1);
        g.add(pet);
      }
      break;
    }
    case 6: {
      // chef hat
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.1, 18), std(0xffffff, 0.9));
      band.position.y = 0.03;
      g.add(band);
      for (const [x, z] of [[0, 0], [0.09, 0.05], [-0.09, 0.05], [0, -0.09]]) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), std(0xffffff, 0.9));
        puff.position.set(x, 0.18, z);
        g.add(puff);
      }
      break;
    }
    default:
      // no hat: a little hair tuft
      for (let i = 0; i < 3; i++) {
        const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.16, 6), std(0x2b1d14, 0.9));
        tuft.position.set((i - 1) * 0.05, 0.05, 0);
        tuft.rotation.z = (i - 1) * 0.5;
        g.add(tuft);
      }
  }
  g.traverse((o) => (o.castShadow = true));
  return g;
}

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

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class BeanActor {
  root = new THREE.Group();
  /** squash & stretch happens here (pivot at the feet) */
  private jelly = new THREE.Group();
  private body: THREE.Mesh;
  private eyes: THREE.Object3D[] = [];
  private pupils: THREE.Object3D[] = [];
  private smile: THREE.Mesh;
  private ooh: THREE.Mesh;
  private arms: THREE.Group[] = [];
  private legs: THREE.Group[] = [];
  private hat: THREE.Group;
  stars: THREE.Group;
  private squash = new Spring(170, 9);
  private armLag = new Spring(60, 5);
  private armOut = new Spring(55, 5);
  private wasGrounded = true;
  private lastVy = 0;
  private lastVel = new THREE.Vector3();
  private blinkT = Math.random() * 4;
  private flail = Math.random() * 10;
  private walk = 0;

  constructor(public bro: Bro, info: TeamInfo, human: boolean) {
    const rnd = (n: number) => Math.abs(Math.sin(bro.id * 12.9898 + n * 78.233) * 43758.5453) % 1;
    const pattern = PATTERNS[Math.floor(rnd(1) * PATTERNS.length)];
    // patterns in the secondary colour only when it is bright; dark kits get white trims
    const sec = new THREE.Color(info.secondary);
    const pri = new THREE.Color(info.primary);
    const lum = (c: THREE.Color) => c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
    const trim = lum(pri) > 0.75 ? info.secondary : lum(sec) > 0.45 ? info.secondary : '#ffffff';
    const mat = new THREE.MeshPhysicalMaterial({
      map: bodyTexture(info.primary, trim === info.primary ? '#ffffff' : trim, pattern, bro.number),
      roughness: 0.42,
      clearcoat: 0.8,
      clearcoatRoughness: 0.25,
      sheen: 0.4,
      sheenColor: new THREE.Color(0xffffff),
    });
    // the physics capsule spans -0.76..0.76 around the body centre; the jelly pivot is at the feet
    this.jelly.position.y = -TOP;
    this.root.add(this.jelly);
    const bodyGeo = new THREE.CapsuleGeometry(R, BODY_LEN - 0.12, 10, 28);
    {
      // cylindrical projection: v linear in height (the stock UVs squeeze the straight part)
      const pos = bodyGeo.attributes.position, uv = bodyGeo.attributes.uv;
      const h = (BODY_LEN - 0.12) / 2 + R;
      for (let i = 0; i < pos.count; i++) uv.setY(i, (pos.getY(i) + h) / (2 * h));
    }
    this.body = new THREE.Mesh(bodyGeo, mat);
    this.body.position.y = TOP + 0.06;
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    const outline = new THREE.Mesh(bodyGeo, OUTLINE);
    outline.scale.setScalar(1.045);
    this.body.add(outline);
    this.jelly.add(this.body);

    // face (front = +z)
    const face = new THREE.Group();
    face.position.set(0, TOP + 0.36, 0);
    this.jelly.add(face);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.095, 18, 14), WHITE);
      eye.scale.set(0.9, 1.15, 0.55);
      eye.position.set(s * 0.12, 0.02, R - 0.02);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), BLACK);
      pupil.position.set(0, 0, 0.08);
      const shine = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 6), WHITE);
      shine.position.set(0.018, 0.022, 0.035);
      pupil.add(shine);
      eye.add(pupil);
      face.add(eye);
      this.eyes.push(eye);
      this.pupils.push(pupil);
      const blush = new THREE.Mesh(new THREE.CircleGeometry(0.045, 12), BLUSH);
      blush.position.set(s * 0.22, -0.11, R - 0.035);
      blush.rotation.y = s * 0.55;
      face.add(blush);
    }
    this.smile = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.017, 6, 14, Math.PI), MOUTH);
    this.smile.rotation.z = Math.PI;
    this.smile.position.set(0, -0.1, R + 0.0);
    this.ooh = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), MOUTH);
    this.ooh.scale.set(1, 1.3, 0.4);
    this.ooh.position.set(0, -0.12, R - 0.01);
    this.ooh.visible = false;
    face.add(this.smile, this.ooh);

    // arms: pivot at the shoulder, hanging down
    const limbMat = mat.clone();
    limbMat.map = null;
    limbMat.color = new THREE.Color(info.primary);
    const glove = std(0xffffff, 0.5);
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(s * (R - 0.02), TOP + 0.05, 0);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.2, 4, 10), limbMat);
      arm.position.y = -0.17;
      arm.castShadow = true;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), glove);
      hand.position.y = -0.32;
      hand.castShadow = true;
      pivot.add(arm, hand);
      this.jelly.add(pivot);
      this.arms.push(pivot);
    }
    // legs: stubby with big shoes
    const shoe = std(human ? 0xffc83d : 0x2a2a35, 0.45);
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.15, 0.24, 0);
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.1, 4, 8), limbMat);
      leg.position.y = -0.1;
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), shoe);
      foot.scale.set(1, 0.6, 1.5);
      foot.position.set(0, -0.2, 0.05);
      leg.castShadow = foot.castShadow = true;
      pivot.add(leg, foot);
      this.jelly.add(pivot);
      this.legs.push(pivot);
    }
    this.hat = makeHat(Math.floor(rnd(2) * 8), info.secondary === '#ffffff' ? info.primary : info.secondary, human);
    this.hat.position.y = TOP * 2 + 0.02;
    this.jelly.add(this.hat);

    this.stars = new THREE.Group();
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffe14d });
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), starMat);
      s.position.set(Math.cos((i / 4) * Math.PI * 2) * 0.32, 0, Math.sin((i / 4) * Math.PI * 2) * 0.32);
      this.stars.add(s);
    }
    this.stars.visible = false;
  }

  update(dt: number, time: number, ball: THREE.Vector3, grabTarget: THREE.Vector3 | null) {
    const b = this.bro;
    const p = b.body.translation();
    const r = b.body.rotation();
    this.root.position.set(p.x, p.y, p.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);
    if (dt <= 0) return;

    const v = b.body.linvel();
    _v.set(v.x, v.y, v.z);
    const acc = _v.clone().sub(this.lastVel).divideScalar(dt);
    this.lastVel.copy(_v);
    const inv = _q.copy(this.root.quaternion).invert();
    acc.applyQuaternion(inv).clampLength(0, 40);

    // squash on landing, stretch on take-off and when flying
    if (b.grounded && !this.wasGrounded && this.lastVy < -1.5) this.squash.v += Math.min(5, -this.lastVy * 0.7);
    if (!b.grounded && this.wasGrounded && v.y > 1.5) this.squash.v -= 3;
    this.wasGrounded = b.grounded;
    this.lastVy = v.y;
    const sq = THREE.MathUtils.clamp(this.squash.step(0, dt), -0.22, 0.3);
    const breathe = b.speed < 0.5 ? Math.sin(time * 3 + b.id) * 0.015 : 0;
    this.jelly.scale.set(1 + sq * 0.6, 1 - sq + breathe, 1 + sq * 0.6);

    const sp = b.speed;
    const run = Math.min(1, sp / 6);
    this.flail += dt * 16;
    const f = this.flail;
    const lag = this.armLag.step(-acc.z * 0.05, dt);
    const out = this.armOut.step(Math.abs(acc.x) * 0.05 + Math.max(0, -acc.y) * 0.03, dt);
    const [aL, aR] = this.arms;
    const [lL, lR] = this.legs;
    const set = (o: THREE.Object3D, x: number, z: number, k = 14) => {
      const t = Math.min(1, dt * k);
      o.rotation.x += (x - o.rotation.x) * t;
      o.rotation.z += (z - o.rotation.z) * t;
    };
    let mouthOpen = false;
    if (b.state === 'down' || b.state === 'dive') {
      mouthOpen = true;
      const dive = b.state === 'dive';
      set(aL, dive ? -2.9 : Math.sin(f) * 1.4, dive ? 0.2 : -1.2 - Math.sin(f * 1.3) * 0.6, 20);
      set(aR, dive ? -2.9 : Math.cos(f) * 1.4, dive ? -0.2 : 1.2 + Math.cos(f * 1.1) * 0.6, 20);
      set(lL, Math.sin(f * 1.2) * 0.9, 0.2, 20);
      set(lR, Math.cos(f * 1.2) * 0.9, -0.2, 20);
    } else if (!b.grounded) {
      mouthOpen = v.y < -2;
      // windmill arms, paddling legs
      set(aL, Math.sin(f * 1.4) * 1.8, -1.9, 18);
      set(aR, -Math.sin(f * 1.4) * 1.8, 1.9, 18);
      set(lL, Math.sin(f) * 0.8, 0.15);
      set(lR, -Math.sin(f) * 0.8, -0.15);
    } else {
      this.walk += sp * dt * 3.2;
      const w = this.walk;
      const legSwing = Math.sin(w) * (0.15 + 0.85 * run);
      let lr = -legSwing, ll = legSwing;
      let armL = -legSwing * 1.2 + lag, armR = legSwing * 1.2 + lag;
      let armLz = -0.25 - run * 0.35 - out, armRz = 0.25 + run * 0.35 + out;
      if (b.kickT >= 0) {
        const t = Math.min(1, b.kickT / 0.35);
        lr = t < 0.3 ? 0.9 : -1.6 * Math.sin(((t - 0.3) / 0.7) * Math.PI) - 0.2;
        armLz = -1.2;
        armRz = 1.2;
        mouthOpen = true;
      } else if (b.charging) {
        lr = 1.0;
        armLz = -0.9;
        armRz = 0.9;
      }
      if (grabTarget) {
        // both arms reach for the victim
        armL = armR = -1.5;
        armLz = -0.2;
        armRz = 0.2;
        mouthOpen = true;
      }
      if (b.celebrate) {
        armL = armR = Math.PI - 0.3 + Math.sin(time * 14) * 0.3;
        armLz = -0.4;
        armRz = 0.4;
      }
      set(lL, ll, 0.05);
      set(lR, lr, -0.05, b.kickT >= 0 ? 30 : 14);
      set(aL, armL, armLz);
      set(aR, armR, armRz);
    }
    this.smile.visible = !mouthOpen;
    this.ooh.visible = mouthOpen;

    // googly eyes follow the ball; blink now and then
    const local = ball.clone().sub(this.root.position).applyQuaternion(inv);
    const lx = THREE.MathUtils.clamp(local.x / (Math.abs(local.z) + 1.5), -1, 1);
    const ly = THREE.MathUtils.clamp((local.y - 0.7) / (Math.hypot(local.x, local.z) + 1.5), -1, 1);
    for (const pu of this.pupils) pu.position.set(lx * 0.045, ly * 0.04, 0.08);
    this.blinkT -= dt;
    if (this.blinkT < 0) this.blinkT = 2 + Math.random() * 4;
    const blink = this.blinkT < 0.12 || b.state === 'down' ? 0.12 : 1.15;
    for (const e of this.eyes) e.scale.y += (blink - e.scale.y) * Math.min(1, dt * 30);

    // hat wobbles; propellers spin
    this.hat.rotation.x = -lag * 0.4 + Math.sin(time * 9 + b.id) * 0.03 * run;
    const prop = this.hat.getObjectByName('spin');
    if (prop) prop.rotation.y += dt * (6 + sp * 5);

    this.stars.visible = b.dizzy > 0 && b.state !== 'up';
    if (this.stars.visible) {
      this.stars.position.set(p.x, p.y + 1.0, p.z);
      this.stars.rotation.y = time * 6;
    }
  }
}
