import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TeamInfo } from '../sim/team';
import { Bro, BRO } from './bro';

/**
 * Crash-test-dummy footballers built in code: glossy plastic body with ball joints and the
 * black-and-yellow target stickers, a face (eyes that follow the ball, brows, mouth), a team kit
 * with a number, tapered arms and legs, mitten hands and studded boots. Animated procedurally on
 * top of the wobbly physics capsule: running stride, kicks with either foot, volleys and overhead
 * kicks, slide tackles, skill moves, grabs, flailing falls and goal celebrations — with springy
 * floppy arms and a bobbling head so everything stays a bit silly.
 */

/** crash-test dummy plastics: mostly the classic yellow, some white / orange / blue-grey */
const DUMMY = ['#f2c12e', '#f2c12e', '#f2c12e', '#f4b324', '#efefe8', '#ff9b30', '#a9bcd0'];
const BOOTS = ['#151515', '#ffffff', '#ff3d00', '#1e88e5', '#ffd23f', '#3ee07a', '#ff4fa3'];
const GK_KITS = ['#2ec4b6', '#ffd60a', '#222222', '#c77dff', '#ff8c42'];
const BOOT_STRIPE = ['#ffffff', '#ffd23f', '#ff3d00', '#3bc8ff', '#111111'];

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
/** smooth revolved limb / body part from a (radius, y) profile */
function lathe(profile: [number, number][], seg = 16) {
  // bottom → top so the faces point outwards
  const pts = [...profile].sort((a, b) => a[1] - b[1]).map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, seg);
}

let targetTex: THREE.CanvasTexture | null = null;
/** the black-and-yellow quartered circle sticker of crash-test dummies */
function targetMaterial() {
  if (!targetTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i % 2 ? '#111111' : '#ffd21f';
      g.beginPath();
      g.moveTo(32, 32);
      g.arc(32, 32, 31, (i * Math.PI) / 2, ((i + 1) * Math.PI) / 2);
      g.fill();
    }
    g.strokeStyle = '#111111';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(32, 32, 30, 0, Math.PI * 2);
    g.stroke();
    targetTex = new THREE.CanvasTexture(c);
    targetTex.colorSpace = THREE.SRGBColorSpace;
  }
  return new THREE.MeshStandardMaterial({ map: targetTex, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 });
}

/** several primitives baked into one geometry (fewer draw calls for small details) */
function merged(parts: [THREE.BufferGeometry, THREE.Matrix4][]) {
  const gs = parts.map(([g, m]) => {
    const c = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
    for (const k of Object.keys(c.attributes)) if (!['position', 'normal', 'uv'].includes(k)) c.deleteAttribute(k);
    return c;
  });
  return mergeGeometries(gs)!;
}
const M = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

function ball(r: number, m: THREE.Material, w = 14, h = 10) {
  const me = new THREE.Mesh(new THREE.SphereGeometry(r, w, h), m);
  me.castShadow = true;
  return me;
}

