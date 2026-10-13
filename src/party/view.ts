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
import { DudeActor, makeCrown } from './dude';
import { ballTexture } from '../render/ball';
import { ARENA, PartyEvent, PartyWorld } from './world';

/** Third-person chase camera behind the human's player, looking down-field (or a TV view). */
export class ChaseCamera {
  camera: THREE.PerspectiveCamera;
  /** 0 = close behind, 1 = high behind, 2 = TV side view */
  mode = 0;
  yaw = 0;
  /** mouse-look: the mouse turns the camera; the crosshair (screen centre) is where you pass/shoot */
  mouseLook = false;
  pitch = 0.28;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.3, 2000);
  }
  /** forward direction on the ground (camera-relative controls use it) */
  forward() {
    return new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }
  /** mouse movement (pixels) */
  turn(dx: number, dy: number) {
    this.yaw += dx * 0.0032;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.0022, 0.02, 0.9);
  }
  follow(target: THREE.Vector3, ball: THREE.Vector3, attackDir: number, dt: number, snap = false) {
    if (this.mouseLook && this.mode < 2) {
      if (snap) this.yaw = attackDir > 0 ? 0 : Math.PI;
      const f = this.forward();
      const dist = this.mode === 0 ? 6.4 : 10.5;
      const wantPos = target.clone().addScaledVector(f, -dist * Math.cos(this.pitch)).setY(1.6 + dist * Math.sin(this.pitch));
      const wantLook = target.clone().addScaledVector(f, 7).setY(1.1);
      this.camera.fov = 58;
      this.camera.updateProjectionMatrix();
      this.pos.lerp(wantPos, snap ? 1 : 1 - Math.exp(-dt * 14));
      this.look.lerp(wantLook, snap ? 1 : 1 - Math.exp(-dt * 16));
      this.camera.position.copy(this.pos);
      this.camera.lookAt(this.look);
      return;
    }
    // base: look towards the goal we attack; lean a bit towards the ball
    const base = attackDir > 0 ? 0 : Math.PI;
    const toBall = Math.atan2(ball.z - target.z, ball.x - target.x);
    let d = toBall - base;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const far = Math.hypot(ball.x - target.x, ball.z - target.z);
    const bias = far > 2.5 ? THREE.MathUtils.clamp(d, -1.3, 1.3) * 0.6 : 0;
    const want = base + bias;
    let dy = want - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += snap ? dy : dy * (1 - Math.exp(-dt * 1.8));
    const f = this.forward();
    let wantPos: THREE.Vector3, wantLook: THREE.Vector3;
    if (this.mode === 2) {
      wantPos = new THREE.Vector3(target.x * 0.7, 26, ARENA.width / 2 + 24);
      wantLook = new THREE.Vector3(target.x * 0.8, 0, target.z * 0.5);
      this.camera.fov = 40;
    } else {
      // ball behind or far to the side: back off and rise so both stay in shot
      const rel = new THREE.Vector3(ball.x - target.x, 0, ball.z - target.z);
      const along = rel.dot(f);
      const side = Math.abs(rel.x * -f.z + rel.z * f.x);
      const extra = Math.min(9, Math.max(0, -along) * 0.8 + Math.max(0, side - 6) * 0.35);
      const back = (this.mode === 0 ? 6.2 : 11) + extra;
      const up = (this.mode === 0 ? 3.3 : 7.5) + extra * 0.6;
      const lift = Math.min(3, Math.max(0, ball.y - 3) * 0.4);
      wantPos = target.clone().addScaledVector(f, -back).setY(up + lift);
      // look between the player and the ball
      const toward = rel.clampLength(0, 9).multiplyScalar(0.4);
      wantLook = target.clone().addScaledVector(f, 3.5).add(toward).setY(1 + lift * 0.5);
      this.camera.fov = 55;
    }
    this.camera.updateProjectionMatrix();
    const k = snap ? 1 : 1 - Math.exp(-dt * 5);
    this.pos.lerp(wantPos, k);
    this.look.lerp(wantLook, snap ? 1 : 1 - Math.exp(-dt * 7));
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
  crown: THREE.Group;
  private crownPos = new THREE.Vector3();
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
    this.scene.background = new THREE.Color('#22262e');
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pm.dispose();
    this.scene.add(new THREE.HemisphereLight(0xf4f1ea, 0x3d6b33, 0.9));
    const sun = new THREE.DirectionalLight(0xfff6e8, 2.3);
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
      if (quality === 'high') c.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.25, 0.6, 0.9));
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
    this.crown = makeCrown();
    this.crown.scale.setScalar(1.3);
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
    this.aimArrow.visible = !!c && this.cam.mouseLook && this.cam.mode < 2 && c.state === 'up';
    if (this.aimArrow.visible) {
      const cp = c!.position();
      this.aimArrow.position.set(cp.x, 0, cp.z);
      this.aimArrow.rotation.y = -this.cam.yaw;
    }
    const focus = c ? c.position() : bp.clone();
    this.crown.visible = !!c;
    if (c) {
      this.marker.position.set(focus.x, 0.04, focus.z);
      this.marker.scale.setScalar(1 + Math.sin(this.time * 5) * 0.06);
      // the crown flies over to the player you switched to
      const want = focus.clone().add(new THREE.Vector3(0, 1.12 + Math.sin(this.time * 3) * 0.05, 0));
      if (this.crownPos.lengthSq() === 0) this.crownPos.copy(want);
      this.crownPos.lerp(want, 1 - Math.exp(-dt * 12));
      this.crown.position.copy(this.crownPos);
      this.crown.rotation.y += dt * 1.5;
    }
    const attack = c ? w.teams[c.team].dir : 1;
    if (!c && this.cam.mode < 2) this.cam.mode = 2;
    this.cam.follow(focus, bp, attack, dt, this.first);
    this.first = false;
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.cam.camera);
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
