import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Particles } from '../render/effects';
import { GoalNet } from '../render/net';
import type { Quality } from '../settings';
import { Arena } from './arena';
import { DudeActor, POSE_N } from './dude';
import { ballTexture } from '../render/ball';
import { ARENA, PartyEvent, PartyWorld } from './world';

/** the ball is drawn a little bigger than its physics sphere so it reads well from the TV camera */
export const BALL_VIS_EXTRA = 0.06;

/**
 * Game camera. Mode 0 (default) "TV": a broadcast camera on the long side that follows the BALL
 * (with a little lead and a pull towards your player), your team attacks to the right — the ball is
 * always in the middle of the screen. Mode 1: high behind your team. Mode 2: close chase.
 */
export class ChaseCamera {
  camera: THREE.PerspectiveCamera;
  mode = 0;
  /** ground direction of "up" on the screen (camera-relative controls use it) */
  private fwd = new THREE.Vector3(0, 0, -1);
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private yaw = 0;
  /** which long side the TV camera stands on (+1 = z > 0) */
  side = 1;
  /** camera shake (decays) */
  shake = 0;
  /** extra zoom-in factor for dramatic moments (1 = none) */
  punch = 1;
  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.3, 2000);
  }
  forward() {
    return this.fwd.clone();
  }
  follow(player: THREE.Vector3 | null, ball: THREE.Vector3, ballVel: THREE.Vector3, attackDir: number, dt: number, snap = false) {
    const dir = attackDir >= 0 ? 1 : -1;
    const L = ARENA.length / 2;
    let wantPos: THREE.Vector3, wantLook: THREE.Vector3;
    const target = player ?? ball;
    if (this.mode === 0) {
      // TV: camera on the side that makes your attack go to the right
      const side = dir;
      this.side = side;
      const lead = new THREE.Vector3(ballVel.x, 0, ballVel.z).multiplyScalar(0.28).clampLength(0, 5);
      const want = new THREE.Vector3(ball.x + lead.x, 0, ball.z + lead.z);
      if (player) want.lerp(new THREE.Vector3(player.x, 0, player.z), 0.22);
      this.focus.lerp(want, snap ? 1 : 1 - Math.exp(-dt * 3.2));
      const f = this.focus;
      const zc = side * THREE.MathUtils.clamp(f.z * side * 0.5 + 18, 11, 24);
      wantPos = new THREE.Vector3(THREE.MathUtils.clamp(f.x, -L + 1, L - 1) * 0.9, 10.5, zc);
      const lift = THREE.MathUtils.clamp(ball.y - 1, 0, 6) * 0.4;
      // near a goal the camera pans a little further so the goal is in the picture
      const pan = Math.sign(f.x) * THREE.MathUtils.clamp((Math.abs(f.x) - 10) / 15, 0, 1) * 3.5;
      wantLook = new THREE.Vector3(f.x + pan, 0.3 + lift, f.z - side * 0.8);
      this.camera.fov = 35 / this.punch;
      this.fwd.set(0, 0, -side); // screen up = away from the camera
    } else if (this.mode === 2) {
      // close chase behind the player, turning gently towards the ball
      const base = dir > 0 ? 0 : Math.PI;
      const spread = Math.hypot(ball.x - target.x, ball.z - target.z);
      let d = Math.atan2(ball.z - target.z, ball.x - target.x) - base;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const want = base + (spread > 2.5 ? THREE.MathUtils.clamp(d, -1.2, 1.2) * 0.5 : 0);
      let dy = want - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += snap ? dy : dy * (1 - Math.exp(-dt * 1.8));
      this.fwd.set(Math.cos(this.yaw), 0, Math.sin(this.yaw));
      wantPos = target.clone().addScaledVector(this.fwd, -7).setY(4.2);
      wantLook = target.clone().addScaledVector(this.fwd, 4).add(new THREE.Vector3(ball.x - target.x, 0, ball.z - target.z).clampLength(0, 8).multiplyScalar(0.35)).setY(1);
      this.camera.fov = 55;
    } else {
      // high behind your team, fixed direction: frames your player and the ball
      const spread = Math.min(26, Math.hypot(ball.x - target.x, ball.z - target.z));
      const focus = target.clone().lerp(ball.clone().setY(0), spread > 1 ? 0.45 : 0).setY(0);
      this.fwd.set(dir, 0, 0);
      const back = 10 + spread * 0.5;
      const up = Math.min(10.5, 7.5 + spread * 0.14);
      wantPos = focus.clone().addScaledVector(this.fwd, -back).setY(up);
      wantPos.z = focus.z * 0.75;
      wantLook = focus.clone().addScaledVector(this.fwd, 3.5).setY(0.6);
      this.camera.fov = 52;
    }
    this.camera.updateProjectionMatrix();
    this.pos.lerp(wantPos, snap ? 1 : 1 - Math.exp(-dt * 4));
    this.look.lerp(wantLook, snap ? 1 : 1 - Math.exp(-dt * 6));
    this.apply(dt);
  }
  /** a fixed cinematic shot (replays): jumps there when `cut`, else glides */
  shot(pos: THREE.Vector3, look: THREE.Vector3, fov: number, dt: number, cut: boolean) {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.pos.lerp(pos, cut ? 1 : 1 - Math.exp(-dt * 3));
    this.look.lerp(look, cut ? 1 : 1 - Math.exp(-dt * 5));
    this.apply(dt);
  }
  private apply(dt: number) {
    this.camera.position.copy(this.pos);
    if (this.shake > 0.001) {
      const s = this.shake * 0.35;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    this.camera.lookAt(this.look);
  }
}

