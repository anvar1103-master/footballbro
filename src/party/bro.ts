import { PBody, PWorld } from './phys';
import { Quaternion, Vector3 } from 'three';

/**
 * A wobbly "bro": one dynamic capsule kept upright by an under-damped PD torque
 * (that is what makes it wobble), driven by velocity-matching impulses applied a bit
 * above the centre of mass (so it leans into its run). When knocked hard it loses
 * balance, tumbles as a free rigid body and gets up after a moment.
 * The renderer animates the limbs procedurally on top of the body transform.
 */

export const BRO = {
  radius: 0.32,
  halfHeight: 0.3,
  /** capsule centre height when standing */
  centerY: 0.62,
  mass: 70,
  jog: 5.4,
  sprint: 7.6,
  accel: 22,
  airControl: 0.2,
  uprightKp: 950,
  uprightKd: 95,
  yawKp: 260,
  yawKd: 45,
  jumpSpeed: 5.2,
  kickReach: 1.15,
};

export type BroState = 'up' | 'down' | 'getup' | 'dive';

export interface BroIntent {
  /** desired horizontal direction (world, length <= 1) */
  moveX: number;
  moveZ: number;
  sprint: boolean;
  jump: boolean;
  dive: boolean;
}

const _q = new Quaternion();
const _v = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();
const UP = new Vector3(0, 1, 0);
export let LEAN = 0.3; // how far above the centre of mass the run impulse acts (lean into the run)
export function setLean(v: number) { LEAN = v; }

export class Bro {
  body: PBody;
  state: BroState = 'up';
  stateT = 0;
  /** facing direction we steer to (horizontal unit) */
  face = new Vector3(1, 0, 0);
  intent: BroIntent = { moveX: 0, moveZ: 0, sprint: false, jump: false, dive: false };
  grounded = true;
  jumpCd = 0;
  // actions
  kickT = -1; // >=0 while the kick animation plays
  kickCharge = 0;
  charging: 'kick' | 'pass' | null = null;
  shoveT = -1;
  shoveCd = 0;
  /** seconds since last fall, for "dizzy stars" */
  dizzy = 0;
  stamina = 1;
  /** running phase for the leg animation */
  phase = 0;

  constructor(
    world: PWorld,
    public id: number,
    public team: number,
    public role: 'GK' | 'FIELD',
    public model: number,
    public name: string,
    x: number,
    z: number,
  ) {
    // damping: cannon uses (1 - d)^dt, Rapier-like 0.15 / 1.2 per second
    this.body = world.capsule(BRO.radius, BRO.halfHeight, BRO.mass, x, BRO.centerY + 0.05, z, 0.14, 0.7);
  }

