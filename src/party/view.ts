import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ballTexture } from '../render/ball';
import { Particles } from '../render/effects';
import { GoalNet } from '../render/net';
import { buildCharacterModel } from '../render/players';
import { Stadium, makeSky } from '../render/stadium';
import type { Quality } from '../settings';
import { Bro, BRO } from './bro';
import { ARENA, BALL_P, PartyEvent, PartyWorld } from './world';

/** Visual scale of the Kenney chibi (0.55 m model -> ~1.35 m bro). */
const MODEL_SCALE = 2.45;

/** One bro on screen: model riding the physics body, limbs animated procedurally. */
class BroActor {
  root = new THREE.Group();
  model: THREE.Object3D;
  bones: Record<string, THREE.Object3D | undefined> = {};
  stars: THREE.Group;
  private flail = Math.random() * 10;

  constructor(public bro: Bro, w: PartyWorld) {
    const t = w.teams[bro.team];
    this.model = buildCharacterModel(bro.model, bro.role === 'GK', t.info, bro.team, w.teams[1 - bro.team].info);
    this.model.scale.setScalar(MODEL_SCALE);
    this.model.position.y = -BRO.centerY;
    this.root.add(this.model);
    for (const n of ['leg-left', 'leg-right', 'arm-left', 'arm-right', 'head', 'torso']) this.bones[n] = this.model.getObjectByName(n);
    // dizzy stars
    this.stars = new THREE.Group();
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffe14d });
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), starMat);
      s.position.set(Math.cos((i / 3) * Math.PI * 2) * 0.35, 0, Math.sin((i / 3) * Math.PI * 2) * 0.35);
      this.stars.add(s);
    }
    this.stars.visible = false;
  }

  update(dt: number, time: number) {
    const b = this.bro;
    const p = b.body.translation();
    const r = b.body.rotation();
    this.root.position.set(p.x, p.y, p.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);
    const B = this.bones;
    const set = (n: string, x: number, y: number, z: number, k = 1) => {
      const bone = B[n];
      if (!bone) return;
      // smooth towards the pose so poses blend
      bone.rotation.x += (x - bone.rotation.x) * Math.min(1, dt * 14 * k);
      bone.rotation.y += (y - bone.rotation.y) * Math.min(1, dt * 14 * k);
      bone.rotation.z += (z - bone.rotation.z) * Math.min(1, dt * 14 * k);
    };
    const sp = b.speed;
    const run = Math.min(1, sp / 6);
    const ph = b.phase;
    this.flail += dt * 17;
    if (b.state === 'down' || b.state === 'dive') {
      // ragdoll-ish flailing
      const f = this.flail;
      const dive = b.state === 'dive';
      set('arm-left', dive ? -2.8 : Math.sin(f) * 1.2 - 0.6, 0, dive ? 0.3 : 1.6 + Math.sin(f * 1.3) * 0.5, 2);
      set('arm-right', dive ? -2.8 : Math.cos(f) * 1.2 - 0.6, 0, dive ? -0.3 : -1.6 - Math.cos(f * 1.1) * 0.5, 2);
      set('leg-left', dive ? 0.5 : Math.sin(f * 0.9) * 0.8, 0, 0.35, 2);
      set('leg-right', dive ? 0.4 : Math.cos(f * 0.8) * 0.8, 0, -0.35, 2);
      set('head', Math.sin(f * 0.7) * 0.3, Math.cos(f * 0.5) * 0.4, 0);
    } else if (!b.grounded) {
      // airborne: arms up, legs tucked
      set('arm-left', -0.3, 0, 2.4);
      set('arm-right', -0.3, 0, -2.4);
      set('leg-left', -0.6, 0, 0.1);
      set('leg-right', 0.3, 0, -0.1);
      set('head', -0.2, 0, 0);
    } else {
      const sw = Math.sin(ph) * (0.25 + 0.75 * run);
      let legR = sw, legL = -sw;
      let armL = sw * 1.1, armR = -sw * 1.1;
      let armLz = 0.15 + run * 0.25, armRz = -0.15 - run * 0.25;
      if (b.kickT >= 0) {
        // big cartoon swing of the right leg
        const k = Math.sin(Math.min(1, b.kickT / 0.4) * Math.PI);
        legR = -1.9 * k + 0.5 * (1 - k);
        armL = -0.8 * k;
        armLz = 1.2 * k;
      } else if (b.charging) {
        legR = 0.8; // wind-up
        armLz = 0.8;
        armRz = -0.8;
      }
      if (b.shoveT >= 0) {
        const k = Math.sin(Math.min(1, b.shoveT / 0.3) * Math.PI);
        armL = -1.5 * k;
        armR = -1.5 * k;
        armLz = 0.2;
        armRz = -0.2;
      }
      set('leg-left', legL, 0, 0);
      set('leg-right', legR, 0, 0, b.kickT >= 0 ? 2.5 : 1);
      set('arm-left', armL, 0, armLz);
      set('arm-right', armR, 0, armRz);
      // head wobbles with body spin
      const w = b.body.angvel();
      set('head', Math.sin(ph * 2) * 0.06 * run - w.x * 0.03, -w.y * 0.06, -w.z * 0.03);
    }
    // stars when dizzy
    this.stars.visible = b.dizzy > 0 && b.state !== 'up';
    if (this.stars.visible) {
      this.stars.position.set(p.x, p.y + 0.9, p.z);
      this.stars.rotation.y = time * 6;
    }
  }
}

