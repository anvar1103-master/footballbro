import { Vector3 } from 'three';
import { Ball } from '../sim/ball';
import { BALL, FieldDims, SIM_DT } from '../sim/config';

/**
 * Kick solvers for Golazo. They aim by running the real ball integrator, so the curl, dip and
 * drag of the actual flight match the preview line exactly. Unlike the old solvers they work in
 * any direction: the target is crossed on the plane through it perpendicular to the kick.
 */

export interface Kick {
  vel: Vector3;
  spin: Vector3;
}

let probe: Ball | null = null;
function getProbe(field: FieldDims) {
  if (!probe || probe.field !== field) probe = new Ball(field, true);
  return probe;
}

export function makeKick(speed: number, yaw: number, pitch: number, sideSpin: number, topSpin: number): Kick {
  const ch = Math.cos(pitch);
  const vel = new Vector3(Math.cos(yaw) * ch, Math.sin(pitch), Math.sin(yaw) * ch).multiplyScalar(speed);
  const hx = Math.cos(yaw);
  const hz = Math.sin(yaw);
  // topspin axis = up x horizontal direction (positive -> ball dips)
  const spin = new Vector3(hz * topSpin, sideSpin, -hx * topSpin);
  return { vel, spin };
}

/**
 * Fly until the ball crosses the plane through `target` with normal `n` (horizontal).
 * Returns the lateral / vertical miss in that plane, or null if it never gets there.
 */
function crossing(field: FieldDims, from: Vector3, k: Kick, target: Vector3, nx: number, nz: number, maxT = 4) {
  const b = getProbe(field);
  b.place(from.x, from.z, from.y);
  b.vel.copy(k.vel);
  b.spin.copy(k.spin);
  const plane = (p: Vector3) => (p.x - target.x) * nx + (p.z - target.z) * nz;
  let prev = b.pos.clone();
  let s0 = plane(prev);
  let t = 0;
  let bounced = false;
  while (t < maxT) {
    b.step(SIM_DT);
    t += SIM_DT;
    if (t > 0.05 && b.pos.y <= BALL.radius + 0.005) bounced = true;
    const s1 = plane(b.pos);
    if (s0 < 0 && s1 >= 0) {
      const a = -s0 / (s1 - s0 || 1e-6);
      const x = prev.x + (b.pos.x - prev.x) * a;
      const y = prev.y + (b.pos.y - prev.y) * a;
      const z = prev.z + (b.pos.z - prev.z) * a;
      // lateral axis = up x n
      const lat = (x - target.x) * -nz + (z - target.z) * nx;
      return { lat, y, t: t - SIM_DT * (1 - a), bounced };
    }
    if (b.vel.lengthSq() < 0.25) return null;
    prev.copy(b.pos);
    s0 = s1;
  }
  return null;
}

/** Driven ball (shot, volley, header, driven pass) through `target` at `speed` with the given spin. */
export function solveThrough(field: FieldDims, from: Vector3, target: Vector3, speed: number, sideSpin: number, topSpin = 0, plane?: { x: number; z: number }): Kick {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dist = Math.max(0.5, Math.hypot(dx, dz));
  // crossing plane: given (e.g. the goal line for shots) or perpendicular to the kick
  const usePlane = plane && Math.abs(plane.x * dx + plane.z * dz) / dist > 0.35;
  const nx = usePlane ? plane!.x : dx / dist, nz = usePlane ? plane!.z : dz / dist;
  const yaw0 = Math.atan2(dz, dx);
  let yaw = yaw0;
  // low-angle ballistic estimate, inflated for drag
  let pitch = Math.atan2(target.y - from.y, dist) + Math.min(0.5, (1.45 * 9.81 * dist) / (2 * speed * speed));
  const err = (yw: number, pt: number) => {
    const c = crossing(field, from, makeKick(speed, yw, pt, sideSpin, topSpin), target, nx, nz);
    if (!c) return null;
    return { el: -c.lat, ey: target.y - c.y, bounced: c.bounced };
  };
  const eps = 0.003;
  const wantsAir = target.y > BALL.radius + 0.3;
  for (let i = 0; i < 12; i++) {
    const e0 = err(yaw, pitch);
    if (!e0 || (wantsAir && e0.bounced && pitch < 0.9)) {
      pitch += 0.04;
      continue;
    }
    if (Math.abs(e0.el) < 0.02 && Math.abs(e0.ey) < 0.02) break;
    const e1 = err(yaw + eps, pitch);
    const e2 = err(yaw, pitch + eps);
    if (!e1 || !e2 || (wantsAir && (e1.bounced || e2.bounced))) {
      // a bounce just before the target spoils the gradient: lift it
      pitch += 0.03;
      continue;
    }
    // Jacobian of (lateral, vertical) wrt (yaw, pitch); lateral grows with yaw (left-handed: +yaw = +z)
    const a = (e1.el - e0.el) / eps, b = (e2.el - e0.el) / eps;
    const c = (e1.ey - e0.ey) / eps, d = (e2.ey - e0.ey) / eps;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-7) {
      pitch += 0.03;
      continue;
    }
    let dyaw = (-e0.el * d + e0.ey * b) / det;
    let dp = (-e0.ey * a + e0.el * c) / det;
    dyaw = Math.max(-0.3, Math.min(0.3, dyaw));
    dp = Math.max(-0.2, Math.min(0.2, dp));
    yaw += dyaw;
    pitch = Math.max(-0.15, Math.min(1.25, pitch + dp));
    // keep the solution sane (the kick must still go roughly at the target)
    if (Math.abs(yaw - yaw0) > 1.0) yaw = yaw0 + Math.sign(yaw - yaw0) * 1.0;
  }
  return makeKick(speed, yaw, pitch, sideSpin, topSpin);
}