  get pos() {
    const t = this.body.translation();
    return _v.set(t.x, t.y, t.z);
  }
  position(out = new Vector3()) {
    const t = this.body.translation();
    return out.set(t.x, t.y, t.z);
  }
  velocity(out = new Vector3()) {
    const v = this.body.linvel();
    return out.set(v.x, v.y, v.z);
  }
  rotation(out = new Quaternion()) {
    const r = this.body.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }
  /** body up axis in world space */
  upAxis(out = new Vector3()) {
    return out.copy(UP).applyQuaternion(this.rotation(_q));
  }
  /** how upright (1 = standing, 0 = lying) */
  get uprightness() {
    return this.upAxis(_up).y;
  }
  get speed() {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z);
  }
  get canAct() {
    return this.state === 'up';
  }

  teleport(x: number, z: number, faceX: number) {
    this.body.setTranslation({ x, y: BRO.centerY + 0.05, z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const yaw = Math.atan2(faceX, 0);
    _q.setFromAxisAngle(UP, yaw);
    this.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    this.face.set(Math.sign(faceX) || 1, 0, 0);
    this.state = 'up';
    this.stateT = 0;
    this.kickT = -1;
    this.charging = null;
    this.kickCharge = 0;
  }

  /** Lose balance for `t` seconds (tumble). */
  knockDown(t = 1.4, impulse?: Vector3) {
    if (this.state === 'down') {
      this.stateT = Math.min(this.stateT, 0.3);
    } else {
      this.state = 'down';
      this.stateT = 0;
    }
    this.downFor = t;
    this.charging = null;
    this.kickCharge = 0;
    this.dizzy = 2.5;
    if (impulse) this.body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
  }
  downFor = 1.4;

  step(dt: number, world: PWorld) {
    const body = this.body;
    const m = body.mass();
    const p = body.translation();
    const v = body.linvel();
    const w = body.angvel();
    this.stateT += dt;
    this.jumpCd -= dt;
    this.shoveCd -= dt;
    this.dizzy = Math.max(0, this.dizzy - dt);
    if (this.kickT >= 0) {
      this.kickT += dt;
      if (this.kickT > 0.45) this.kickT = -1;
    }
    if (this.shoveT >= 0) {
      this.shoveT += dt;
      if (this.shoveT > 0.35) this.shoveT = -1;
    }

    // ground check: short ray down from the capsule centre
    this.grounded = world.groundBelow(p, BRO.centerY + 0.12);

    const up = this.upAxis(_up);
    // tipping over by itself (pushed, tripped) -> fall
    if (this.state === 'up' && up.y < 0.45) this.knockDown(1.2);

    // ---- balance (PD torque towards world up) ----
    let kp = BRO.uprightKp;
    let kd = BRO.uprightKd;
    if (this.state === 'down' || this.state === 'dive') {
      kp = 0;
      kd = 6;
    } else if (this.state === 'getup') {
      kp *= 2.2;
      kd *= 1.6;
    }
    // axis = up x worldUp: rotating `up` about it moves it towards world up
    const tilt = new Vector3(-up.z, 0, up.x);
    const tl = tilt.length();
    const angle = Math.acos(Math.max(-1, Math.min(1, up.y)));
    if (tl > 1e-5) tilt.multiplyScalar(angle / tl);
    let tx = tilt.x * kp - w.x * kd;
    let tz = tilt.z * kp - w.z * kd;

    // ---- yaw towards facing ----
    let ty = 0;
    if (this.state === 'up' || this.state === 'getup') {
      _fwd.set(0, 0, 1).applyQuaternion(this.rotation(_q));
      const cur = Math.atan2(_fwd.x, _fwd.z);
      const want = Math.atan2(this.face.x, this.face.z);
      let d = want - cur;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      ty = d * BRO.yawKp - w.y * BRO.yawKd;
    }
    body.applyTorqueImpulse({ x: tx * dt, y: ty * dt, z: tz * dt }, true);

    // ---- state machine ----
    if (this.state === 'down' || this.state === 'getup') {
      // body scraping along the grass (stands in for ground friction)
      if (this.grounded) {
        const k = 1 - Math.exp(-2.8 * dt);
        body.applyImpulse({ x: -v.x * m * k, y: 0, z: -v.z * m * k }, true);
      }
    }
    if (this.state === 'down') {
      if (this.stateT > this.downFor && this.speed < 2.5) {
        this.state = 'getup';
        this.stateT = 0;
        body.applyImpulse({ x: 0, y: m * 2.6, z: 0 }, true);
      }
      return;
    }
    if (this.state === 'getup') {
      if (up.y > 0.9 || this.stateT > 1.0) {
        this.state = 'up';
        this.stateT = 0;
      }
      return;
    }
    if (this.state === 'dive') {
      // superman: pitch forward, slide; then lie for a moment
      if (this.stateT > 0.25 && this.grounded) {
        this.state = 'down';
        this.stateT = 0;
        this.downFor = 0.55;
      }
      return;
    }

    // ---- locomotion (state 'up') ----
    const it = this.intent;
    const il = Math.hypot(it.moveX, it.moveZ);
    if (il > 0.15) this.face.set(it.moveX / il, 0, it.moveZ / il);
    const sprinting = it.sprint && this.stamina > 0.05 && il > 0.3;
    const max = (sprinting ? BRO.sprint : BRO.jog) * (this.kickT >= 0 ? 0.55 : 1) * (this.charging ? 0.75 : 1);
    if (sprinting) this.stamina = Math.max(0, this.stamina - 0.12 * dt);
    else this.stamina = Math.min(1, this.stamina + 0.07 * dt);
    const wx = (it.moveX / Math.max(1, il)) * max;
    const wz = (it.moveZ / Math.max(1, il)) * max;
    let dvx = wx - v.x, dvz = wz - v.z;
    const dvl = Math.hypot(dvx, dvz);
    const lim = BRO.accel * dt * (this.grounded ? 1 : BRO.airControl);
    if (dvl > lim) {
      dvx = (dvx / dvl) * lim;
      dvz = (dvz / dvl) * lim;
    }
    // applied above the centre of mass: the bro leans into acceleration (wobble!)
    body.applyImpulseAtPoint({ x: dvx * m, y: 0, z: dvz * m }, { x: p.x, y: p.y + LEAN, z: p.z }, true);
    this.phase += this.speed * dt * 2.1;

    if (it.jump && this.grounded && this.jumpCd <= 0) {
      this.jumpCd = 0.6;
      body.applyImpulse({ x: 0, y: m * BRO.jumpSpeed, z: 0 }, true);
    }
    if (it.dive && this.jumpCd <= 0) {
      this.jumpCd = 1.2;
      this.state = 'dive';
      this.stateT = 0;
      const f = this.face;
      body.applyImpulse({ x: f.x * m * 6.5 - v.x * m * 0.3, y: m * 3.6, z: f.z * m * 6.5 - v.z * m * 0.3 }, true);
      // pitch forward
      const axis = new Vector3(f.z, 0, -f.x); // up x forward: tips the head forward
      body.applyTorqueImpulse({ x: axis.x * 55, y: 0, z: axis.z * 55 }, true);
      this.charging = null;
    }
  }
}
