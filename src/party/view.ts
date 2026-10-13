import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Particles } from '../render/effects';
import { GoalNet } from '../render/net';
import type { Quality } from '../settings';
import { Arena } from './arena';
import { DudeActor } from './dude';
import { ballTexture } from '../render/ball';
import { ARENA, PartyEvent, PartyWorld } from './world';

/**
 * Game camera. Mode 0 (default) "play": high behind your team's attacking direction, never spins,
 * frames your player AND the ball (zooms out when they are apart) — controls stay screen-relative
 * and nothing gets lost. Mode 1: side TV view. Mode 2: close chase behind the player.
 */
export class ChaseCamera {
  camera: THREE.PerspectiveCamera;
  mode = 0;
  /** ground direction of "up" on the screen (camera-relative controls use it) */
  private fwd = new THREE.Vector3(1, 0, 0);
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private yaw = 0;
  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.3, 2000);
  }
  forward() {
    return this.fwd.clone();
  }
  follow(target: THREE.Vector3, ball: THREE.Vector3, attackDir: number, dt: number, snap = false) {
    const dir = attackDir >= 0 ? 1 : -1;
    let wantPos: THREE.Vector3, wantLook: THREE.Vector3;
    const spread = Math.min(26, Math.hypot(ball.x - target.x, ball.z - target.z));
    // what we keep in shot: mostly the player, pulled towards the ball
    const focus = target.clone().lerp(ball.clone().setY(0), spread > 1 ? 0.45 : 0);
    focus.y = 0;
    if (this.mode === 1) {
      // side TV view: attack to the right
      const side = dir; // camera on the +z side when attacking +x, so +x is screen right
      // inside the hall, just under the roof by the glass
      wantPos = new THREE.Vector3(focus.x * 0.85, 8.4, side * (ARENA.width / 2 - 0.6));
      wantLook = new THREE.Vector3(focus.x, 0, focus.z * 0.5 - side * 3);
      this.camera.fov = 62;
      this.fwd.set(0, 0, -side); // screen up = away from the camera
    } else if (this.mode === 2) {
      // close chase behind the player, turning gently towards the ball
      const base = dir > 0 ? 0 : Math.PI;
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
      // high behind, fixed direction
      this.fwd.set(dir, 0, 0);
      // stays under the roof (9 m): zoom out by going further back instead of higher
      const back = 10 + spread * 0.5;
      const up = Math.min(8.4, 7 + spread * 0.12);
      wantPos = focus.clone().addScaledVector(this.fwd, -back).setY(up);
      wantPos.z = focus.z * 0.75; // a little less sideways swing than the play
      wantLook = focus.clone().addScaledVector(this.fwd, 3.5).setY(0.6);
      this.camera.fov = 52;
    }
    this.camera.updateProjectionMatrix();
    this.pos.lerp(wantPos, snap ? 1 : 1 - Math.exp(-dt * 4));
    this.look.lerp(wantLook, snap ? 1 : 1 - Math.exp(-dt * 6));
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}

export class PartyRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  cam: ChaseCamera;
  composer: EffectComposer | null = null;
  actors: DudeActor[] = [];
  nets: GoalNet[];
  ballMesh: THREE.Mesh;
  ballShadow: THREE.Mesh;
  particles = new Particles(1400);
  arena: Arena;
  marker: THREE.Mesh;
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

    if (!low) {
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      const c = new EffectComposer(r, rt);
      c.addPass(new RenderPass(this.scene, this.cam.camera));
      c.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), quality === 'high' ? 0.35 : 0.25, 0.5, 0.85));
      c.addPass(new OutputPass());
      this.composer = c;
    }

    this.arena = new Arena(w.teams.map((t) => t.info));
    this.scene.add(this.arena.group);
    this.nets = [new GoalNet(ARENA, -1, w.ballR), new GoalNet(ARENA, 1, w.ballR)];
    for (const n of this.nets) this.scene.add(n.mesh);

    this.ballMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), new THREE.MeshPhysicalMaterial({ map: ballTexture(), roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.2 }));
    this.ballMesh.castShadow = true;
    this.scene.add(this.ballMesh);
    // soft blob under the ball: tells you where it will land
    const sc = document.createElement('canvas');
    sc.width = sc.height = 64;
    const g = sc.getContext('2d')!;
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, 'rgba(40,0,80,0.55)');
    gr.addColorStop(1, 'rgba(40,0,80,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    this.ballShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);
    this.scene.add(this.particles.mesh);

    const blobTex = (this.ballShadow.material as THREE.MeshBasicMaterial).map;
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
    }
    // ring under your player
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 40), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85, depthWrite: false }));
    this.marker.rotation.x = -Math.PI / 2;
    this.scene.add(this.marker);
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
    const arrowGeo = new THREE.ConeGeometry(0.17, 0.32, 3);
    arrowGeo.rotateX(Math.PI);
    const arrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xffd23f }));
    const arrowOut = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0x1b1030, side: THREE.BackSide }));
    arrowOut.scale.setScalar(1.25);
    this.crown.add(arrow, arrowOut);
    this.scene.add(this.crown);
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
      }
      if (e.type === 'post') this.arena.hype = Math.max(this.arena.hype, 0.5);
    }
  }

  draw(dt: number) {
    this.time += dt;
    const w = this.w;
    const bp = w.ballPos();
    this.actors.forEach((a, i) => {
      const p = a.bro.body.translation();
      const blob = this.blobs[i];
      const hgt = Math.max(0, p.y - 0.76);
      blob.position.set(p.x, 0.025, p.z);
      blob.scale.setScalar(1.1 + hgt * 0.3);
      (blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0.15, 0.55 - hgt * 0.2);
    });
    for (const a of this.actors) {
      const g = a.bro.grabbing;
      a.update(dt, this.time, bp, g ? g.position() : null);
    }
    const br = w.ball.rotation();
    this.ballMesh.position.copy(bp);
    this.ballMesh.quaternion.set(br.x, br.y, br.z, br.w);
    this.ballMesh.scale.setScalar(w.ballR);
    const hgt = Math.max(0, bp.y - w.ballR);
    const s = w.ballR * 2.4 * (1 + hgt * 0.12);
    this.ballShadow.scale.set(s, s, 1);
    this.ballShadow.position.set(bp.x, 0.03, bp.z);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.35, 1 - hgt * 0.06);
    for (const n of this.nets) {
      n.ballRadius = w.ballR;
      n.update(dt, bp, this.time);
    }
    this.particles.update(dt);
    this.arena.update(dt, this.time, w.sweeper);
    const c = w.controlled;
    this.marker.visible = !!c;
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
    const focus = c ? c.position() : bp.clone();
    this.crown.visible = !!c;
    if (c) {
      this.marker.position.set(focus.x, 0.04, focus.z);
      this.marker.scale.setScalar(1 + Math.sin(this.time * 5) * 0.06);
      // the crown flies over to the player you switched to
      const want = focus.clone().add(new THREE.Vector3(0, 1.45 + Math.sin(this.time * 5) * 0.06, 0));
      if (this.crownPos.lengthSq() === 0) this.crownPos.copy(want);
      this.crownPos.lerp(want, 1 - Math.exp(-dt * 12));
      this.crown.position.copy(this.crownPos);
      this.crown.rotation.y += dt * 1.5;
    }
    const attack = c ? w.teams[c.team].dir : 1;
    if (!c && this.cam.mode === 0) this.cam.mode = 1; // watch mode: TV view
    this.cam.follow(focus, bp, attack, dt, this.first);
    this.first = false;
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
