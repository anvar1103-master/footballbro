import * as THREE from 'three';
import type { Match, GameEvent } from '../sim/match';
import { BallView } from './ball';
import { CameraRig } from './camera';
import { Particles } from './effects';
import { GoalNet } from './net';
import { PlayerActor } from './players';
import { Stadium, makeSky } from './stadium';
import type { FrameView } from './view';

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
  time = 0;

  private firstFrame = true;

  constructor(public container: HTMLElement, public match: Match, lowQuality = false) {
    const r = new THREE.WebGLRenderer({ antialias: !lowQuality, powerPreference: 'high-performance' });
    r.setPixelRatio(lowQuality ? 1 : Math.min(window.devicePixelRatio, 2));
    r.setSize(container.clientWidth, container.clientHeight);
    r.shadowMap.enabled = !lowQuality;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    this.renderer = r;

    const f = match.field;
    this.rig = new CameraRig(f, container.clientWidth / container.clientHeight);
    this.scene.fog = new THREE.Fog(0xcfe8ff, 220, 650);
    this.scene.add(makeSky());

    const hemi = new THREE.HemisphereLight(0xdff0ff, 0x3f7a3a, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0d6, 2.4);
    sun.position.set(-35, 80, 45);
    sun.castShadow = true;
    const ext = Math.max(f.length, f.width) / 2 + 12;
    sun.shadow.camera.left = -ext;
    sun.shadow.camera.right = ext;
    sun.shadow.camera.top = ext;
    sun.shadow.camera.bottom = -ext;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 220;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.stadium = new Stadium(f, match.teams.map((t) => t.info), 0);
    this.scene.add(this.stadium.group);
    this.nets = [new GoalNet(f, -1), new GoalNet(f, 1)];
    for (const n of this.nets) this.scene.add(n.lines);
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
    this.markerRing = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 32), ringMat);
    this.markerRing.rotation.x = -Math.PI / 2;
    this.markerRing.position.y = 0.03;
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.5, 4), new THREE.MeshBasicMaterial({ color: 0xffe14d }));
    arrow.rotation.x = Math.PI;
    arrow.position.y = 2.6;
    arrow.name = 'arrow';
    this.marker.add(this.markerRing, arrow);
    this.scene.add(this.marker);

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
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
  draw(frame: FrameView, dt: number, opts: { replay: boolean; controlledId: number; snap?: boolean; goalX?: number; focus?: THREE.Vector3 }) {
    this.time += dt;
    for (const pv of frame.players) this.actors.get(pv.id)?.update(pv, dt);
    this.ball.update(frame.ball, frame.ballVel, frame.ballSpin, dt, this.rig.camera);
    for (const n of this.nets) n.update(dt, this.ball.mesh.position, this.time);
    this.particles.update(dt);
    this.stadium.update(dt, this.time);

    const ctrl = frame.players.find((p) => p.id === opts.controlledId);
    this.marker.visible = !!ctrl && !opts.replay;
    if (ctrl) {
      this.marker.position.set(ctrl.x, 0, ctrl.z);
      const arrow = this.marker.getObjectByName('arrow')!;
      arrow.position.y = 2.55 + Math.sin(this.time * 5) * 0.12;
      arrow.rotation.y += dt * 2;
    }
    const snap = !!opts.snap || this.firstFrame;
    this.firstFrame = false;
    if (opts.replay) this.rig.replay(frame.ball, opts.goalX ?? 0, dt, snap);
    else this.rig.follow(opts.focus ?? frame.ball, frame.ballVel, dt, snap);
    this.renderer.render(this.scene, this.rig.camera);
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