class PartyCamera {
  camera: THREE.PerspectiveCamera;
  private look = new THREE.Vector3();
  private pos = new THREE.Vector3();
  zoom = 0;
  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(36, aspect, 0.5, 1500);
  }
  follow(ball: THREE.Vector3, focus: THREE.Vector3, dt: number, snap = false) {
    const f = ARENA;
    // look between the ball and the controlled bro, biased to the ball
    const lx = Math.max(-f.length / 2 + 6, Math.min(f.length / 2 - 6, ball.x * 0.75 + focus.x * 0.25));
    const lz = Math.max(-f.width / 2 + 4, Math.min(f.width / 2 - 4, (ball.z * 0.75 + focus.z * 0.25) * 0.8));
    const wantLook = new THREE.Vector3(lx, 0, lz);
    const h = 19 - this.zoom * 6;
    const back = 15 - this.zoom * 4;
    const wantPos = new THREE.Vector3(lx * 0.85, h, f.width / 2 + back + lz * 0.2);
    const k = snap ? 1 : 1 - Math.exp(-dt * 3);
    this.look.lerp(wantLook, k);
    this.pos.lerp(wantPos, snap ? 1 : 1 - Math.exp(-dt * 2.2));
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}

export class PartyRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  cam: PartyCamera;
  composer: EffectComposer | null = null;
  actors: BroActor[] = [];
  nets: GoalNet[];
  ballMesh: THREE.Mesh;
  ballShadow: THREE.Mesh;
  particles = new Particles();
  stadium: Stadium;
  marker: THREE.Group;
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
    r.toneMappingExposure = 0.9;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    this.renderer = r;
    this.cam = new PartyCamera(container.clientWidth / container.clientHeight);

    this.scene.fog = new THREE.Fog(0xc9def0, 200, 600);
    this.scene.add(makeSky());
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.4;
    pm.dispose();
    this.scene.add(new THREE.HemisphereLight(0xe4f1ff, 0x3d6a32, 0.6));
    const sun = new THREE.DirectionalLight(0xffe2bd, 2.6);
    sun.position.set(-30, 45, 35);
    sun.castShadow = true;
    const ext = ARENA.length / 2 + 6;
    Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 5, far: 150 });
    sun.shadow.mapSize.set(quality === 'high' ? 4096 : 2048, quality === 'high' ? 4096 : 2048);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);

    if (!low) {
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      const c = new EffectComposer(r, rt);
      c.addPass(new RenderPass(this.scene, this.cam.camera));
      if (quality === 'high') c.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.2, 0.5, 0.92));
      c.addPass(new OutputPass());
      this.composer = c;
    }

    this.stadium = new Stadium(ARENA, w.teams.map((t) => t.info), 0);
    this.scene.add(this.stadium.group);
    this.nets = [new GoalNet(ARENA, -1, BALL_P.radius + 0.02), new GoalNet(ARENA, 1, BALL_P.radius + 0.02)];
    for (const n of this.nets) this.scene.add(n.mesh);

    this.ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_P.radius, 32, 16), new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.4 }));
    this.ballMesh.castShadow = true;
    this.scene.add(this.ballMesh);
    const sc = document.createElement('canvas');
    sc.width = sc.height = 64;
    const g = sc.getContext('2d')!;
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.5)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    this.ballShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);
    this.scene.add(this.particles.mesh);

    for (const b of w.bros) {
      const a = new BroActor(b, w);
      this.actors.push(a);
      this.scene.add(a.root, a.stars);
    }
    this.marker = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.66, 32), new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.4, 3), new THREE.MeshBasicMaterial({ color: 0xffe14d }));
    arrow.rotation.x = Math.PI;
    arrow.name = 'arrow';
    this.marker.add(ring, arrow);
    this.scene.add(this.marker);
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
      if (e.type === 'kick' && e.pos) this.particles.grass(e.pos, (e.strength ?? 8) * 0.4);
      if ((e.type === 'bonk' || e.type === 'shove') && e.pos) this.particles.grass(e.pos, 10);
      if (e.type === 'goal') {
        const t = this.w.teams[e.team ?? 0].info;
        this.particles.confetti(e.pos ?? new THREE.Vector3(), [t.primary, t.secondary, '#ffd60a', '#ffffff']);
        this.stadium.hype(1);
      }
      if (e.type === 'post' || e.type === 'save') this.stadium.hype(0.4);
    }
  }

  draw(dt: number) {
    this.time += dt;
    const w = this.w;
    for (const a of this.actors) a.update(dt, this.time);
    const bp = w.ballPos();
    const br = w.ball.rotation();
    this.ballMesh.position.copy(bp);
    this.ballMesh.quaternion.set(br.x, br.y, br.z, br.w);
    const hgt = Math.max(0, bp.y - BALL_P.radius);
    const s = BALL_P.radius * 2.6 * (1 + hgt * 0.2);
    this.ballShadow.scale.set(s, s, 1);
    this.ballShadow.position.set(bp.x, 0.02, bp.z);
    for (const n of this.nets) n.update(dt, bp, this.time);
    this.particles.update(dt);
    this.stadium.update(dt, this.time);
    const c = w.controlled;
    this.marker.visible = !!c;
    const focus = c ? c.position() : bp.clone();
    if (c) {
      this.marker.position.set(focus.x, 0, focus.z);
      const arrow = this.marker.getObjectByName('arrow')!;
      arrow.position.y = 2.0 + Math.sin(this.time * 5) * 0.1;
      arrow.rotation.y += dt * 2;
    }
    this.cam.follow(bp, focus, dt, this.first);
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
