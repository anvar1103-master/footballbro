import * as THREE from 'three';
import type { Match, GameEvent } from '../sim/match';
import { BallView } from './ball';
import { CameraRig } from './camera';
import { Particles } from './effects';
import { GoalNet } from './net';
import { PlayerActor } from './players';
import { Stadium, makeSky } from './stadium';
import type { FrameView } from './view';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Quality } from '../settings';

/** Owns the three.js scene and draws FrameViews (live or replay). */
export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  rig: CameraRig;
  stadium: Stadium;
  nets: GoalNet[];
  ball = new BallView();
  actors = new Map<number, PlayerActor>();
  particles = new Particles();
  marker: THREE.Group;
  private markerRing: THREE.Mesh;
  private switchMarker: THREE.Mesh;
  time = 0;

  private firstFrame = true;

  composer: EffectComposer | null = null;

  constructor(public container: HTMLElement, public match: Match, public quality: Quality = 'high') {
    const low = quality === 'low';
    const r = new THREE.WebGLRenderer({ antialias: low, powerPreference: 'high-performance' });
    r.setPixelRatio(quality === 'high' ? Math.min(window.devicePixelRatio, 2) : 1);
    r.setSize(container.clientWidth, container.clientHeight);
    r.shadowMap.enabled = !low;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.88;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    this.renderer = r;

    const f = match.field;
    this.rig = new CameraRig(f, container.clientWidth / container.clientHeight);
    this.scene.fog = new THREE.Fog(0xc9def0, 260, 700);
    this.scene.add(makeSky());

    // image based ambient light: soft, colourful reflections on kits, posts and the ball
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(0xe4f1ff, 0x3d6a32, 0.55);
    this.scene.add(hemi);
    // late-afternoon sun: warm, low enough for long readable shadows
    const sun = new THREE.DirectionalLight(0xffe2bd, 2.6);
    sun.position.set(-55, 70, 60);
    sun.castShadow = true;
    const ext = Math.max(f.length, f.width) / 2 + 14;
    sun.shadow.camera.left = -ext;
    sun.shadow.camera.right = ext;
    sun.shadow.camera.top = ext;
    sun.shadow.camera.bottom = -ext;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 260;
    sun.shadow.mapSize.set(quality === 'high' ? 4096 : 2048, quality === 'high' ? 4096 : 2048);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    this.scene.add(sun);
    this.scene.add(sun.target);

    if (!low) {
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      const composer = new EffectComposer(r, rt);
      composer.addPass(new RenderPass(this.scene, this.rig.camera));
      if (quality === 'high') composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.22, 0.5, 0.92));
      composer.addPass(new OutputPass());
      this.composer = composer;
    }

    this.stadium = new Stadium(f, match.teams.map((t) => t.info), 0);
    this.scene.add(this.stadium.group);
    this.nets = [new GoalNet(f, -1), new GoalNet(f, 1)];
    for (const n of this.nets) this.scene.add(n.mesh);
    this.scene.add(this.ball.mesh, this.ball.shadow, this.ball.trail);
    this.scene.add(this.particles.mesh);

    for (const p of match.players) {
      const t = match.teams[p.team];
      const a = new PlayerActor(
        { id: p.id, team: p.team, model: p.model, role: p.role, x: p.pos.x, z: p.pos.z, fx: 1, fz: 0, anim: 'idle', speed: 0, actionT: 0, actionDur: 0, diveH: 0, diveSide: 0 },
        t.info,
        p.team,
        match.teams[1 - p.team].info,
      );
      this.actors.set(p.id, a);
      this.scene.add(a.root);
    }

    // controlled-player marker: ring + floating arrow
    this.marker = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9, depthWrite: false });
    this.markerRing = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.64, 32), ringMat);
    this.markerRing.rotation.x = -Math.PI / 2;
    this.markerRing.position.y = 0.03;
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.42, 3), new THREE.MeshBasicMaterial({ color: 0xffe14d }));
    arrow.rotation.x = Math.PI;
    arrow.position.y = 2.6;
    arrow.name = 'arrow';
    this.marker.add(this.markerRing, arrow);
    this.scene.add(this.marker);
    // next switch candidate: small pale triangle
    this.switchMarker = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.32, 3), new THREE.MeshBasicMaterial({ color: 0x9fd8ff }));
    this.switchMarker.rotation.x = Math.PI;
    this.scene.add(this.switchMarker);

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  handleEvents(events: GameEvent[]) {
    for (const e of events) {
      switch (e.type) {
        case 'kick':
          if (e.pos && (e.strength ?? 0) > 6) this.particles.grass(e.pos, (e.strength ?? 0) * 0.5);
          if (e.kind === 'finesse' || (e.strength ?? 0) > 24) this.ball.boostTrail(1);
          else if ((e.strength ?? 0) > 17) this.ball.boostTrail(0.5);
          if (e.kind === 'shot' || e.kind === 'finesse') this.stadium.hype(0.25);
          break;
        case 'tackle':
          if (e.pos) this.particles.grass(e.pos, 8);
          break;
        case 'goal': {
          this.stadium.hype(1);
          const team = this.match.teams[e.team ?? 0].info;
          this.particles.confetti(e.pos ?? new THREE.Vector3(), [team.primary, team.secondary, '#ffd60a', '#ffffff']);
          this.rig.kick(0.4);
          break;
        }
        case 'post':
          this.rig.kick(0.25);
          this.stadium.hype(0.35);
          break;
        case 'save':
          this.stadium.hype(0.4);
          break;
      }
    }
  }

  /** Draw a frame. In replay mode the camera is cinematic and the marker hidden. */
  draw(frame: FrameView, dt: number, opts: { replay: boolean; controlledId: number; switchId?: number; snap?: boolean; goalX?: number; focus?: THREE.Vector3 }) {
    this.time += dt;
    for (const pv of frame.players) this.actors.get(pv.id)?.update(pv, dt);
    this.ball.update(frame.ball, frame.ballVel, frame.ballSpin, dt, this.rig.camera);
    for (const n of this.nets) n.update(dt, this.ball.mesh.position, this.time);
    this.particles.update(dt);
    this.stadium.update(dt, this.time);

    const sw = frame.players.find((p) => p.id === opts.switchId);
    this.switchMarker.visible = !!sw && !opts.replay;
    if (sw) this.switchMarker.position.set(sw.x, 2.25 + Math.sin(this.time * 4) * 0.06, sw.z);
    const ctrl = frame.players.find((p) => p.id === opts.controlledId);
    this.marker.visible = !!ctrl && !opts.replay;
    if (ctrl) {
      this.marker.position.set(ctrl.x, 0, ctrl.z);
      const arrow = this.marker.getObjectByName('arrow')!;
      arrow.position.y = 2.15 + Math.sin(this.time * 5) * 0.1;
      arrow.rotation.y += dt * 2;
    }
    const snap = !!opts.snap || this.firstFrame;
    this.firstFrame = false;
    if (opts.replay) this.rig.replay(frame.ball, opts.goalX ?? 0, dt, snap);
    else this.rig.follow(opts.focus ?? frame.ball, frame.ballVel, dt, snap);
    this.render();
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.rig.camera);
  }

  /** world -> screen pixels (for HUD widgets) */
  project(p: THREE.Vector3) {
    const v = p.clone().project(this.rig.camera);
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight, visible: v.z < 1 };
  }

  dispose() {
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
