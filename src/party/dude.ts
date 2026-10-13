import * as THREE from 'three';
import type { TeamInfo } from '../sim/team';
import { Bro, BRO } from './bro';

/**
 * Cartoon footballers built in code: big head with a face (googly eyes that follow the ball,
 * eyebrows, mouth), hair styles, kit with a number, arms, legs and boots. Animated procedurally on
 * top of the wobbly physics capsule: running stride, kicks with either foot, volleys and overhead
 * kicks, slide tackles, skill moves, grabs, flailing falls and goal celebrations — with springy
 * floppy arms and a bobbling head so everything stays a bit silly.
 */

const SKIN = ['#f6d0b1', '#eab48c', '#d29b6e', '#a8714a', '#7a4b2c', '#5a3520', '#f1c27d'];
const HAIR = ['#1c1410', '#3b2414', '#6b4423', '#b07a3a', '#e9c27a', '#111111', '#a3321d', '#ffffff', '#2b6cff', '#ff4fa3'];
const BOOTS = ['#151515', '#ffffff', '#ff3d00', '#1e88e5', '#ffd23f', '#3ee07a', '#ff4fa3'];
const GK_KITS = ['#2ec4b6', '#ffd60a', '#222222', '#c77dff', '#ff8c42'];

const OUTLINE = new THREE.MeshBasicMaterial({ color: 0x17112a, side: THREE.BackSide });
const EYE_W = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
const EYE_B = new THREE.MeshStandardMaterial({ color: 0x120e18, roughness: 0.25 });
const MOUTH = new THREE.MeshStandardMaterial({ color: 0x5a1a22, roughness: 0.6 });

const mat = (c: THREE.ColorRepresentation, rough = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: rough });
function cap(r: number, len: number, m: THREE.Material, seg = 10) {
  const me = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 5, seg), m);
  me.castShadow = true;
  return me;
}
function ball(r: number, m: THREE.Material, w = 14, h = 10) {
  const me = new THREE.Mesh(new THREE.SphereGeometry(r, w, h), m);
  me.castShadow = true;
  return me;
}

function shirtTexture(primary: string, trim: string, num: number, gk: boolean) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = primary;
  g.fillRect(0, 0, 512, 256);
  // x: around the body (0/512 = front, 256 = back); y: top → bottom
  g.fillStyle = trim;
  g.fillRect(0, 0, 512, 16); // collar band
  if (!gk) {
    // side panels
    g.fillRect(118, 30, 14, 226);
    g.fillRect(380, 30, 14, 226);
  } else {
    g.globalAlpha = 0.25;
    for (let y = 24; y < 256; y += 28) g.fillRect(0, y, 512, 12);
    g.globalAlpha = 1;
  }
  // crest on the chest
  g.beginPath();
  g.arc(448, 70, 16, 0, Math.PI * 2);
  g.fill();
  // number on the back
  g.font = 'bold 120px "Lilita One", "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.strokeText(String(num), 256, 128);
  g.fillStyle = trim;
  g.fillText(String(num), 256, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** capsule whose UV v runs linearly with height (the stock UVs squeeze the straight part) */
function linearUV(geo: THREE.CapsuleGeometry, r: number, len: number) {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const h = len / 2 + r;
  for (let i = 0; i < pos.count; i++) uv.setY(i, (pos.getY(i) + h) / (2 * h));
  return geo;
}

function hair(style: number, color: string) {
  const m = mat(color, 0.85);
  const g = new THREE.Group();
  const crop = () => {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.158, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.47), m);
    c.position.set(0, 0.01, -0.01);
    c.castShadow = true;
    g.add(c);
    return c;
  };
  switch (style) {
    case 0:
      crop();
      break;
    case 1: {
      crop();
      for (let i = 0; i < 8; i++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.12, 6), m);
        const a = (i / 8) * Math.PI * 2;
        sp.position.set(Math.cos(a) * 0.08, 0.15, Math.sin(a) * 0.08 - 0.02);
        sp.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6);
        g.add(sp);
      }
      break;
    }
    case 2: {
      const af = ball(0.21, m, 16, 12);
      af.position.set(0, 0.07, -0.03);
      g.add(af);
      break;
    }
    case 3: {
      for (let i = 0; i < 6; i++) {
        const sp = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.1, 0.06), m);
        const a = -0.6 + i * 0.32;
        sp.position.set(0, Math.cos(a) * 0.16, Math.sin(a) * 0.16);
        sp.rotation.x = a;
        g.add(sp);
      }
      break;
    }
    case 4: {
      crop();
      const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.16, 4, 8), m);
      tail.position.set(0, -0.02, -0.17);
      tail.rotation.x = 0.4;
      tail.name = 'tail';
      g.add(tail);
      break;
    }
    case 5:
      break; // shaved
    case 6: {
      crop();
      const bun = ball(0.07, m);
      bun.position.set(0, 0.15, -0.08);
      g.add(bun);
      break;
    }
    default: {
      crop();
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.018, 6, 24), mat('#ffffff', 0.6));
      band.rotation.x = Math.PI / 2 - 0.15;
      band.position.y = 0.04;
      g.add(band);
    }
  }
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

