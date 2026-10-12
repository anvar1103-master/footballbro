import { Vector3 } from 'three';
import { BALL, FieldDims } from './config';

export type BallEventType = 'bounce' | 'post' | 'net';
export interface BallEvent {
  type: BallEventType;
  pos: Vector3;
  strength: number;
}

const _a = new Vector3();
const _t = new Vector3();
const _c = new Vector3();
const _n = new Vector3();

/**
 * Ball rigid body: gravity, quadratic drag, Magnus force (spin x velocity), bounce with
 * spin/slip friction, rolling resistance, goal-frame collisions and a soft goal net.
 * `simple` balls (used by the kick solver) skip goal frame/net/boards for speed.
 */
export class Ball {
  pos = new Vector3(0, BALL.radius, 0);
  vel = new Vector3();
  /** angular velocity (rad/s) */
  spin = new Vector3();
  /** +1 / -1 when the ball has entered the goal at x = ±length/2 through the mouth, else 0 */
  inGoal = 0;
  netContact = false;
  /** frozen in hands (GK, throw-in) — position is driven externally */
  held = false;
  lastTouchTeam = -1;
  lastTouchPlayer = -1;
  /** last kicker, for immunity against instantly re-controlling own kick */
  kickerId = -1;
  kickTime = -999;
  events: BallEvent[] = [];

  constructor(public field: FieldDims, public simple = false) {}

  copyFrom(b: Ball) {
    this.pos.copy(b.pos);
    this.vel.copy(b.vel);
    this.spin.copy(b.spin);
    this.inGoal = b.inGoal;
    this.held = b.held;
  }

  get onGround() {
    return this.pos.y <= BALL.radius + 0.02 && Math.abs(this.vel.y) < 0.6;
  }