/**
 * Lofted ball (chip, lob pass, cross) launched at `pitch` that passes through `target`
 * (target.y = ball radius → lands there; higher → arrives at that height, e.g. a header).
 * Newton on (yaw, speed).
 */
export function solveLofted(field: FieldDims, from: Vector3, target: Vector3, pitch: number, sideSpin = 0, backSpin = 12): Kick {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dist = Math.max(0.5, Math.hypot(dx, dz));
  const nx = dx / dist, nz = dz / dist;
  const yaw0 = Math.atan2(dz, dx);
  let yaw = yaw0;
  // vacuum estimate for the speed
  const h = target.y - from.y;
  const tp = Math.tan(pitch);
  const den = 2 * Math.cos(pitch) ** 2 * (dist * tp - h);
  let speed = den > 0.1 ? Math.sqrt((9.81 * dist * dist) / den) * 1.06 : 14;
  speed = Math.max(4, Math.min(36, speed));
  const fly = (yw: number, sp: number) => {
    const c = crossing(field, from, makeKick(sp, yw, pitch, sideSpin, -backSpin), target, nx, nz, 6);
    return c ? { el: -c.lat, ey: target.y - c.y } : null;
  };
  for (let i = 0; i < 14; i++) {
    const e0 = fly(yaw, speed);
    if (!e0) {
      speed *= 1.15;
      continue;
    }
    if (Math.abs(e0.el) < 0.03 && Math.abs(e0.ey) < 0.03) break;
    const e1 = fly(yaw + 0.003, speed);
    const e2 = fly(yaw, speed + 0.05);
    if (!e1 || !e2) {
      speed *= 1.08;
      continue;
    }
    const a = (e1.el - e0.el) / 0.003, b = (e2.el - e0.el) / 0.05;
    const c = (e1.ey - e0.ey) / 0.003, d = (e2.ey - e0.ey) / 0.05;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-7) {
      speed *= 1.05;
      continue;
    }
    const dyaw = Math.max(-0.3, Math.min(0.3, (-e0.el * d + e0.ey * b) / det));
    const ds = Math.max(-4, Math.min(4, (-e0.ey * a + e0.el * c) / det));
    yaw += dyaw;
    speed = Math.max(3, Math.min(38, speed + ds));
    if (Math.abs(yaw - yaw0) > 1.0) yaw = yaw0 + Math.sign(yaw - yaw0) * 1.0;
  }
  return makeKick(speed, yaw, pitch, sideSpin, -backSpin);
}

/** Distance a ball rolls from speed v0 until it slows to vEnd (1D model incl. drag). */
function rollDistance(v0: number, vEnd: number) {
  let v = v0;
  let d = 0;
  const h = 1 / 120;
  let guard = 0;
  while (v > vEnd && guard++ < 20000) {
    const a = BALL.rollC + BALL.rollLin * v + BALL.dragK * v * v;
    d += v * h;
    v -= a * h;
  }
  return d;
}

/** Kick speed for a ground ball that covers `dist` and still has speed `arrive` there. */
export function groundSpeed(dist: number, arrive: number) {
  let lo = arrive + 0.5, hi = 34;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (rollDistance(mid, arrive) < dist) lo = mid;
    else hi = mid;
  }
  return Math.min(32, (lo + hi) / 2);
}

/** Time a ground ball kicked at v0 needs to roll `dist`. */
export function rollTime(v0: number, dist: number) {
  let v = v0, d = 0, t = 0;
  const h = 1 / 120;
  while (d < dist && v > 0.2 && t < 10) {
    d += v * h;
    v -= (BALL.rollC + BALL.rollLin * v + BALL.dragK * v * v) * h;
    t += h;
  }
  return d >= dist ? t : Infinity;
}

/** Firm ground pass: arrives at `target` with speed `arrive` (never slower than a crisp pass). */
export function solveGround(from: Vector3, target: Vector3, arrive = 7): Kick {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dist = Math.max(0.3, Math.hypot(dx, dz));
  const s = groundSpeed(dist, arrive);
  return { vel: new Vector3(dx / dist, 0, dz / dist).multiplyScalar(s), spin: new Vector3(dz / dist, 0, -dx / dist).multiplyScalar(s / BALL.radius) };
}
