import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BALL } from '../sim/config';
import type { TeamInfo } from '../sim/team';
import { BallView } from '../render/ball';
import { Particles } from '../render/effects';
import { GoalNet } from '../render/net';
import { Stadium } from '../render/stadium';
import { DudeActor } from '../party/dude';
import { BRO, type Bro } from '../party/bro';
import { Actor, FIELD, GOAL_X, GH, HW, Moment } from './sim';

export type Quality = 'low' | 'medium' | 'high';

/** Golazo's ball is drawn a bit bigger than real so it reads well on small screens. */
export const BALL_VIS = 1.3;
const UP = new THREE.Vector3(0, 1, 0);

/** What the renderer needs from an actor (live from the sim or from a replay frame). */
export interface ActorView {
  pos: THREE.Vector3;
  face: THREE.Vector3;
  vel: THREE.Vector3;
  kickT: number;
  kickKind: Actor['kickKind'];
  jump: number;
  dive: number;
  diveUp: number;
  celebrate: boolean;
}

/**
 * Adapter so the procedural crash-test dummies (party/dude.ts, written for wobbly physics bros)
 * can be driven by Golazo's kinematic actors.
 */
class PuppetBro {
  state: 'up' | 'dive' = 'up';
  kickT = -1;
  kickKind: Bro['kickKind'] = 'shot';
  kickSide = -1;
  grounded = true;
  charging = null;
  skill = null;
  fooled = 0;
  uprightness = 1;
  celebrate = false;
  dizzy = 0;
  stiff = true;
  speed = 0;
  private t = { x: 0, y: 0, z: 0 };
  private q = new THREE.Quaternion();
  private v = { x: 0, y: 0, z: 0 };
  body = {
    translation: () => this.t,
    rotation: () => this.q,
    linvel: () => this.v,
    angvel: () => ({ x: 0, y: 0, z: 0 }),
  };
  constructor(public id: number, public role: 'GK' | 'FIELD', public number: number, public name: string) {}

  sync(a: ActorView) {
    const yaw = Math.atan2(a.face.x, a.face.z);
    this.q.setFromAxisAngle(UP, yaw);
    let x = a.pos.x, y = BRO.centerY + a.jump, z = a.pos.z;
    const ad = Math.abs(a.dive);
    if (this.role === 'GK' && ad > 0.02) {
      // keeper dive: roll onto the side, body flies sideways and up
      const s = Math.sign(a.dive);
      const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -s * ad * 1.25 * (a.face.x < 0 ? 1 : -1));
      this.q.multiply(roll);
      z += s * ad * 0.75;
      y += (a.diveUp * 0.7 - 0.25) * ad;
      this.state = 'dive';
    } else this.state = 'up';
    this.t.x = x;
    this.t.y = y;
    this.t.z = z;
    this.v.x = a.vel.x;
    this.v.y = 0;
    this.v.z = a.vel.z;
    this.speed = Math.hypot(a.vel.x, a.vel.z);
    this.kickT = a.kickT;
    this.kickKind = a.kickKind;
    this.grounded = a.jump < 0.03;
    this.celebrate = a.celebrate;
  }
}

/** Sunset sky dome: deep blue overhead, warm orange glow at the horizon towards the sun. */
function makeSunsetSky(sunDir: THREE.Vector3) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { sun: { value: sunDir.clone().normalize() } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 sun; varying vec3 vP;
      void main(){
        float h = clamp(vP.y, -0.2, 1.0);
        vec3 top = vec3(0.10, 0.18, 0.42);
        vec3 mid = vec3(0.42, 0.45, 0.70);
        vec3 hor = vec3(1.0, 0.62, 0.38);
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.25, h));
        c = mix(c, top, smoothstep(0.2, 0.85, h));
        float s = max(0.0, dot(normalize(vP), sun));
        c += vec3(1.0, 0.55, 0.25) * pow(s, 8.0) * 0.6 + vec3(1.0, 0.85, 0.6) * pow(s, 200.0) * 2.0;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(650, 32, 16), mat);
}