/** a glowing ribbon behind the ball when it flies (white; flames for fire shots) */
class Trail {
  readonly n = 26;
  pts: THREE.Vector3[] = [];
  mesh: THREE.Mesh;
  private pos: Float32Array;
  private alpha: Float32Array;
  private mat: THREE.ShaderMaterial;
  constructor() {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.n * 2 * 3);
    this.alpha = new Float32Array(this.n * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    const idx: number[] = [];
    for (let i = 0; i < this.n - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    g.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#ffffff') }, uHot: { value: new THREE.Color('#ffffff') } },
      vertexShader: `attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform vec3 uHot; varying float vA; void main(){ gl_FragColor = vec4(mix(uColor, uHot, vA*vA), vA); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
  }
  update(p: THREE.Vector3, on: boolean, cam: THREE.Vector3, width: number, fire: boolean) {
    if (on) {
      this.pts.unshift(p.clone());
      if (this.pts.length > this.n) this.pts.pop();
    } else if (this.pts.length) this.pts.pop();
    this.mat.uniforms.uColor.value.set(fire ? '#ff4a00' : '#9fd8ff');
    this.mat.uniforms.uHot.value.set(fire ? '#fff2a0' : '#ffffff');
    const n = this.pts.length;
    this.mesh.visible = n > 2;
    if (!this.mesh.visible) return;
    const t = new THREE.Vector3(), v = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      const k = Math.min(i, n - 1);
      const a = this.pts[Math.max(0, k - 1)], b = this.pts[Math.min(n - 1, k + 1)];
      const q = this.pts[k];
      t.subVectors(a, b);
      v.subVectors(cam, q);
      s.crossVectors(t, v).normalize();
      const f = 1 - k / (this.n - 1);
      const w = width * (0.25 + 0.75 * f) * (i < n ? 1 : 0);
      this.pos.set([q.x + s.x * w, q.y + s.y * w, q.z + s.z * w], i * 6);
      this.pos.set([q.x - s.x * w, q.y - s.y * w, q.z - s.z * w], i * 6 + 3);
      const al = i < n ? Math.pow(f, 1.4) * (fire ? 0.95 : 0.5) : 0;
      this.alpha[i * 2] = this.alpha[i * 2 + 1] = al;
    }
    (this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.mesh.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }
}

function blobTexture(rgb = '40,0,80', a = 0.55) {
  const sc = document.createElement('canvas');
  sc.width = sc.height = 64;
  const g = sc.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  gr.addColorStop(0, `rgba(${rgb},${a})`);
  gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(sc);
}

/** final look: a touch more contrast and saturation, warm highlights, soft vignette */
const GRADE = {
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.32 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, 1.12);
      c.rgb = (c.rgb - 0.5) * 1.06 + 0.5;
      c.rgb *= mix(vec3(0.97, 0.99, 1.04), vec3(1.04, 1.0, 0.95), smoothstep(0.3, 0.9, l));
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - uVig * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
    }`,
};

const FIRE_COLS = [new THREE.Color(3, 1.2, 0.2), new THREE.Color(2.5, 0.5, 0.05), new THREE.Color(3, 2.4, 0.8), new THREE.Color(1.6, 0.25, 0.05)];

/** a flat ring on the grass */
function groundRing(inner: number, outer: number, color: THREE.ColorRepresentation, opacity: number, seg = 40) {
  const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, seg), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 2;
  return m;
}

/** readable ring colour for a kit colour: never too dark */
function ringColor(c: string) {
  const col = new THREE.Color(c);
  const hsl = { h: 0, s: 0, l: 0 };
  col.getHSL(hsl);
  col.setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.max(0.5, Math.min(0.75, hsl.l)));
  return col;
}