function shirtTexture(primary: string, trim: string, num: number, gk: boolean, name: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = primary;
  g.fillRect(0, 0, 512, 256);
  // fabric: soft vertical folds and a fine mesh
  for (let x = 0; x < 512; x += 2) {
    const k = Math.sin(x * 0.09) * 0.5 + Math.sin(x * 0.031 + 1) * 0.5;
    g.fillStyle = k > 0 ? `rgba(255,255,255,${k * 0.05})` : `rgba(0,0,0,${-k * 0.07})`;
    g.fillRect(x, 0, 2, 256);
  }
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let y = 0; y < 256; y += 4) for (let x = (y / 4) % 2 ? 0 : 2; x < 512; x += 4) g.fillRect(x, y, 1, 1);
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
  // V-neck at the front (u = 0 / 512 wraps)
  for (const x0 of [0, 512]) {
    g.beginPath();
    g.moveTo(x0 - 34, 0);
    g.lineTo(x0, 40);
    g.lineTo(x0 + 34, 0);
    g.closePath();
    g.fill();
  }
  // crest on the chest, small number on the other side
  g.beginPath();
  g.arc(448, 70, 16, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = primary;
  g.beginPath();
  g.arc(448, 70, 9, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = trim;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 34px "Lilita One", "Arial Black", sans-serif';
  g.fillText(String(num), 64, 72);
  // name and number on the back
  g.font = 'bold 26px "Russo One", "Arial Black", sans-serif';
  g.fillText(name.toUpperCase(), 256, 44, 150);
  g.font = 'bold 120px "Lilita One", "Arial Black", sans-serif';
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.strokeText(String(num), 256, 138);
  g.fillText(String(num), 256, 138);
  // sponsor
  g.font = 'bold 22px "Russo One", "Arial Black", sans-serif';
  g.globalAlpha = 0.9;
  g.fillText('КРАШ', 0, 132, 90);
  g.fillText('КРАШ', 512, 132, 90);
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
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
    // crash-test dummy plastic (mostly the classic yellow)
    const plastic = DUMMY[Math.floor(rnd(1) * DUMMY.length)];
    const skinM = new THREE.MeshPhysicalMaterial({ color: plastic, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.3 });
    const jointM = new THREE.MeshStandardMaterial({ color: '#2b2f38', roughness: 0.45, metalness: 0.5 });
    const shirtM = mat(primary, 0.75);
    shirtM.map = shirtTexture(primary, trim, bro.number, gk, bro.name);
    const trimM = mat(trim, 0.7);
    const boltM = new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.3, metalness: 0.8 });
    shirtM.color.set('#ffffff');
    const sleeveM = mat(primary, 0.75);
    const shortsM = mat(shortsCol, 0.75);
    const socksM = mat(socksCol, 0.8);
    const bootM = mat(BOOTS[Math.floor(rnd(2) * BOOTS.length)], 0.35);
    const studM = mat('#e8e8e8', 0.4);
    const gloveM = gk ? mat('#f2f2f2', 0.6) : skinM;
    const target = targetMaterial();
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
    const shorts = new THREE.Mesh(lathe([[0.1, -0.13], [0.15, -0.1], [0.165, 0], [0.155, 0.08], [0.14, 0.11]]), shortsM);
    shorts.scale.set(1.15, 1, 0.82);
    shorts.castShadow = true;
    this.pelvis.add(shorts);

    // spine + chest: a shaped torso (wide shoulders, narrower waist)
    this.spine = new THREE.Group();
    this.spine.position.y = 0.05;
    this.pelvis.add(this.spine);
    const torsoGeo = lathe([[0.0, -0.02], [0.14, 0.0], [0.15, 0.08], [0.165, 0.2], [0.185, 0.32], [0.18, 0.39], [0.14, 0.43], [0.06, 0.46], [0.0, 0.465]], 24);
    {
      // u around, v linear in height for the number texture
      const pos = torsoGeo.attributes.position, uv = torsoGeo.attributes.uv;
      for (let i = 0; i < pos.count; i++) uv.setY(i, (pos.getY(i) + 0.02) / 0.485);
    }
    const torso = new THREE.Mesh(torsoGeo, shirtM);
    torso.scale.set(1.18, 1, 0.74);
    torso.castShadow = true;
    const tOut = new THREE.Mesh(torsoGeo, OUTLINE);
    tOut.scale.setScalar(1.045);
    torso.add(tOut);
    this.spine.add(torso);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.068, 0.014, 6, 24), trimM);
    collar.rotation.x = Math.PI / 2;
    collar.scale.set(1.15, 0.85, 1);
    collar.position.set(0, 0.445, -0.005);
    this.spine.add(collar);
    // segmented dummy neck
    for (let i = 0; i < 2; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.05 - i * 0.004, 0.055 - i * 0.004, 0.035, 14), i ? skinM : jointM);
      seg.position.y = 0.47 + i * 0.035;
      this.spine.add(seg);
    }

    // head: smooth egg with crash-test target stickers
    this.head = new THREE.Group();
    this.head.position.y = 0.5;
    this.spine.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.14, 28, 20), skinM);
    skull.scale.set(0.9, 1.12, 0.98);
    skull.position.y = 0.15;
    skull.castShadow = true;
    const hOut = new THREE.Mesh(skull.geometry, OUTLINE);
    hOut.scale.setScalar(1.055);
    skull.add(hOut);
    this.head.add(skull);
    for (const s of [-1, 1]) {
      const st = new THREE.Mesh(new THREE.CircleGeometry(0.045, 24), target);
      st.position.set(s * 0.127, 0.16, -0.005);
      st.rotation.y = s * Math.PI / 2;
      this.head.add(st);
    }
    const crown = new THREE.Mesh(new THREE.CircleGeometry(0.04, 24), target);
    crown.position.set(0, 0.305, -0.01);
    crown.rotation.x = -Math.PI / 2;
    this.head.add(crown);
    // a centre seam over the head like the real dummies
    const seam = new THREE.Mesh(new THREE.TorusGeometry(0.142, 0.004, 4, 40, Math.PI), jointM);
    seam.rotation.y = Math.PI / 2;
    seam.scale.set(1, 1.12, 0.98);
    seam.position.y = 0.15;
    this.head.add(seam);
    // a separate chin like the real dummies, with the seam around it
    const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.085, 18, 12), skinM);
    jaw.scale.set(0.95, 0.62, 0.92);
    jaw.position.set(0, 0.065, 0.032);
    jaw.castShadow = true;
    const jawSeam = new THREE.Mesh(new THREE.TorusGeometry(0.083, 0.0035, 4, 28, Math.PI), jointM);
    jawSeam.scale.set(0.97, 1, 0.92);
    jawSeam.rotation.set(Math.PI / 2 + 0.25, 0, 0);
    jawSeam.position.set(0, 0.08, 0.035);
    this.head.add(jaw, jawSeam);
    const face = new THREE.Group();
    face.position.y = 0.15;
    this.head.add(face);
    for (const s of [-1, 1]) {
      const eye = ball(0.036, EYE_W, 12, 10);
      eye.scale.set(1, 1.15, 0.45);
      eye.position.set(s * 0.05, 0.02, 0.122);
      const pupil = ball(0.019, EYE_B, 10, 8);
      pupil.position.set(0, 0, 0.032);
      eye.add(pupil);
      face.add(eye);
      this.eyes.push(eye);
      this.pupils.push(pupil);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.016), jointM);
      brow.position.set(s * 0.05, 0.075, 0.125);
      face.add(brow);
      this.brows.push(brow);
    }
    const nose = ball(0.02, skinM, 8, 6);
    nose.position.set(0, -0.012, 0.135);
    nose.scale.set(1, 1.1, 1);
    face.add(nose);
    this.smile = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.007, 6, 12, Math.PI), MOUTH);
    this.smile.rotation.z = Math.PI;
    this.smile.position.set(0, -0.055, 0.124);
    this.ooh = ball(0.02, MOUTH, 10, 8);
    this.ooh.scale.set(1, 1.3, 0.5);
    this.ooh.position.set(0, -0.065, 0.126);
    this.ooh.visible = false;
    face.add(this.smile, this.ooh);

    // arms: shoulder ball-joint → tapered upper arm → elbow joint → forearm → mitten hand
    const mkArm = (s: number): [Joint, Joint] => {
      const sh = new THREE.Group();
      sh.position.set(s * 0.215, 0.37, 0);
      const ball1 = ball(0.07, sleeveM, 14, 10);
      const sleeve = new THREE.Mesh(lathe([[0.072, 0], [0.068, -0.06], [0.064, gk ? -0.24 : -0.11], [0.0, gk ? -0.245 : -0.115]]), sleeveM);
      sleeve.castShadow = true;
      const upper = new THREE.Mesh(lathe([[0.056, -0.02], [0.052, -0.12], [0.045, -0.23], [0.0, -0.235]]), gk ? sleeveM : skinM);
      upper.castShadow = true;
      const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.063, 0.011, 6, 18), trimM);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.y = gk ? -0.235 : -0.105;
      sh.add(cuff);
      const el = new THREE.Group();
      el.position.y = -0.26;
      const elbowJ = new THREE.Mesh(
        merged([
          [new THREE.SphereGeometry(0.05, 12, 8), M(0, 0, 0)],
          [new THREE.CylinderGeometry(0.016, 0.016, 0.11, 6), M(0, 0, 0, 0, 0, Math.PI / 2)],
        ]),
        jointM,
      );
      const bolts = new THREE.Mesh(
        merged([
          [new THREE.CylinderGeometry(0.014, 0.014, 0.006, 6), M(0.056, 0, 0, 0, 0, Math.PI / 2)],
          [new THREE.CylinderGeometry(0.014, 0.014, 0.006, 6), M(-0.056, 0, 0, 0, 0, Math.PI / 2)],
        ]),
        boltM,
      );
      el.add(bolts);
      const fore = new THREE.Mesh(lathe([[0.046, 0], [0.044, -0.08], [0.036, -0.19], [0.0, -0.195]]), gk ? sleeveM : skinM);
      fore.castShadow = true;
      const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.025, 10), jointM);
      wrist.position.y = -0.2;
      const hand = ball(0.055, gloveM, 12, 10);
      hand.scale.set(0.8, 1.15, 0.65);
      hand.position.y = -0.255;
      const thumb = cap(0.018, 0.035, gloveM, 6);
      thumb.position.set(-s * 0.0, -0.24, 0.04);
      thumb.rotation.x = 0.6;
      el.add(elbowJ, fore, wrist, hand, thumb);
      sh.add(ball1, sleeve, upper, el);
      this.spine.add(sh);
      return [sh, el];
    };
    const [aL, eL] = mkArm(1);
    const [aR, eR] = mkArm(-1);
    this.arm = [aL, aR];
    this.elbow = [eL, eR];

    // legs: hip → tapered thigh → knee joint with a target sticker → sock → boot with studs
    const mkLeg = (s: number): [Joint, Joint] => {
      const hip = new THREE.Group();
      hip.position.set(s * 0.095, -0.04, 0);
      const short = new THREE.Mesh(lathe([[0.09, 0.02], [0.092, -0.06], [0.088, -0.15], [0.0, -0.155]]), shortsM);
      short.castShadow = true;
      // side stripe on the shorts, hem
      const stripeCol = gk ? '#ffffff' : socksCol === shortsCol ? primary : socksCol;
      const stripe = new THREE.Mesh(
        merged([
          [new THREE.BoxGeometry(0.012, 0.16, 0.03), M(s * 0.088, -0.065, 0)],
          [new THREE.TorusGeometry(0.088, 0.007, 4, 18), M(0, -0.148, 0, Math.PI / 2)],
        ]),
        mat(stripeCol, 0.7),
      );
      const thigh = new THREE.Mesh(lathe([[0.078, -0.05], [0.074, -0.18], [0.06, -0.37], [0.0, -0.375]]), skinM);
      thigh.castShadow = true;
      const kn = new THREE.Group();
      kn.position.y = -0.41;
      const kneeJ = new THREE.Mesh(
        merged([
          [new THREE.SphereGeometry(0.062, 12, 8), M(0, 0, 0)],
          [new THREE.CylinderGeometry(0.02, 0.02, 0.14, 6), M(0, 0, 0, 0, 0, Math.PI / 2)],
        ]),
        jointM,
      );
      const kneeBolts = new THREE.Mesh(
        merged([
          [new THREE.CylinderGeometry(0.017, 0.017, 0.006, 6), M(0.071, 0, 0, 0, 0, Math.PI / 2)],
          [new THREE.CylinderGeometry(0.017, 0.017, 0.006, 6), M(-0.071, 0, 0, 0, 0, Math.PI / 2)],
        ]),
        boltM,
      );
      const kneeT = new THREE.Mesh(new THREE.CircleGeometry(0.032, 20), target);
      kneeT.position.set(0, 0.0, 0.063);
      // sock with a shin guard bulge, band at the top
      const shin = new THREE.Mesh(
        merged([
          [lathe([[0.06, -0.03], [0.062, -0.12], [0.048, -0.32], [0.045, -0.37], [0.0, -0.375]]), M(0, 0, 0)],
          [new THREE.SphereGeometry(0.05, 12, 10), M(0, -0.17, 0.028, 0, 0, 0, 0.95, 2.3, 0.55)],
        ]),
        socksM,
      );
      shin.castShadow = true;
      const band = new THREE.Mesh(
        merged([
          [new THREE.CylinderGeometry(0.0645, 0.0635, 0.022, 16, 1, true), M(0, -0.06, 0)],
          [new THREE.CylinderGeometry(0.061, 0.06, 0.012, 16, 1, true), M(0, -0.09, 0)],
        ]),
        trimM,
      );
      // boot: rounded body with a toe cap, a shaped sole with studs, a contrasting side stripe
      const boot = new THREE.Mesh(
        merged([
          [new THREE.SphereGeometry(0.075, 16, 10), M(0, -0.412, 0.04, 0, 0, 0, 0.82, 0.62, 1.55)],
          [new THREE.SphereGeometry(0.052, 12, 8), M(0, -0.418, 0.125, 0, 0, 0, 1.08, 0.78, 0.95)],
          [new THREE.CylinderGeometry(0.052, 0.056, 0.07, 12), M(0, -0.385, -0.03)],
        ]),
        bootM,
      );
      boot.castShadow = true;
      const studParts: [THREE.BufferGeometry, THREE.Matrix4][] = [[new THREE.CylinderGeometry(0.055, 0.055, 0.016, 16), M(0, -0.452, 0.045, 0, 0, 0, 1, 1, 2.05)]];
      for (const [x, z] of [[-0.03, -0.04], [0.03, -0.04], [-0.032, 0.07], [0.032, 0.07], [-0.024, 0.13], [0.024, 0.13]]) studParts.push([new THREE.CylinderGeometry(0.009, 0.006, 0.016, 6), M(x, -0.466, z + 0.02)]);
      const sole = new THREE.Mesh(merged(studParts), studM);
      const bootStripe = new THREE.Mesh(
        merged([
          [new THREE.BoxGeometry(0.006, 0.016, 0.11), M(0.061, -0.405, 0.04, 0.35, 0, 0)],
          [new THREE.BoxGeometry(0.006, 0.016, 0.11), M(-0.061, -0.405, 0.04, 0.35, 0, 0)],
          [new THREE.BoxGeometry(0.045, 0.008, 0.075), M(0, -0.372, 0.085, -0.38, 0, 0)],
        ]),
        mat(BOOT_STRIPE[Math.floor(rnd(5) * BOOT_STRIPE.length)], 0.4),
      );
      kn.add(kneeJ, kneeBolts, kneeT, shin, band, boot, sole, bootStripe);
      hip.add(short, stripe, thigh, kn);
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

  /** the whole visible pose (body transform, joints, face) for instant replays: POSE_N numbers */
  capture(out: number[]) {
    const r = this.root;
    out.push(r.position.x, r.position.y, r.position.z, r.quaternion.x, r.quaternion.y, r.quaternion.z, r.quaternion.w);
    out.push(this.flip.rotation.x, this.rig.scale.x, this.rig.scale.y, this.rig.scale.z);
    out.push(this.pelvis.rotation.x, this.pelvis.rotation.y, this.pelvis.rotation.z, this.pelvis.position.y);
    out.push(this.spine.rotation.x, this.spine.rotation.y, this.spine.rotation.z, this.head.rotation.x, this.head.rotation.y);
    for (let i = 0; i < 2; i++) out.push(this.arm[i].rotation.x, this.arm[i].rotation.z, this.elbow[i].rotation.x, this.leg[i].rotation.x, this.leg[i].rotation.z, this.knee[i].rotation.x);
    out.push(this.ooh.visible ? 1 : 0, this.eyes[0].scale.y, this.stars.visible ? 1 : 0);
  }

  /** show a recorded pose: frame `a` blended towards frame `b` by `k` (both at offset `o`) */
  applyPose(a: Float32Array, b: Float32Array, o: number, k: number, time: number) {
    const L = (i: number) => a[o + i] + (b[o + i] - a[o + i]) * k;
    this.root.position.set(L(0), L(1), L(2));
    _q.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
    const qb = new THREE.Quaternion(b[o + 3], b[o + 4], b[o + 5], b[o + 6]);
    this.root.quaternion.copy(_q).slerp(qb, k);
    this.flip.rotation.x = L(7);
    this.rig.scale.set(L(8), L(9), L(10));
    this.pelvis.rotation.set(L(11), L(12), L(13));
    this.pelvis.position.y = L(14);
    this.spine.rotation.set(L(15), L(16), L(17));
    this.head.rotation.x = L(18);
    this.head.rotation.y = L(19);
    for (let i = 0; i < 2; i++) {
      const j = 20 + i * 6;
      this.arm[i].rotation.x = L(j);
      this.arm[i].rotation.z = L(j + 1);
      this.elbow[i].rotation.x = L(j + 2);
      this.leg[i].rotation.x = L(j + 3);
      this.leg[i].rotation.z = L(j + 4);
      this.knee[i].rotation.x = L(j + 5);
    }
    const ooh = a[o + 32] > 0.5;
    this.ooh.visible = ooh;
    this.smile.visible = !ooh;
    for (const e of this.eyes) e.scale.y = L(33);
    this.stars.visible = a[o + 34] > 0.5;
    if (this.stars.visible) {
      this.stars.position.set(L(0), L(1) + 1.1, L(2));
      this.stars.rotation.y = time * 6;
    }
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
    for (const pu of this.pupils) pu.position.set(lx * 0.018, ly * 0.016, 0.034);
    this.blinkT -= dt;
    if (this.blinkT < 0) this.blinkT = 2 + Math.random() * 4;
    const blink = this.blinkT < 0.1 || b.state === 'down' ? 0.15 : 1.2;
    for (const e of this.eyes) e.scale.y += (blink - e.scale.y) * Math.min(1, dt * 30);
    this.brows.forEach((br, i) => {
      const s = i === 0 ? 1 : -1;
      br.position.y = 0.08 + browUp * 0.015;
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

/** numbers per actor in a replay frame (see DudeActor.capture) */
export const POSE_N = 35;
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
