import * as THREE from 'three';
import { FieldDims } from '../sim/config';

/**
 * Broadcast camera on the +z touchline looking towards -z (screen right = +x).
 * Replay camera: cinematic angles around the goal.
 */

/** TV-style presets: a high gantry camera on the near touchline that pans with play. */
export const CAMERA_PRESETS = [
  { id: 'tv', name: 'Трансляция', height: 30, back: 26, fov: 30, lead: 0.3, follow: 0.82 },
  { id: 'tvclose', name: 'Трансляция (ближе)', height: 22, back: 17, fov: 31, lead: 0.3, follow: 0.88 },
  { id: 'high', name: 'Высокая', height: 46, back: 18, fov: 32, lead: 0.25, follow: 0.85 },
  { id: 'pro', name: 'Низкая', height: 13, back: 14, fov: 38, lead: 0.3, follow: 0.92 },
];

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  preset = 0;
  private look = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private shake = 0;
  replayAngle = 0;

  constructor(public f: FieldDims, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(30, aspect, 0.5, 2000);
    this.camera.position.set(0, 20, 40);
    this.camera.lookAt(0, 0, 0);
  }

  cycle() {
    this.preset = (this.preset + 1) % CAMERA_PRESETS.length;
    return CAMERA_PRESETS[this.preset].name;
  }

  setPreset(id: string) {
    const i = CAMERA_PRESETS.findIndex((p) => p.id === id);
    if (i >= 0) this.preset = i;
  }

  kick(amount: number) {
    this.shake = Math.max(this.shake, amount);
  }

  /** Smoothly follow `focus` (ball, blended with the controlled player). */
  follow(focus: THREE.Vector3, ballVel: THREE.Vector3, dt: number, snap = false) {
    const pr = CAMERA_PRESETS[this.preset];
    const f = this.f;
    const small = f.length < 80 ? 0.78 : 1;
    const lx = Math.max(-f.length / 2 + 8, Math.min(f.length / 2 - 8, focus.x + ballVel.x * pr.lead));
    const lz = Math.max(-f.width / 2 + 6, Math.min(f.width / 2 - 6, focus.z * 0.7));
    const wantLook = new THREE.Vector3(lx, 0, lz);
    const wantPos = new THREE.Vector3(lx * pr.follow, pr.height * small, f.width / 2 + pr.back * small + lz * 0.15);
    const k = snap ? 1 : 1 - Math.exp(-dt * 3.2);
    const kp = snap ? 1 : 1 - Math.exp(-dt * 2.4);
    this.look.lerp(wantLook, k);
    this.pos.lerp(wantPos, kp);
    this.camera.fov += (pr.fov - this.camera.fov) * kp;
    this.camera.updateProjectionMatrix();
    this.apply(dt);
  }

  /** Cinematic replay camera near the goal the ball is heading to. */
  replay(ball: THREE.Vector3, goalX: number, dt: number, snap: boolean) {
    const f = this.f;
    const dir = Math.sign(goalX) || 1;
    let wantPos: THREE.Vector3;
    if (this.replayAngle === 0) {
      // behind the goal, elevated, looking back up the pitch
      wantPos = new THREE.Vector3(goalX + dir * 13, 6.5, ball.z * 0.4 + 6);
    } else {
      // low, beside the post: the best view of the net bulging
      const side = ball.z > 0 ? -1 : 1;
      wantPos = new THREE.Vector3(goalX + dir * 0.6, 1.5, side * (f.goalHalfW + 6.5));
    }
    const wantLook = ball.clone();
    wantLook.y = Math.max(0.6, wantLook.y);
    const k = snap ? 1 : 1 - Math.exp(-dt * 4);
    this.look.lerp(wantLook, k);
    this.pos.lerp(wantPos, snap ? 1 : 1 - Math.exp(-dt * 1.5));
    this.camera.fov += (34 - this.camera.fov) * (snap ? 1 : k);
    this.camera.updateProjectionMatrix();
    this.apply(dt);
  }

  private apply(dt: number) {
    this.camera.position.copy(this.pos);
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.exp(-dt * 8);
    }
    this.camera.lookAt(this.look);
  }
}