/** colour grade + vignette */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.32 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.299,0.587,0.114));
      c.rgb = mix(vec3(l), c.rgb, 1.12);
      c.rgb = (c.rgb - 0.5) * 1.05 + 0.5;
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - uVig * dot(d, d) * 2.2;
      gl_FragColor = c;
    }`,
};

const dotGeo = new THREE.SphereGeometry(1, 8, 6);

export class GolazoRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer | null = null;
  stadium: Stadium;
  net: GoalNet;
  ball = new BallView();
  particles = new Particles(1400);
  dudes = new Map<number, { dude: DudeActor; puppet: PuppetBro }>();
  time = 0;
  // overlays
  private pathDots: THREE.InstancedMesh;
  private pathShadows: THREE.InstancedMesh;
  private target: THREE.Group;
  private goalTarget: THREE.Mesh;
  private holderRing: THREE.Mesh;
  private receiverRing: THREE.Mesh;
  private runGroup = new THREE.Group();
  /** red cross where a drawn pass would be cut out */
  private danger: THREE.Sprite;
  private m4 = new THREE.Matrix4();
  shake = 0;
  /** goal net opacity multiplier (the keeper's view looks through it) */
  netFade = 1;

  constructor(public container: HTMLElement, teams: TeamInfo[], public quality: Quality = 'high') {
    const low = quality === 'low';
    const r = new THREE.WebGLRenderer({ antialias: low, powerPreference: 'high-performance' });
    r.setPixelRatio(quality === 'high' ? Math.min(window.devicePixelRatio, 2) : Math.min(window.devicePixelRatio, 1.25));
    r.setSize(container.clientWidth, container.clientHeight);
    r.shadowMap.enabled = !low;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    r.domElement.style.touchAction = 'none';
    this.renderer = r;

    this.camera = new THREE.PerspectiveCamera(44, container.clientWidth / container.clientHeight, 0.1, 1500);
    this.camera.position.set(20, 6, 0);
    this.camera.fov = this.baseFov();
    this.camera.updateProjectionMatrix();

    const sunDir = new THREE.Vector3(-60, 22, -70);
    this.scene.add(makeSunsetSky(sunDir));
    this.scene.fog = new THREE.Fog(0xb88a7a, 220, 620);

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.3;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xaec8ff, 0x4a5a2a, 0.75));
    const sun = new THREE.DirectionalLight(0xffc48a, 2.9);
    sun.position.copy(sunDir).normalize().multiplyScalar(120).add(new THREE.Vector3(GOAL_X - 20, 0, 0));
    sun.target.position.set(GOAL_X - 20, 0, 0);
    sun.castShadow = true;
    const ext = 48;
    Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 20, far: 320 });
    sun.shadow.mapSize.set(quality === 'high' ? 4096 : 2048, quality === 'high' ? 4096 : 2048);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
    // floodlights are on already: cool fill from the other side
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.8);
    fill.position.set(GOAL_X + 40, 60, 60);
    this.scene.add(fill);

    if (!low) {
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      const composer = new EffectComposer(r, rt);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (quality === 'high') composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.28, 0.55, 0.88));
      composer.addPass(new OutputPass());
      composer.addPass(new ShaderPass(GradeShader));
      this.composer = composer;
    }

    this.stadium = new Stadium(FIELD, teams, 0, false);
    this.scene.add(this.stadium.group);
    const ballR = BALL.radius * BALL_VIS;
    this.ball.r = ballR;
    this.ball.mesh.scale.setScalar(BALL_VIS / 1.6);
    ((this.ball.trail.material as THREE.ShaderMaterial).uniforms.color.value as THREE.Color).set('#fff8e0');
    this.net = new GoalNet(FIELD, 1, ballR);
    this.scene.add(this.net.mesh);
    this.scene.add(this.ball.mesh, this.ball.shadow, this.ball.trail, this.particles.mesh);

    // preview: glowing dots along the predicted flight + their shadows on the grass
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false });
    this.pathDots = new THREE.InstancedMesh(dotGeo, dotMat, 160);
    this.pathDots.frustumCulled = false;
    this.pathDots.count = 0;
    this.pathDots.renderOrder = 5;
    const shMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
    this.pathShadows = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2), shMat, 160);
    this.pathShadows.frustumCulled = false;
    this.pathShadows.count = 0;
    this.scene.add(this.pathDots, this.pathShadows);

    this.target = new THREE.Group();
    const tRing = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.68, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    tRing.position.y = 0.04;
    this.target.add(tRing);
    this.target.visible = false;
    this.scene.add(this.target);
    this.goalTarget = new THREE.Mesh(
      new THREE.RingGeometry(0.22, 0.3, 32).rotateY(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.goalTarget.visible = false;
    this.goalTarget.renderOrder = 6;
    this.scene.add(this.goalTarget);
    this.holderRing = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.95, depthWrite: false }));
    this.holderRing.position.y = 0.035;
    this.scene.add(this.holderRing);
    this.receiverRing = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.95, depthWrite: false }));
    this.receiverRing.position.y = 0.035;
    this.receiverRing.visible = false;
    this.scene.add(this.receiverRing);
    this.scene.add(this.runGroup);
    const dc = document.createElement('canvas');
    dc.width = dc.height = 64;
    const g = dc.getContext('2d')!;
    g.strokeStyle = '#ff3b3b';
    g.lineWidth = 12;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(14, 14);
    g.lineTo(50, 50);
    g.moveTo(50, 14);
    g.lineTo(14, 50);
    g.stroke();
    this.danger = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(dc), depthTest: false, transparent: true }));
    this.danger.scale.setScalar(1.1);
    this.danger.renderOrder = 9;
    this.danger.visible = false;
    this.scene.add(this.danger);

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = this.baseFov();
    this.camera.updateProjectionMatrix();
  }

  /** narrow (portrait phone) screens get a wider lens so the team-mates stay in view */
  get portrait() {
    return this.camera.aspect < 0.85;
  }
  baseFov() {
    return this.camera.aspect < 0.85 ? 64 : this.camera.aspect < 1.2 ? 52 : 44;
  }

  /** (Re)build the dummies for a new level. */
  setActors(m: Moment, home: TeamInfo, away: TeamInfo) {
    for (const { dude } of this.dudes.values()) {
      this.scene.remove(dude.root, dude.stars);
    }
    this.dudes.clear();
    for (const a of m.actors) {
      const puppet = new PuppetBro(a.id, a.role === 'gk' ? 'GK' : 'FIELD', a.number, a.name);
      const dude = new DudeActor(puppet as unknown as Bro, a.team === 0 ? home : away, a.team === 0 ? away : home);
      this.dudes.set(a.id, { dude, puppet });
      this.scene.add(dude.root, dude.stars);
      dude.stars.visible = false;
    }
    this.net.reset();
    this.ball.resetTrail();
  }

  /** Show the team-mates' planned runs for the next kick as dashed arrows on the grass. */
  showRuns(m: Moment | null) {
    for (const c of [...this.runGroup.children]) {
      this.runGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    if (!m) return;
    for (const a of m.actors) {
      if (a.team !== 0) continue;
      const run = a.runs[m.kicks];
      if (!run || !run.length) continue;
      this.runGroup.add(arrowMesh([a.pos.clone(), ...run], a === m.holder ? 0xffd23f : 0x7fe0ff));
    }
  }

  setPreview(path: THREE.Vector3[] | null, kind: 'shot' | 'pass' | 'lob' | null, receiver: Actor | null, danger: THREE.Vector3 | null = null) {
    this.danger.visible = !!danger && !!path;
    if (danger) this.danger.position.set(danger.x, Math.max(0.3, danger.y), danger.z);
    (this.pathDots.material as THREE.MeshBasicMaterial).color.set(danger ? 0xff5a5a : 0xffffff);
    if (!path || path.length < 2) {
      this.pathDots.count = 0;
      this.pathShadows.count = 0;
      this.target.visible = false;
      this.goalTarget.visible = false;
      this.receiverRing.visible = false;
      return;
    }
    // resample at even spacing
    const pts: THREE.Vector3[] = [];
    let acc = 0;
    const step = 0.75;
    pts.push(path[0]);
    for (let i = 1; i < path.length && pts.length < 160; i++) {
      acc += path[i].distanceTo(path[i - 1]);
      if (acc >= step) {
        acc = 0;
        pts.push(path[i]);
      }
    }
    let n = 0;
    const q = new THREE.Quaternion();
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const k = 1 - (i / pts.length) * 0.5;
      const s = 0.075 * k + 0.03;
      this.m4.compose(p, q, new THREE.Vector3(s, s, s));
      this.pathDots.setMatrixAt(n, this.m4);
      const ss = s * (1.1 + Math.min(1.5, p.y * 0.25));
      this.m4.compose(new THREE.Vector3(p.x, 0.025, p.z), q, new THREE.Vector3(ss, 1, ss));
      this.pathShadows.setMatrixAt(n, this.m4);
      n++;
    }
    this.pathDots.count = n;
    this.pathShadows.count = p_count(n, kind);
    this.pathDots.instanceMatrix.needsUpdate = true;
    this.pathShadows.instanceMatrix.needsUpdate = true;
    const end = path[path.length - 1];
    if (kind === 'shot') {
      // where it crosses the goal line
      let c = end;
      for (let i = 1; i < path.length; i++) if (path[i].x >= GOAL_X) {
        c = path[i];
        break;
      }
      this.goalTarget.position.set(GOAL_X + 0.02, c.y, c.z);
      this.goalTarget.scale.setScalar(1);
      this.goalTarget.visible = Math.abs(c.z) < HW + 3 && c.y < GH + 3;
      this.target.visible = false;
    } else {
      this.goalTarget.visible = false;
      this.target.visible = true;
      this.target.position.set(end.x, 0, end.z);
    }
    this.receiverRing.visible = !!receiver && !danger;
    if (danger) this.target.visible = false;
    if (receiver) this.receiverRing.position.set(receiver.pos.x, 0.035, receiver.pos.z);
  }

  /** free-kick challenge bonus target: a glowing ring on the goal plane */
  private targetMesh: THREE.Mesh | null = null;
  setTarget(t: { z: number; y: number; r: number } | null) {
    if (!this.targetMesh) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.72, 1, 40).rotateY(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xff3d8b, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
      );
      const inner = new THREE.Mesh(new THREE.CircleGeometry(0.72, 40).rotateY(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
      m.add(inner);
      m.renderOrder = 4;
      this.scene.add(m);
      this.targetMesh = m;
    }
    this.targetMesh.visible = !!t;
    if (t) {
      this.targetMesh.position.set(GOAL_X + 0.03, t.y, t.z);
      this.targetMesh.scale.setScalar(t.r);
    }
  }
  burstTarget() {
    const t = this.targetMesh;
    if (!t || !t.visible) return;
    this.particles.burst(t.position, 60, 6, [new THREE.Color('#ff3d8b'), new THREE.Color('#ffd23f'), new THREE.Color('#ffffff')], { size: 0.12, life: 1.2, gravity: 4 });
    t.visible = false;
  }

  /** a ring on the goal (the keeper's dive spot in a shoot-out) */
  markGoal(p: THREE.Vector3 | null) {
    this.goalTarget.visible = !!p;
    if (p) this.goalTarget.position.set(GOAL_X - 0.05, p.y, p.z);
    this.goalTarget.scale.setScalar(p ? 0.75 : 1);
  }

  /** Draw one frame. `views` = actor states (live or replay). */
  draw(views: Map<number, ActorView>, ball: { pos: THREE.Vector3; vel: THREE.Vector3; spin: THREE.Vector3 }, dt: number, holder: ActorView | null) {
    this.time += dt;
    for (const [id, v] of views) {
      const d = this.dudes.get(id);
      if (!d) continue;
      d.puppet.sync(v);
      d.dude.update(dt, this.time, ball.pos, null);
    }
    this.ball.update(ball.pos, ball.vel, ball.spin, dt, this.camera);
    this.net.update(dt, this.ball.mesh.position, this.time);
    const nm = this.net.mesh.material as THREE.MeshStandardMaterial;
    nm.opacity += (this.netFade - nm.opacity) * Math.min(1, dt * 6);
    this.particles.update(dt);
    this.stadium.update(dt, this.time);
    this.holderRing.visible = !!holder;
    if (holder) {
      this.holderRing.position.set(holder.pos.x, 0.035, holder.pos.z);
      const s = 1 + Math.sin(this.time * 5) * 0.06;
      this.holderRing.scale.set(s, 1, s);
    }
    if (this.receiverRing.visible) {
      const s = 1 + Math.sin(this.time * 7) * 0.1;
      this.receiverRing.scale.set(s, 1, s);
    }
    if (this.goalTarget.visible) this.goalTarget.rotation.x = this.time * 2;
    if (this.targetMesh?.visible) {
      const k = 1 + Math.sin(this.time * 4) * 0.06;
      this.targetMesh.children[0].scale.setScalar(k);
    }
    // camera shake
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.5);
      const s = this.shake * 0.12;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** screen pixel → world ray */
  ray(px: number, py: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((px - rect.left) / rect.width) * 2 - 1, -((py - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc.ray;
  }

  project(p: THREE.Vector3) {
    const v = p.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, behind: v.z > 1 };
  }
}

function p_count(n: number, _kind: string | null) {
  return n;
}

/** dashed arrow along a polyline on the grass */
function arrowMesh(pts: THREE.Vector3[], color: number) {
  const pos: number[] = [];
  const w = 0.16;
  const dash = 0.7, gap = 0.45;
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    const len = dir.length();
    if (len < 0.01) continue;
    dir.divideScalar(len);
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(w);
    let s = carry;
    const isLast = i === pts.length - 1;
    const stop = isLast ? len - 0.9 : len;
    while (s < stop) {
      const e = Math.min(stop, s + dash);
      const p0 = new THREE.Vector3(a.x + dir.x * s, 0.05, a.z + dir.z * s);
      const p1 = new THREE.Vector3(a.x + dir.x * e, 0.05, a.z + dir.z * e);
      pos.push(p0.x + side.x, 0.05, p0.z + side.z, p0.x - side.x, 0.05, p0.z - side.z, p1.x + side.x, 0.05, p1.z + side.z);
      pos.push(p1.x + side.x, 0.05, p1.z + side.z, p0.x - side.x, 0.05, p0.z - side.z, p1.x - side.x, 0.05, p1.z - side.z);
      s = e + gap;
    }
    carry = Math.max(0, s - len);
    if (isLast) {
      // arrow head
      const tip = new THREE.Vector3(b.x, 0.05, b.z);
      const base = tip.clone().addScaledVector(dir, -0.9);
      const sd = side.clone().multiplyScalar(3.2);
      pos.push(base.x + sd.x, 0.05, base.z + sd.z, base.x - sd.x, 0.05, base.z - sd.z, tip.x, 0.05, tip.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
  m.renderOrder = 3;
  return m;
}