  place(x: number, z: number, y = BALL.radius) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.inGoal = 0;
    this.netContact = false;
  }

  step(dt: number) {
    if (this.held) return;
    const speed = this.vel.length();
    const n = Math.min(8, Math.max(1, Math.ceil((speed * dt) / 0.07)));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h);
  }

  private emit(type: BallEventType, strength: number) {
    if (this.simple) return;
    this.events.push({ type, pos: this.pos.clone(), strength });
  }

  private h = 1 / 120;

  private substep(dt: number) {
    this.h = dt;
    const R = BALL.radius;
    const v = this.vel;
    const speed = v.length();
    const grounded = this.pos.y <= R + 0.005 && Math.abs(v.y) < 0.6;

    // --- forces ---
    _a.set(0, -BALL.gravity, 0);
    _a.addScaledVector(v, -BALL.dragK * speed);
    if (!grounded) {
      _t.crossVectors(this.spin, v).multiplyScalar(BALL.magnusK);
      _a.add(_t);
    } else {
      // a little ground curl from leftover sidespin
      _t.set(0, this.spin.y, 0).cross(v).multiplyScalar(BALL.magnusK * 0.12);
      _a.add(_t);
    }
    v.addScaledVector(_a, dt);
    this.pos.addScaledVector(v, dt);

    // --- spin decay ---
    this.spin.multiplyScalar(Math.exp(-(grounded ? 0.5 : BALL.airSpinDecay) * dt));

    // --- ground ---
    if (this.pos.y < R) {
      this.pos.y = R;
      if (v.y < -0.6) {
        const vy = -v.y;
        const e = BALL.restitution * (vy > 12 ? 0.9 : 1);
        v.y = vy * e;
        // slip of contact point = v + w x (-R y)
        const sx = v.x + R * this.spin.z;
        const sz = v.z - R * this.spin.x;
        const slip = Math.hypot(sx, sz);
        if (slip > 1e-4) {
          // hollow sphere: 40% of slip removed from linear velocity, rest to spin; Coulomb-limited
          const f = Math.min(0.4, (0.55 * (1 + e) * vy) / slip);
          v.x -= f * sx;
          v.z -= f * sz;
          this.spin.z -= ((1.5 * f) * sx) / R;
          this.spin.x += ((1.5 * f) * sz) / R;
        }
        this.spin.y *= 0.7;
        if (vy > 2.2) this.emit('bounce', vy);
      } else {
        v.y = 0;
        // rolling
        const hs = Math.hypot(v.x, v.z);
        if (hs > 0) {
          const dec = (BALL.rollC + BALL.rollLin * hs) * dt;
          const k = Math.max(0, hs - dec) / hs;
          v.x *= k;
          v.z *= k;
        }
        this.spin.x = v.z / R;
        this.spin.z = -v.x / R;
        this.spin.y *= Math.exp(-2.5 * dt);
      }
    }

    if (this.simple) return;
    this.goalCollisions(1);
    this.goalCollisions(-1);
    this.boards();
  }

  private boards() {
    const f = this.field;
    const bx = f.length / 2 + f.boardMargin + 1.5;
    const bz = f.width / 2 + f.boardMargin;
    const v = this.vel;
    if (this.pos.y < 1.0) {
      if (Math.abs(this.pos.x) > bx) {
        this.pos.x = Math.sign(this.pos.x) * bx;
        if (v.x * this.pos.x > 0) v.x = -v.x * 0.4;
      }
      if (Math.abs(this.pos.z) > bz) {
        this.pos.z = Math.sign(this.pos.z) * bz;
        if (v.z * this.pos.z > 0) v.z = -v.z * 0.4;
      }
    } else {
      // keep it in the stadium bowl
      const lim = 12;
      if (Math.abs(this.pos.x) > bx + lim && v.x * this.pos.x > 0) v.x *= -0.3;
      if (Math.abs(this.pos.z) > bz + lim && v.z * this.pos.z > 0) v.z *= -0.3;
    }
  }

  private segmentCollide(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    const R = BALL.radius + BALL.postRadius;
    _t.set(bx - ax, by - ay, bz - az);
    const len2 = _t.lengthSq();
    _c.set(this.pos.x - ax, this.pos.y - ay, this.pos.z - az);
    const s = Math.max(0, Math.min(1, _c.dot(_t) / len2));
    _c.set(ax + _t.x * s, ay + _t.y * s, az + _t.z * s);
    _n.subVectors(this.pos, _c);
    const d = _n.length();
    if (d >= R || d < 1e-6) return;
    _n.divideScalar(d);
    this.pos.copy(_c).addScaledVector(_n, R);
    const vn = this.vel.dot(_n);
    if (vn < 0) {
      this.vel.addScaledVector(_n, -(1 + BALL.postRestitution) * vn);
      this.vel.multiplyScalar(0.92);
      this.spin.multiplyScalar(0.5);
      if (-vn > 1.5) this.emit('post', -vn);
    }
  }

  private goalCollisions(dir: number) {
    const f = this.field;
    const x0 = (dir * f.length) / 2;
    const hw = f.goalHalfW;
    const H = f.goalH;
    const p = this.pos;
    // quick reject
    if (Math.abs(p.x - x0) > f.goalDepthBottom + 1.5 || Math.abs(p.z) > hw + 1.5 || p.y > H + 1.5) {
      if (this.inGoal === dir && (p.x - x0) * dir < -BALL.radius) this.inGoal = 0;
      return;
    }
    // frame: posts + crossbar
    this.segmentCollide(x0, 0, -hw, x0, H, -hw);
    this.segmentCollide(x0, 0, hw, x0, H, hw);
    this.segmentCollide(x0, H, -hw, x0, H, hw);

    const u = (p.x - x0) * dir; // depth behind goal line
    if (this.inGoal !== dir) {
      if (u > 0 && u < 0.6 && Math.abs(p.z) < hw && p.y < H) this.inGoal = dir;
    } else if (u < -BALL.radius) {
      this.inGoal = 0;
    }
    this.net(dir, x0, u);
  }

  /** Soft net: overdamped springs on the inside (or outside) faces of the goal. */
  private net(dir: number, x0: number, u: number) {
    const f = this.field;
    const R = BALL.radius;
    const hw = f.goalHalfW + 0.04;
    const H = f.goalH;
    const dt = f.goalDepthTop;
    const db = f.goalDepthBottom;
    const p = this.pos;
    const v = this.vel;
    let contact = false;
    let impact = 0;
    // inward normal of the slanted back panel in (u, y)
    const bl = Math.hypot(H, db - dt);
    const bnu = -H / bl;
    const bny = -(db - dt) / bl;
    const backS = bnu * (u - dt) + bny * (p.y - H); // >0 inside

    const push = (pen: number, nx: number, ny: number, nz: number) => {
      // n is the direction the net pushes the ball (world space)
      const vn = v.x * nx + v.y * ny + v.z * nz;
      const acc = BALL.netK * pen - BALL.netC * vn;
      const k = acc * this.h;
      v.x += nx * k;
      v.y += ny * k;
      v.z += nz * k;
      if (vn < 0) impact = Math.max(impact, -vn);
      contact = true;
    };

    if (this.inGoal === dir) {
      // side panels
      const sideOver = Math.abs(p.z) + R - hw;
      if (sideOver > 0) push(sideOver, 0, 0, -Math.sign(p.z));
      // roof
      if (u < dt + 0.2) {
        const roofOver = p.y + R - H;
        if (roofOver > 0) push(roofOver, 0, -1, 0);
      }
      // back
      const backOver = R - backS;
      if (backOver > 0) push(backOver, bnu * dir, bny, 0);
    } else if (u > -R && u < db + R) {
      // outside of the net (side netting / roof / back from behind)
      const yTopAtU = u <= dt ? H : H * (1 - (u - dt) / (db - dt));
      if (p.y < yTopAtU + R && Math.abs(p.z) > hw - 0.02 && Math.abs(p.z) < hw + R && u > 0.05) {
        push(hw + R - Math.abs(p.z), 0, 0, Math.sign(p.z));
      } else if (Math.abs(p.z) < hw) {
        if (u > 0.1 && u < dt && p.y > H - 0.05 && p.y < H + R) push(H + R - p.y, 0, 1, 0);
        else if (u > dt && backS < 0 && backS > -R) push(R + backS, -bnu * dir, -bny, 0);
      }
    }
    if (contact) {
      // net mesh grabs the ball
      const damp = Math.exp(-3.5 * this.h);
      v.x *= damp;
      v.z *= damp;
      this.spin.multiplyScalar(0.97);
      if (!this.netContact && impact > 2) this.emit('net', impact);
    }
    this.netContact = contact;
  }
}