type Joint = THREE.Group;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class DudeActor {
  root = new THREE.Group();
  /** flips the whole figure for slide tackles (pivot = capsule centre) */
  private flip = new THREE.Group();
  private rig = new THREE.Group();
  private pelvis: Joint;
  private spine: Joint;
  private head: Joint;
  private arm: [Joint, Joint];
  private elbow: [Joint, Joint];
  private leg: [Joint, Joint];
  private knee: [Joint, Joint];
  private pupils: THREE.Object3D[] = [];
  private eyes: THREE.Object3D[] = [];
  private brows: THREE.Object3D[] = [];
  private smile: THREE.Mesh;
  private ooh: THREE.Mesh;
  stars: THREE.Group;
  private stride = Math.random() * 6;
  private flail = Math.random() * 10;
  private armLag = new Spring(55, 5);
  private armOut = new Spring(50, 5);
  private headLag = new Spring(90, 6);
  private squash = new Spring(150, 9);
  private lastVel = new THREE.Vector3();
  private lastVy = 0;
  private wasGrounded = true;
  private blinkT = Math.random() * 4;
  private celebrateStyle: number;
  private scale: number;

  constructor(public bro: Bro, info: TeamInfo, opp: TeamInfo) {
    const rnd = (n: number) => Math.abs(Math.sin(bro.id * 12.9898 + n * 78.233) * 43758.5453) % 1;
    const gk = bro.role === 'GK';
    const gkCol = GK_KITS.find((c) => c !== info.primary && c !== opp.primary) ?? GK_KITS[0];
    const primary = gk ? gkCol : info.primary;
    const lum = (c: string) => {
      const k = new THREE.Color(c);
      return k.r * 0.3 + k.g * 0.59 + k.b * 0.11;
    };
    const trim = gk ? '#1b1b1b' : Math.abs(lum(info.secondary) - lum(primary)) > 0.25 ? info.secondary : lum(primary) > 0.5 ? '#1b1b1b' : '#ffffff';
    const shortsCol = gk ? '#1b1b1b' : trim;
    const socksCol = gk ? gkCol : info.accent && Math.abs(lum(info.accent) - lum(shortsCol)) > 0.15 ? info.accent : primary;
    const skin = SKIN[Math.floor(rnd(1) * SKIN.length)];
    const skinM = mat(skin, 0.55);
    const shirtM = mat(primary, 0.75);
    shirtM.map = shirtTexture(primary, trim, bro.number, gk);
    shirtM.color.set('#ffffff');
    const sleeveM = mat(primary, 0.75);
    const shortsM = mat(shortsCol, 0.75);
    const socksM = mat(socksCol, 0.8);
    const bootM = mat(BOOTS[Math.floor(rnd(2) * BOOTS.length)], 0.35);
    const gloveM = gk ? mat('#f2f2f2', 0.6) : skinM;
    this.scale = 0.96 + rnd(3) * 0.1;
    this.celebrateStyle = Math.floor(rnd(4) * 3);

    // root (physics capsule centre) → flip → rig (feet at y = 0)
    this.root.add(this.flip);
    this.flip.add(this.rig);
    this.rig.position.y = -BRO.centerY;
    this.rig.scale.setScalar(this.scale);

    // pelvis: everything hangs off it (so whole-body flips pivot at the hips)
    this.pelvis = new THREE.Group();
    this.pelvis.position.y = 0.93;
    this.rig.add(this.pelvis);
    const shorts = cap(0.15, 0.06, shortsM, 14);
    shorts.scale.set(1.22, 1, 0.86);
    this.pelvis.add(shorts);

    // spine + chest
    this.spine = new THREE.Group();
    this.spine.position.y = 0.05;
    this.pelvis.add(this.spine);
    const torsoGeo = linearUV(new THREE.CapsuleGeometry(0.17, 0.26, 8, 20), 0.17, 0.26);
    const torso = new THREE.Mesh(torsoGeo, shirtM);
    torso.scale.set(1.2, 1, 0.78);
    torso.position.y = 0.22;
    torso.castShadow = true;
    const tOut = new THREE.Mesh(torsoGeo, OUTLINE);
    tOut.scale.setScalar(1.05);
    torso.add(tOut);
    this.spine.add(torso);
    const neck = cap(0.055, 0.06, skinM, 8);
    neck.position.y = 0.48;
    this.spine.add(neck);

    // head
    this.head = new THREE.Group();
    this.head.position.y = 0.5;
    this.spine.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.15, 22, 16), skinM);
    skull.scale.set(0.95, 1.05, 1);
    skull.position.y = 0.14;
    skull.castShadow = true;
    const hOut = new THREE.Mesh(skull.geometry, OUTLINE);
    hOut.scale.setScalar(1.06);
    skull.add(hOut);
    this.head.add(skull);
    const face = new THREE.Group();
    face.position.y = 0.14;
    this.head.add(face);
    for (const s of [-1, 1]) {
      const eye = ball(0.036, EYE_W, 12, 10);
      eye.scale.set(1, 1.2, 0.6);
      eye.position.set(s * 0.055, 0.025, 0.133);
      const pupil = ball(0.02, EYE_B, 10, 8);
      pupil.position.set(0, 0, 0.03);
      eye.add(pupil);
      face.add(eye);
      this.eyes.push(eye);
      this.pupils.push(pupil);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.014, 0.02), mat(HAIR[Math.floor(rnd(5) * 6)], 0.8));
      brow.position.set(s * 0.056, 0.078, 0.137);
      face.add(brow);
      this.brows.push(brow);
      const ear = ball(0.032, skinM, 8, 6);
      ear.scale.set(0.6, 1, 1);
      ear.position.set(s * 0.145, 0.0, 0);
      face.add(ear);
    }
    const nose = ball(0.026, skinM, 8, 6);
    nose.position.set(0, -0.005, 0.15);
    nose.scale.set(1, 0.9, 1.2);
    face.add(nose);
    this.smile = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 12, Math.PI), MOUTH);
    this.smile.rotation.z = Math.PI;
    this.smile.position.set(0, -0.05, 0.137);
    this.ooh = ball(0.022, MOUTH, 10, 8);
    this.ooh.scale.set(1, 1.3, 0.5);
    this.ooh.position.set(0, -0.06, 0.138);
    this.ooh.visible = false;
    face.add(this.smile, this.ooh);
    if (rnd(6) < 0.2) {
      const tache = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.018, 0.02), mat(HAIR[Math.floor(rnd(5) * 6)], 0.8));
      tache.position.set(0, -0.03, 0.145);
      face.add(tache);
    }
    const hr = hair(Math.floor(rnd(7) * 8), HAIR[Math.floor(rnd(5) * HAIR.length)]);
    hr.position.y = 0.14;
    this.head.add(hr);

    // arms: shoulder → elbow → hand
    const mkArm = (s: number): [Joint, Joint] => {
      const sh = new THREE.Group();
      sh.position.set(s * 0.215, 0.39, 0);
      const sleeve = cap(0.068, gk ? 0.2 : 0.08, sleeveM, 10);
      sleeve.position.y = gk ? -0.12 : -0.07;
      const upper = cap(0.052, 0.15, gk ? sleeveM : skinM, 8);
      upper.position.y = -0.14;
      const el = new THREE.Group();
      el.position.y = -0.27;
      const fore = cap(0.047, 0.16, gk ? sleeveM : skinM, 8);
      fore.position.y = -0.11;
      const hand = ball(0.058, gloveM, 10, 8);
      hand.position.y = -0.25;
      el.add(fore, hand);
      sh.add(sleeve, upper, el);
      this.spine.add(sh);
      return [sh, el];
    };
    const [aL, eL] = mkArm(1);
    const [aR, eR] = mkArm(-1);
    this.arm = [aL, aR];
    this.elbow = [eL, eR];

    // legs: hip → knee → boot
    const mkLeg = (s: number): [Joint, Joint] => {
      const hip = new THREE.Group();
      hip.position.set(s * 0.095, -0.04, 0);
      const short = cap(0.085, 0.1, shortsM, 10);
      short.position.y = -0.07;
      const thigh = cap(0.068, 0.22, skinM, 8);
      thigh.position.y = -0.2;
      const kn = new THREE.Group();
      kn.position.y = -0.41;
      const shin = cap(0.06, 0.26, socksM, 8);
      shin.position.y = -0.2;
      const boot = cap(0.062, 0.12, bootM, 8);
      boot.rotation.x = Math.PI / 2;
      boot.position.set(0, -0.43, 0.05);
      kn.add(shin, boot);
      hip.add(short, thigh, kn);
      this.pelvis.add(hip);
      return [hip, kn];
    };
    const [lL, kL] = mkLeg(1);
    const [lR, kR] = mkLeg(-1);
    this.leg = [lL, lR];
    this.knee = [kL, kR];

    this.stars = new THREE.Group();
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffe14d });
    for (let i = 0; i < 4; i++) {
      const st = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), starMat);
      st.position.set(Math.cos((i / 4) * Math.PI * 2) * 0.3, 0, Math.sin((i / 4) * Math.PI * 2) * 0.3);
      this.stars.add(st);
    }
    this.stars.visible = false;
  }

  update(dt: number, time: number, ballPos: THREE.Vector3, grabTarget: THREE.Vector3 | null) {
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
    if (b.grounded && !this.wasGrounded && this.lastVy < -2) this.squash.v += Math.min(3, -this.lastVy * 0.4);
    this.wasGrounded = b.grounded;
    this.lastVy = v.y;
    const sq = THREE.MathUtils.clamp(this.squash.step(0, dt), -0.12, 0.15);
    this.rig.scale.set(this.scale * (1 + sq * 0.4), this.scale * (1 - sq), this.scale * (1 + sq * 0.4));

    const sp = b.speed;
    const run = Math.min(1, sp / 7);
    this.flail += dt * 15;
    const f = this.flail;
    const lag = this.armLag.step(-acc.z * 0.045, dt);
    const out = this.armOut.step(Math.abs(acc.x) * 0.045 + Math.abs(b.body.angvel().y) * 0.12, dt);
    const nod = this.headLag.step(-acc.z * 0.02, dt);

    // pose targets (radians). x: + = backwards for limbs hanging down, spine + = lean forward
    const P = {
      pelvisX: 0, pelvisY: 0, pelvisZ: 0, pelvisH: 0,
      spineX: 0.05, spineY: 0, spineZ: 0,
      headX: 0, headY: 0,
      armX: [0, 0], armZ: [0.12, -0.12], elbow: [-0.25, -0.25],
      legX: [0, 0], legZ: [0, 0], knee: [0.05, 0.05],
      flip: 0,
    };
    let mouthOpen = false;
    let browUp = 0;
    let k = 12; // smoothing speed

    const kickDur = b.kickKind === 'bicycle' ? 0.7 : 0.38;
    if (b.state === 'down') {
      mouthOpen = true;
      browUp = 1;
      k = 18;
      P.armX = [Math.sin(f) * 1.6, Math.cos(f * 1.1) * 1.6];
      P.armZ = [1.4 + Math.sin(f * 1.3) * 0.6, -1.4 - Math.cos(f * 1.2) * 0.6];
      P.elbow = [-0.8 - Math.sin(f * 2) * 0.5, -0.8 - Math.cos(f * 2) * 0.5];
      P.legX = [Math.sin(f * 1.1) * 0.9 - 0.3, Math.cos(f * 1.05) * 0.9 - 0.3];
      P.knee = [0.6 + Math.sin(f * 1.4) * 0.5, 0.6 + Math.cos(f * 1.3) * 0.5];
      P.headY = Math.sin(f * 0.4) * 0.6;
    } else if (b.state === 'dive') {
      mouthOpen = true;
      browUp = 1;
      k = 20;
      if (b.role === 'GK') {
        // keeper's dive: stretched out, gloves first
        P.armX = [-2.9, -2.9];
        P.armZ = [0.25, -0.25];
        P.elbow = [0, 0];
        P.legX = [0.3, 0.1];
        P.knee = [0.3, 0.6];
      } else {
        // slide tackle: feet first, one leg out, leaning back on an arm
        P.flip = Math.PI;
        P.legX = [-0.2, -1.1];
        P.knee = [1.3, 0.1];
        P.armX = [0.8, -0.6];
        P.armZ = [0.9, -1.2];
        P.spineX = -0.3;
      }
    } else if (b.state === 'getup') {
      P.armX = [-1.2, -1.2];
      P.elbow = [-0.6, -0.6];
      P.spineX = 0.5;
      P.knee = [1.0, 1.0];
      P.legX = [-0.8, -0.8];
    } else if (b.kickT >= 0 && b.kickKind === 'bicycle') {
      // overhead kick: flip backwards around the hips, scissor the legs
      const t = Math.min(1, b.kickT / kickDur);
      mouthOpen = true;
      browUp = 1;
      k = 22;
      P.pelvisX = -Math.min(1, t / 0.45) * 2.4;
      const kick = b.kickSide > 0 ? 0 : 1;
      P.legX[kick] = t < 0.35 ? 0.4 : -2.2;
      P.legX[1 - kick] = t < 0.35 ? -1.6 : 0.3;
      P.knee = [0.2, 0.2];
      P.armX = [0.4, 0.4];
      P.armZ = [1.6, -1.6];
    } else if (!b.grounded) {
      // airborne: windmill arms, legs tucked (or a header)
      mouthOpen = v.y < -2;
      browUp = 1;
      P.armX = [Math.sin(f * 1.3) * 1.6, -Math.sin(f * 1.3) * 1.6];
      P.armZ = [1.7, -1.7];
      P.elbow = [-0.4, -0.4];
      P.legX = [-0.6 + Math.sin(f) * 0.3, 0.2 - Math.sin(f) * 0.3];
      P.knee = [1.2, 0.6];
      if (b.kickT >= 0 && b.kickKind === 'header') P.headX = 0.6 * Math.sin(Math.min(1, b.kickT / 0.25) * Math.PI);
    } else {
      // --- on the feet: run cycle ---
      this.stride += sp * dt * (Math.PI / (0.85 + 0.45 * run));
      const s = this.stride;
      const amp = 0.18 + 0.75 * run;
      const sw = Math.sin(s) * amp;
      P.legX = [-sw, sw];
      P.knee = [0.12 + run * 1.35 * Math.max(0, Math.cos(s)), 0.12 + run * 1.35 * Math.max(0, -Math.cos(s))];
      P.pelvisH = -0.03 * run + Math.abs(Math.cos(s)) * 0.05 * run;
      P.pelvisY = sw * 0.25;
      P.spineX = 0.06 + 0.28 * run + lag * 0.3;
      P.spineY = -sw * 0.45;
      P.armX = [sw * 1.2 + lag, -sw * 1.2 + lag];
      P.armZ = [0.12 + run * 0.25 + out, -0.12 - run * 0.25 - out];
      P.elbow = [-0.35 - run * 1.0, -0.35 - run * 1.0];
      if (sp < 0.4) {
        // idle: weight shift and breathing
        P.pelvisZ = Math.sin(time * 1.3 + b.id) * 0.04;
        P.spineX = 0.03 + Math.sin(time * 2.2 + b.id) * 0.02;
        P.armZ = [0.18, -0.18];
      }
      if (b.kickT >= 0) {
        const t = Math.min(1, b.kickT / kickDur);
        const kick = b.kickSide > 0 ? 0 : 1;
        const other = 1 - kick;
        const big = b.kickKind === 'shot' || b.kickKind === 'volley' ? 1 : b.kickKind === 'lob' ? 0.85 : 0.6;
        // wind-up → strike → follow-through
        const wind = t < 0.3 ? t / 0.3 : 0;
        const strike = t >= 0.3 ? Math.sin(Math.min(1, (t - 0.3) / 0.7) * Math.PI) : 0;
        P.legX[kick] = wind * 0.9 * big - strike * 1.6 * big;
        P.knee[kick] = wind * 1.5 + (t > 0.3 ? 0.15 : 0);
        if (b.kickKind === 'pass') P.legZ[kick] = (kick === 0 ? -1 : 1) * 0.5 * strike; // inside of the foot
        if (b.kickKind === 'volley') P.legZ[kick] = (kick === 0 ? 1 : -1) * 0.8;
        P.legX[other] = 0.15;
        P.knee[other] = 0.35;
        P.spineX = -0.2 * strike * big;
        P.armZ = [0.9 * big, -0.9 * big];
        P.armX[other] = -0.7 * strike;
        mouthOpen = big > 0.9 && strike > 0.3;
        k = 26;
      } else if (b.charging) {
        const kick = 1;
        P.legX[kick] = 0.8;
        P.knee[kick] = 1.4;
        P.armZ = [0.7, -0.7];
        P.spineX = -0.05;
        browUp = -1;
      }
      if (b.skill) {
        const t = Math.min(1, b.skill.t / 0.5);
        k = 26;
        if (b.skill.kind === 'rainbow') {
          // heel flick: kicking leg goes back and up
          P.legX[1] = t < 0.5 ? 1.3 * Math.sin(t * Math.PI * 2) : 0;
          P.knee[1] = 2.0 * Math.sin(Math.min(1, t * 2) * Math.PI);
          P.spineX = 0.4;
          P.armZ = [1.1, -1.1];
        } else if (b.skill.kind === 'cut') {
          // step-over then cut away
          const leg = b.skill.side > 0 ? 1 : 0;
          P.legX[leg] = -0.7 * Math.sin(t * Math.PI);
          P.legZ[leg] = (leg === 0 ? -1 : 1) * 0.8 * Math.sin(t * Math.PI);
          P.spineZ = b.skill.side * 0.35 * Math.sin(t * Math.PI);
          P.spineY = b.skill.side * 0.4;
          P.armZ = [1.0, -1.0];
        } else {
          // drag-back
          P.legX[1] = -0.6 * Math.sin(t * Math.PI);
          P.spineX = -0.25;
          P.spineY = 0.6 * Math.sin(t * Math.PI);
        }
      }
      if (grabTarget) {
        // pulling a shirt: arms out front, leaning back
        P.armX = [-1.45, -1.45];
        P.armZ = [-0.1, 0.1];
        P.elbow = [-0.15, -0.15];
        P.spineX = -0.25;
        mouthOpen = true;
        browUp = -1;
      }
      if (b.fooled > 0) {
        // ankles broken: legs crossed, arms everywhere
        P.legZ = [-0.35, 0.35];
        P.armX = [Math.sin(f * 1.6) * 1.5, -Math.sin(f * 1.6) * 1.5];
        P.armZ = [1.4, -1.4];
        mouthOpen = true;
        browUp = 1;
      }
      // off balance on the wobbly body: windmill
      const wob = THREE.MathUtils.clamp((1 - b.uprightness) * 7, 0, 1);
      if (wob > 0.1) {
        P.armZ = [P.armZ[0] + wob * 1.2, P.armZ[1] - wob * 1.2];
        P.armX = [P.armX[0] + Math.sin(f * 1.5) * wob, P.armX[1] - Math.sin(f * 1.5) * wob];
      }
      if (b.celebrate) {
        k = 10;
        if (this.celebrateStyle === 0) {
          // aeroplane
          P.armZ = [1.5, -1.5];
          P.armX = [0, 0];
          P.elbow = [0, 0];
          P.spineZ = Math.sin(time * 3) * 0.35;
        } else if (this.celebrateStyle === 1) {
          // fist pumps
          P.armX = [-2.8 + Math.sin(time * 9) * 0.3, -0.3];
          P.elbow = [-0.6, -1.2];
          mouthOpen = true;
        } else {
          // silly dance
          P.pelvisZ = Math.sin(time * 8) * 0.15;
          P.armX = [-2.4 + Math.sin(time * 8) * 0.6, -2.4 - Math.sin(time * 8) * 0.6];
          P.armZ = [0.5, -0.5];
          P.headY = Math.sin(time * 4) * 0.4;
        }
        browUp = 1;
      }
    }

    // look at the ball
    const local = ballPos.clone().sub(this.root.position).applyQuaternion(inv);
    const yaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -1.1, 1.1);
    const pitch = THREE.MathUtils.clamp(-Math.atan2(local.y - 0.8, Math.hypot(local.x, local.z) + 0.5), -0.6, 0.5);
    if (b.state === 'up') {
      P.headY += yaw * 0.7;
      P.headX += pitch * 0.6 + nod;
    }

    // ---- apply with smoothing ----
    const a = Math.min(1, dt * k);
    const L = (o: THREE.Object3D, key: 'x' | 'y' | 'z', val: number) => (o.rotation[key] += (val - o.rotation[key]) * a);
    L(this.flip, 'x', P.flip);
    this.flip.position.y = Math.sin(this.flip.rotation.x) * 0; // pivot already at the capsule centre
    L(this.pelvis, 'x', P.pelvisX);
    L(this.pelvis, 'y', P.pelvisY);
    L(this.pelvis, 'z', P.pelvisZ);
    this.pelvis.position.y += (0.93 + P.pelvisH - this.pelvis.position.y) * a;
    L(this.spine, 'x', P.spineX);
    L(this.spine, 'y', P.spineY);
    L(this.spine, 'z', P.spineZ);
    L(this.head, 'x', P.headX);
    L(this.head, 'y', P.headY);
    for (let i = 0; i < 2; i++) {
      L(this.arm[i], 'x', P.armX[i]);
      L(this.arm[i], 'z', P.armZ[i]);
      L(this.elbow[i], 'x', P.elbow[i]);
      L(this.leg[i], 'x', P.legX[i]);
      L(this.leg[i], 'z', P.legZ[i]);
      L(this.knee[i], 'x', P.knee[i]);
    }

    // face
    const lx = THREE.MathUtils.clamp(local.x / (Math.abs(local.z) + 1.5), -1, 1);
    const ly = THREE.MathUtils.clamp((local.y - 0.9) / (Math.hypot(local.x, local.z) + 1.5), -1, 1);
    for (const pu of this.pupils) pu.position.set(lx * 0.016, ly * 0.014, 0.03);
    this.blinkT -= dt;
    if (this.blinkT < 0) this.blinkT = 2 + Math.random() * 4;
    const blink = this.blinkT < 0.1 || b.state === 'down' ? 0.15 : 1.2;
    for (const e of this.eyes) e.scale.y += (blink - e.scale.y) * Math.min(1, dt * 30);
    this.brows.forEach((br, i) => {
      const s = i === 0 ? 1 : -1;
      br.position.y = 0.078 + browUp * 0.015;
      br.rotation.z = browUp < 0 ? s * -0.35 : browUp > 0 ? s * 0.15 : 0;
    });
    this.smile.visible = !mouthOpen;
    this.ooh.visible = mouthOpen;

    this.stars.visible = b.dizzy > 0 && b.state !== 'up';
    if (this.stars.visible) {
      this.stars.position.set(p.x, p.y + 1.1, p.z);
      this.stars.rotation.y = time * 6;
    }
  }
}

/** the crown floats over whichever player you control */
export function makeCrown() {
  const g = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: 0xffc83d, metalness: 0.7, roughness: 0.25, emissive: 0x553300, emissiveIntensity: 0.35 });
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.1, 20, 1, true), gold);
  ring.material.side = THREE.DoubleSide;
  g.add(ring);
  for (let i = 0; i < 5; i++) {
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.13, 6), gold);
    const a = (i / 5) * Math.PI * 2;
    sp.position.set(Math.cos(a) * 0.165, 0.11, Math.sin(a) * 0.165);
    g.add(sp);
    const gem = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshStandardMaterial({ color: [0xff3b6b, 0x3bc8ff, 0x7dff6b][i % 3], roughness: 0.2 }));
    gem.position.set(Math.cos(a) * 0.188, 0, Math.sin(a) * 0.188);
    g.add(gem);
  }
  return g;
}