export class PartyRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  cam: ChaseCamera;
  composer: EffectComposer | null = null;
  actors: DudeActor[] = [];
  nets: GoalNet[];
  ballMesh: THREE.Mesh;
  /** the ball seen through players and boards (only drawn where it is hidden) */
  ballXray: THREE.Mesh;
  ballShadow: THREE.Mesh;
  /** where a ball in the air will come down */
  landRing: THREE.Mesh;
  dropLine: THREE.Mesh;
  trail = new Trail();
  particles = new Particles(1600);
  arena: Arena;
  marker: THREE.Mesh;
  /** team-coloured rings under every player */
  rings: THREE.Mesh[] = [];
  /** the team-mate a pass would go to right now */
  passRing: THREE.Mesh;
  /** ground chevrons showing the mouse aim */
  aimArrow: THREE.Group;
  /** where the mouse points on the pitch (set by main.ts), null = no mouse aim */
  aimPoint: THREE.Vector3 | null = null;
  cursor: THREE.Mesh;
  private ray = new THREE.Raycaster();
  /** FIFA-style indicator: a yellow arrow over the head of the player you control */
  crown: THREE.Group;
  private crownPos = new THREE.Vector3();
  private blobs: THREE.Mesh[] = [];
  sun: THREE.DirectionalLight;
  time = 0;
  private first = true;
  /** expanding rings on the grass (fire shots, goals) */
  private waves: { m: THREE.Mesh; t: number; max: number; size: number }[] = [];
  private punchT = 0;
  private board: [number, number] = [0, 0];
  private boardClock = '';
  /** score and clock for the LED screens above the goals */
  scoreboard(clock: string) {
    this.board = [this.w.teams[0].score, this.w.teams[1].score];
    this.boardClock = clock;
    this.arena.setScoreboard(this.board, clock, '');
  }
  private flameT = 0;
  /** instant replay: the last seconds of the ball and every pose, recorded each frame */
  private rec: { t: number; d: Float32Array }[] = [];
  private goalT = -1;
  private goalDir = 1;
  replaying = false;
  private rp = { t: 0, t0: 0, t1: 0, shot: -1 };
  private postSide = 1;
  /** things that are hidden during replays */
  private overlays: THREE.Object3D[] = [];

  constructor(public container: HTMLElement, public w: PartyWorld, quality: Quality) {
    const low = quality === 'low';
    const r = new THREE.WebGLRenderer({ antialias: low, powerPreference: 'high-performance' });
    r.setPixelRatio(quality === 'high' ? Math.min(window.devicePixelRatio, 2) : 1);
    r.setSize(container.clientWidth, container.clientHeight);
    r.shadowMap.enabled = !low;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    this.renderer = r;
    this.cam = new ChaseCamera(container.clientWidth / container.clientHeight);

    // indoor hall: dark shell, light from the roof panels
    this.scene.background = new THREE.Color('#2c323d');
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pm.dispose();
    this.scene.add(new THREE.HemisphereLight(0xf7f4ee, 0x456f3a, 1.1));
    const sun = new THREE.DirectionalLight(0xfff6e8, 2.5);
    sun.position.set(-6, 40, 10);
    sun.castShadow = true;
    Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 26, bottom: -26, near: 5, far: 120 });
    sun.shadow.mapSize.set(quality === 'high' ? 4096 : 2048, quality === 'high' ? 4096 : 2048);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.03;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    // cool rim light from the far side: separates the dummies from the grass
    const rim = new THREE.DirectionalLight(0xbfd8ff, 0.9);
    rim.position.set(8, 9, -30);
    this.scene.add(rim);

    if (!low) {
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      const c = new EffectComposer(r, rt);
      c.addPass(new RenderPass(this.scene, this.cam.camera));
      c.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), quality === 'high' ? 0.35 : 0.25, 0.5, 0.85));
      c.addPass(new OutputPass());
      c.addPass(new ShaderPass(GRADE));
      this.composer = c;
    }

    this.arena = new Arena(w.teams.map((t) => t.info));
    this.scene.add(this.arena.group);
    this.nets = [new GoalNet(ARENA, -1, w.ballR + BALL_VIS_EXTRA), new GoalNet(ARENA, 1, w.ballR + BALL_VIS_EXTRA)];
    for (const n of this.nets) this.scene.add(n.mesh);

    const ballGeo = new THREE.SphereGeometry(1, 40, 24);
    this.ballMesh = new THREE.Mesh(ballGeo, new THREE.MeshPhysicalMaterial({ map: ballTexture(), roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.2 }));
    this.ballMesh.castShadow = true;
    this.scene.add(this.ballMesh);
    this.ballXray = new THREE.Mesh(ballGeo, new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.6, depthWrite: false, depthFunc: THREE.GreaterDepth }));
    this.ballXray.renderOrder = 10;
    this.scene.add(this.ballXray);
    // soft blob under the ball: tells you where it is when it flies
    const blobTex = blobTexture();
    this.ballShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);
    this.landRing = groundRing(0.42, 0.55, 0xffffff, 0.8, 32);
    this.scene.add(this.landRing);
    this.dropLine = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 6, 1, true), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
    this.scene.add(this.dropLine);
    this.scene.add(this.trail.mesh);
    this.scene.add(this.particles.mesh);

    for (let i = 0; i < w.bros.length; i++) {
      const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.55 }));
      blob.rotation.x = -Math.PI / 2;
      this.blobs.push(blob);
      this.scene.add(blob);
    }
    for (const b of w.bros) {
      const a = new DudeActor(b, w.teams[b.team].info, w.teams[1 - b.team].info);
      this.actors.push(a);
      this.scene.add(a.root, a.stars);
      const ring = groundRing(0.44, 0.54, ringColor(w.teams[b.team].info.primary), 0.75);
      this.rings.push(ring);
      this.scene.add(ring);
    }
    // ring under your player
    this.marker = groundRing(0.56, 0.76, 0xffd23f, 0.95);
    this.scene.add(this.marker);
    this.passRing = groundRing(0.6, 0.74, 0xffffff, 0.9, 6);
    this.scene.add(this.passRing);
    this.aimArrow = new THREE.Group();
    const chev = new THREE.Shape();
    chev.moveTo(0, -0.42);
    chev.lineTo(0.48, 0);
    chev.lineTo(0, 0.42);
    chev.lineTo(0.16, 0);
    chev.closePath();
    const chevGeo = new THREE.ShapeGeometry(chev);
    chevGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(chevGeo, new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.95 - i * 0.25, depthWrite: false, side: THREE.DoubleSide }));
      m.position.set(1.0 + i * 0.7, 0.05, 0);
      this.aimArrow.add(m);
    }
    this.aimArrow.visible = false;
    this.scene.add(this.aimArrow);
    this.cursor = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 4, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.visible = false;
    this.scene.add(this.cursor);
    this.crown = new THREE.Group();
    const arrowGeo = new THREE.ConeGeometry(0.2, 0.38, 3);
    arrowGeo.rotateX(Math.PI);
    const arrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xffd23f }));
    const arrowOut = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0x1b1030, side: THREE.BackSide }));
    arrowOut.scale.setScalar(1.25);
    this.crown.add(arrow, arrowOut);
    this.scene.add(this.crown);
    this.overlays = [this.marker, this.passRing, this.aimArrow, this.cursor, this.crown, this.landRing, this.dropLine, ...this.rings];
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.cam.camera.aspect = w / h;
    this.cam.camera.updateProjectionMatrix();
  }

  handleEvents(events: PartyEvent[]) {
    for (const e of events) {
      if ((e.type === 'kick' && (e.strength ?? 0) > 6) || e.type === 'tackle' || e.type === 'header') if (e.pos) this.particles.grass(e.pos, (e.strength ?? 8) * 0.5);
      if (e.type === 'bonk' && e.pos) this.particles.grass(e.pos, 12);
      if (e.type === 'goal') {
        const t = this.w.teams[e.team ?? 0].info;
        this.particles.confetti(e.pos ?? new THREE.Vector3(), [t.primary, t.secondary, '#ffd60a', '#ffffff', '#ff7ab8']);
        this.arena.hype = 1;
        this.cam.shake = Math.max(this.cam.shake, 0.5);
      }
      if (e.type === 'post') {
        this.arena.hype = Math.max(this.arena.hype, 0.5);
        this.cam.shake = Math.max(this.cam.shake, 0.25);
      }
      if (e.type === 'fire' && e.pos) {
        // the crash-test shot: shockwave, sparks, a jolt of the camera
        this.cam.shake = 1;
        this.punchT = 0.9;
        this.wave(e.pos, 7, 0.7, 0xffa040);
        this.particles.burst(e.pos.clone().setY(0.3), 70, 9, FIRE_COLS, { size: 0.16, life: 0.7, up: 2, gravity: -1 });
        this.arena.hype = Math.max(this.arena.hype, 0.7);
      }
      if (e.type === 'burn' && e.pos) {
        this.cam.shake = Math.max(this.cam.shake, 0.5);
        this.particles.burst(e.pos.clone().setY(1), 40, 7, FIRE_COLS, { size: 0.14, life: 0.6, up: 1.5, gravity: -1 });
      }
      if (e.type === 'fire') this.arena.setScoreboard(this.board, this.boardClock, 'ОГОНЬ!', 2);
      if (e.type === 'save' && (e.strength ?? 0) > 14) this.arena.setScoreboard(this.board, this.boardClock, 'СЕЙВ!', 2);
      if (e.type === 'goal' && e.pos) {
        this.board = [this.w.teams[0].score, this.w.teams[1].score];
        this.arena.setScoreboard(this.board, this.boardClock, 'ГОЛ!', 4);
        this.wave(e.pos.clone().setY(0), 9, 1, 0xffffff);
        this.goalT = this.time;
        this.goalDir = Math.sign(e.pos.x) || 1;
      }
    }
  }

  private wave(pos: THREE.Vector3, size: number, max: number, color: number) {
    const m = groundRing(0.8, 1, color, 0.9, 64);
    (m.material as THREE.MeshBasicMaterial).blending = THREE.AdditiveBlending;
    m.position.set(pos.x, 0.06, pos.z);
    this.scene.add(m);
    this.waves.push({ m, t: 0, max, size });
  }

  /** ball, its shadow, the landing marker and the trail */
  private drawBall(dt: number) {
    const w = this.w;
    const bp = w.ballPos();
    const bv = w.ballVel();
    const vr = w.ballR + BALL_VIS_EXTRA;
    const br = w.ball.rotation();
    this.ballMesh.position.set(bp.x, bp.y + BALL_VIS_EXTRA, bp.z);
    this.ballMesh.quaternion.set(br.x, br.y, br.z, br.w);
    this.ballMesh.scale.setScalar(vr);
    this.ballXray.position.copy(this.ballMesh.position);
    this.ballXray.scale.setScalar(vr);
    const hgt = Math.max(0, bp.y - w.ballR);
    const s = vr * 2.6 * (1 + hgt * 0.1);
    this.ballShadow.scale.set(s, s, 1);
    this.ballShadow.position.set(bp.x, 0.03, bp.z);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.4, 1 - hgt * 0.06);
    // in the air: a line down to the grass and a ring where it will land
    const air = hgt > 0.9 && !w.gkHold;
    this.dropLine.visible = air;
    this.landRing.visible = false;
    if (air) {
      this.dropLine.scale.set(1, hgt, 1);
      this.dropLine.position.set(bp.x, hgt / 2, bp.z);
      const g = -w.gravity;
      const tLand = (bv.y + Math.sqrt(Math.max(0, bv.y * bv.y + 2 * g * hgt))) / g;
      if (tLand > 0.25 && tLand < 4) {
        const k = 0.9; // air drag shortens it a little
        const lx = THREE.MathUtils.clamp(bp.x + bv.x * tLand * k, -ARENA.length / 2, ARENA.length / 2);
        const lz = THREE.MathUtils.clamp(bp.z + bv.z * tLand * k, -ARENA.width / 2, ARENA.width / 2);
        this.landRing.visible = true;
        this.landRing.position.set(lx, 0.04, lz);
        this.landRing.scale.setScalar(0.8 + Math.min(1.5, tLand) * 0.6);
        (this.landRing.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.5 * Math.abs(Math.sin(this.time * 8));
      }
    }
    const fire = !!w.fireBall;
    const bm = this.ballMesh.material as THREE.MeshPhysicalMaterial;
    bm.emissive.set(fire ? 0xff5a00 : 0x000000);
    bm.emissiveIntensity = fire ? 1.4 + Math.sin(this.time * 30) * 0.4 : 0;
    if (fire) {
      this.flameT += dt;
      while (this.flameT > 0.012) {
        this.flameT -= 0.012;
        this.particles.burst(this.ballMesh.position, 2, 1.5, FIRE_COLS, { size: 0.2, life: 0.35, gravity: -3, drag: 4, spread: vr });
      }
    }
    this.trail.update(this.ballMesh.position, bv.length() > 11 || fire, this.cam.camera.position, vr * (fire ? 1.3 : 0.8), fire);
    for (const n of this.nets) {
      n.ballRadius = vr;
      n.update(dt, this.ballMesh.position, this.time);
    }
  }

  draw(dt: number) {
    this.time += dt;
    const w = this.w;
    const bp = w.ballPos();
    const c = w.controlled;
    this.actors.forEach((a, i) => {
      const p = a.bro.body.translation();
      const blob = this.blobs[i];
      const hgt = Math.max(0, p.y - 0.76);
      blob.position.set(p.x, 0.025, p.z);
      blob.scale.setScalar(1.1 + hgt * 0.3);
      (blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0.15, 0.55 - hgt * 0.2);
      const ring = this.rings[i];
      ring.visible = a.bro !== c && a.bro.state !== 'down';
      ring.position.set(p.x, 0.035, p.z);
    });
    for (const a of this.actors) {
      const g = a.bro.grabbing;
      a.update(dt, this.time, bp, g ? g.position() : null);
    }
    this.drawBall(dt);
    // the player on the ball glows when his team's ОГОНЬ meter is full
    const h = w.holder;
    if (h && w.teams[h.team].fire >= 1 && Math.random() < dt * 40) {
      const hp = h.position();
      this.particles.burst(new THREE.Vector3(hp.x, 0.2, hp.z), 1, 1.2, FIRE_COLS, { size: 0.15, life: 0.45, gravity: -2.5, drag: 3, spread: 0.5 });
    }
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wv = this.waves[i];
      wv.t += dt;
      const k = wv.t / wv.max;
      wv.m.scale.setScalar(0.5 + k * wv.size);
      (wv.m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
      if (k >= 1) {
        this.scene.remove(wv.m);
        wv.m.geometry.dispose();
        this.waves.splice(i, 1);
      }
    }
    this.punchT = Math.max(0, this.punchT - dt);
    this.cam.punch = 1 + 0.22 * Math.sin(Math.min(1, this.punchT / 0.9) * Math.PI);
    this.particles.update(dt);
    this.arena.update(dt, this.time, w.sweeper);
    this.marker.visible = !!c;
    if (c) (this.marker.material as THREE.MeshBasicMaterial).color.set(w.teams[c.team].fire >= 1 ? (Math.sin(this.time * 12) > 0 ? 0xff5a1f : 0xffd23f) : 0xffd23f);
    // the team-mate your pass would reach
    const pt = w.passTarget;
    this.passRing.visible = !!pt;
    if (pt) {
      const q = pt.position();
      this.passRing.position.set(q.x, 0.045, q.z);
      this.passRing.rotation.z += dt * 2.5;
      this.passRing.scale.setScalar(1 + Math.sin(this.time * 9) * 0.08);
    }
    // mouse aim: chevrons from your player towards the cursor, and a target ring on the grass
    const ap = this.aimPoint;
    this.aimArrow.visible = !!c && !!ap && c.state === 'up';
    this.cursor.visible = !!ap;
    if (ap) {
      this.cursor.position.set(ap.x, 0.04, ap.z);
      this.cursor.rotation.z += dt * 2;
    }
    if (this.aimArrow.visible) {
      const cp = c!.position();
      this.aimArrow.position.set(cp.x, 0, cp.z);
      this.aimArrow.rotation.y = -Math.atan2(ap!.z - cp.z, ap!.x - cp.x);
    }
    const focus = c ? c.position() : null;
    this.crown.visible = !!c;
    if (c) {
      const fp = focus!;
      this.marker.position.set(fp.x, 0.04, fp.z);
      this.marker.scale.setScalar(1 + Math.sin(this.time * 5) * 0.06);
      // the arrow flies over to the player you switched to
      const want = fp.clone().add(new THREE.Vector3(0, 1.75 + Math.sin(this.time * 5) * 0.08, 0));
      if (this.crownPos.lengthSq() === 0) this.crownPos.copy(want);
      this.crownPos.lerp(want, 1 - Math.exp(-dt * 12));
      this.crown.position.copy(this.crownPos);
      this.crown.rotation.y += dt * 1.5;
    }
    const attack = c ? w.teams[c.team].dir : 1;
    this.cam.follow(focus, bp, w.ballVel(), attack, dt, this.first);
    this.first = false;
    this.arena.setCutaway(this.cam.mode === 0 ? this.cam.side : 0);
    this.render();
    this.record();
  }

  // ---------------- instant replay ----------------
  private record() {
    const d: number[] = [];
    const b = this.ballMesh;
    d.push(b.position.x, b.position.y, b.position.z, b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w, this.w.fireBall ? 1 : 0);
    for (const a of this.actors) a.capture(d);
    this.rec.push({ t: this.time, d: Float32Array.from(d) });
    while (this.rec.length && this.rec[0].t < this.time - 7) this.rec.shift();
  }

  /** replay the goal that was just scored (false if there is nothing to show) */
  startReplay() {
    if (this.goalT < 0 || this.rec.length < 8) return false;
    this.rp.t0 = Math.max(this.rec[0].t, this.goalT - 3.4);
    this.rp.t1 = Math.min(this.rec[this.rec.length - 1].t, this.goalT + 0.6);
    this.rp.t = this.rp.t0;
    this.rp.shot = -1;
    this.replaying = true;
    for (const o of this.overlays) o.visible = false;
    this.trail.pts.length = 0;
    return true;
  }

  stopReplay() {
    this.replaying = false;
    this.goalT = -1;
    this.rec.length = 0;
    this.trail.pts.length = 0;
    this.first = true; // cut straight back to the game camera
  }

  /** one frame of the replay; false when it is over */
  drawReplay(dt: number) {
    const rp = this.rp;
    const speed = 0.6;
    rp.t += dt * speed;
    if (rp.t > rp.t1) return false;
    this.time += dt * speed;
    // the two recorded frames around the replay time
    const rec = this.rec;
    let i = 0;
    while (i < rec.length - 2 && rec[i + 1].t < rp.t) i++;
    const A = rec[i], B = rec[i + 1] ?? A;
    const k = B.t > A.t ? THREE.MathUtils.clamp((rp.t - A.t) / (B.t - A.t), 0, 1) : 0;
    const a = A.d, b = B.d;
    const prev = this.ballMesh.position.clone();
    this.ballMesh.position.set(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
    this.ballMesh.quaternion.set(a[3], a[4], a[5], a[6]).slerp(new THREE.Quaternion(b[3], b[4], b[5], b[6]), k);
    const bp = this.ballMesh.position;
    const fire = a[7] > 0.5;
    const bm = this.ballMesh.material as THREE.MeshPhysicalMaterial;
    bm.emissive.set(fire ? 0xff5a00 : 0x000000);
    bm.emissiveIntensity = fire ? 1.6 : 0;
    this.ballXray.position.copy(bp);
    this.ballShadow.position.set(bp.x, 0.03, bp.z);
    this.actors.forEach((ac, j) => {
      ac.applyPose(a, b, 8 + j * POSE_N, k, this.time);
      const p = ac.root.position;
      this.blobs[j].position.set(p.x, 0.025, p.z);
    });
    const v = bp.clone().sub(prev).divideScalar(Math.max(1e-3, dt * speed));
    this.trail.update(bp, v.length() > 11 || fire, this.cam.camera.position, (this.w.ballR + BALL_VIS_EXTRA) * (fire ? 1.3 : 0.8), fire);
    for (const n of this.nets) n.update(dt * speed, bp, this.time);
    this.particles.update(dt * speed);
    this.arena.update(dt * speed, this.time, this.w.sweeper);
    this.arena.setCutaway(0);
    // cameras: a low tracking shot along the touchline, then behind the goal through the net
    const shot = rp.t < this.goalT - 1.15 ? 0 : 1;
    const cut = shot !== rp.shot;
    rp.shot = shot;
    const L = ARENA.length / 2;
    const gd = this.goalDir;
    if (shot === 0) {
      const side = bp.z > 0 ? -1 : 1;
      const pos = new THREE.Vector3(bp.x - gd * 4, 2.6, bp.z + side * 9.5);
      this.cam.shot(pos, bp.clone().setY(Math.max(0.6, bp.y * 0.7)), 34, dt, cut);
    } else {
      // low, beside the post: the ball flies at the goal and bulges the net
      if (cut) this.postSide = bp.z >= 0 ? 1 : -1;
      const pos = new THREE.Vector3(gd * (L - 2.2), 1.5, this.postSide * (ARENA.goalHalfW + 6.5));
      const look = bp.clone().lerp(new THREE.Vector3(gd * L, 1, 0), 0.35);
      this.cam.shot(pos, look.setY(Math.max(0.7, look.y)), 42, dt, cut);
    }
    this.render();
    return true;
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.cam.camera);
  }

  /** the point on the grass under screen position (client px), or null */
  pickGround(cx: number, cy: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const nx = ((cx - r.left) / r.width) * 2 - 1, ny = -((cy - r.top) / r.height) * 2 + 1;
    if (Math.abs(nx) > 1 || Math.abs(ny) > 1) return null;
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.cam.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    if (d.y > -0.01) return null;
    const t = -o.y / d.y;
    return new THREE.Vector3(o.x + d.x * t, 0, o.z + d.z * t);
  }

  project(p: THREE.Vector3) {
    const v = p.clone().project(this.cam.camera);
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight, visible: v.z < 1 };
  }

  dispose() {
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
