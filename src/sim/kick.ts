import { Vector3 } from 'three';
import { Ball } from './ball';
import { BALL, FieldDims, SIM_DT } from './config';

/**
 * Kick solvers. They aim by running the real ball integrator (Ball with simple=true),
 * so curl, dip and drag in the actual flight match exactly what the solver predicted.
 */

export interface KickSolution {
  vel: Vector3;
  spin: Vector3;
}

let probe: Ball | null = null;
function getProbe(field: FieldDims) {
  if (!probe || probe.field !== field) probe = new Ball(field, true);
  return probe;
}

function makeKick(speed: number, yaw: number, pitch: number, sideSpin: number, topSpin: number): KickSolution {
  const ch = Math.cos(pitch);
  const vel = new Vector3(Math.cos(yaw) * ch, Math.sin(pitch), Math.sin(yaw) * ch).multiplyScalar(speed);
  // topspin axis = up x horizontal direction (positive -> ball dips)
  const hx = Math.cos(yaw);
  const hz = Math.sin(yaw);
  const spin = new Vector3(hz * topSpin, sideSpin, -hx * topSpin);
  return { vel, spin };
}

/** Fly until the ball crosses plane x = planeX. Returns crossing point (z, y, t) or null. */
function flyToPlane(field: FieldDims, from: Vector3, k: KickSolution, planeX: number, maxT = 3) {
  const b = getProbe(field);
  b.place(from.x, from.z, from.y);
  b.vel.copy(k.vel);
  b.spin.copy(k.spin);
  const side = Math.sign(planeX - from.x) || 1;
  let t = 0;
  let px = b.pos.x, py = b.pos.y, pz = b.pos.z;
  let bounced = false;
  while (t < maxT) {
    b.step(SIM_DT);
    t += SIM_DT;
    if (t > 0.05 && b.pos.y <= BALL.radius + 0.005) bounced = true;
    if ((b.pos.x - planeX) * side >= 0) {
      const a = (planeX - px) / (b.pos.x - px || 1e-6);
      return { z: pz + (b.pos.z - pz) * a, y: py + (b.pos.y - py) * a, t, bounced };
    }
    if (b.vel.lengthSq() < 0.25) return null;
    px = b.pos.x; py = b.pos.y; pz = b.pos.z;
  }
  return null;
}

/**
 * Solve launch direction so the ball passes through `target` (on a plane x = target.x)
 * given speed and spin. Newton iteration with finite differences on (yaw, pitch).
 */
export function solveShot(
  field: FieldDims,
  from: Vector3,
  target: Vector3,
  speed: number,
  sideSpin: number,
  topSpin: number,
): KickSolution {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dist = Math.hypot(dx, dz);
  let yaw = Math.atan2(dz, dx);
  let pitch = Math.atan2(target.y - from.y, dist) + 0.02 + (dist * 0.004 * 25) / Math.max(10, speed);
  const err = (yw: number, pt: number) => {
    const c = flyToPlane(field, from, makeKick(speed, yw, pt, sideSpin, topSpin), target.x);
    if (!c) return null;
    return { ez: target.z - c.z, ey: target.y - c.y, bounced: c.bounced };
  };
  const eps = 0.003;
  const wantsAir = target.y > BALL.radius + 0.25;
  for (let i = 0; i < 10; i++) {
    const e0 = err(yaw, pitch);
    if (!e0 || (wantsAir && e0.bounced)) {
      pitch += 0.04;
      continue;
    }
    if (Math.abs(e0.ez) < 0.03 && Math.abs(e0.ey) < 0.03) break;
    const ey1 = err(yaw + eps, pitch);
    const ep1 = err(yaw, pitch + eps);
    if (!ey1 || !ep1) {
      pitch += 0.03;
      continue;
    }
    // Jacobian of (ez, ey) wrt (yaw, pitch)
    const a = (ey1.ez - e0.ez) / eps, b = (ep1.ez - e0.ez) / eps;
    const c = (ey1.ey - e0.ey) / eps, d = (ep1.ey - e0.ey) / eps;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-6) {
      pitch += 0.03;
      continue;
    }
    let dyaw = (-e0.ez * d + e0.ey * b) / det;
    let dp = (-e0.ey * a + e0.ez * c) / det;
    dyaw = Math.max(-0.3, Math.min(0.3, dyaw));
    dp = Math.max(-0.2, Math.min(0.2, dp));
    yaw += dyaw;
    pitch = Math.max(-0.1, Math.min(1.2, pitch + dp));
  }
  return makeKick(speed, yaw, pitch, sideSpin, topSpin);
}

/** Distance a ball rolls from speed v0 until it slows to vEnd (1D model incl. drag). */
export function rollDistance(v0: number, vEnd: number) {
  let v = v0;
  let d = 0;
  const h = 1 / 60;
  let guard = 0;
  while (v > vEnd && guard++ < 5000) {
    const a = BALL.rollC + BALL.rollLin * v + BALL.dragK * v * v;
    d += v * h;
    v -= a * h;
  }
  return d;
}

/** Ground pass speed so the ball arrives at distance `dist` with speed `arrive`. */
export function groundPassSpeed(dist: number, arrive: number) {
  let lo = arrive + 0.5, hi = 32;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (rollDistance(mid, arrive) < dist) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function solveGroundPass(from: Vector3, target: Vector3, arrive: number): KickSolution {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dist = Math.hypot(dx, dz);
  const s = Math.min(30, groundPassSpeed(dist, arrive));
  const vel = new Vector3(dx / (dist || 1), 0, dz / (dist || 1)).multiplyScalar(s);
  return { vel, spin: new Vector3() };
}

/** Lofted ball (lob, cross, clearance, chip) landing at `target` on its first bounce. */
export function solveLob(field: FieldDims, from: Vector3, target: Vector3, pitch: number, backSpin = 25): KickSolution {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dist = Math.max(1, Math.hypot(dx, dz));
  const yaw = Math.atan2(dz, dx);
  const b = getProbe(field);
  const landDist = (speed: number) => {
    const k = makeKick(speed, yaw, pitch, 0, -backSpin);
    b.place(from.x, from.z, from.y);
    b.vel.copy(k.vel);
    b.spin.copy(k.spin);
    let t = 0;
    let prevVy = b.vel.y;
    while (t < 6) {
      b.step(SIM_DT);
      t += SIM_DT;
      // first bounce: vertical velocity flips from falling to rising (or ball settles)
      if (t > 0.1 && prevVy < 0 && (b.vel.y >= 0 || b.pos.y <= BALL.radius + 0.001)) break;
      prevVy = b.vel.y;
    }
    return Math.hypot(b.pos.x - from.x, b.pos.z - from.z);
  };
  // bisection on speed
  let lo = 3, hi = 36;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (landDist(mid) < dist) lo = mid;
    else hi = mid;
  }
  return makeKick((lo + hi) / 2, yaw, pitch, 0, -backSpin);
}

/** Predict where the ball will be after `t` seconds (no player interaction). */
export function predictBall(src: Ball, t: number, out = new Vector3()) {
  const b = getProbe(src.field);
  b.copyFrom(src);
  b.held = false;
  let tt = 0;
  while (tt < t) {
    b.step(SIM_DT * 2);
    tt += SIM_DT * 2;
  }
  return out.copy(b.pos);
}

/** Sample the future path of the ball (used by GK and interception logic). */
export function predictPath(src: Ball, duration: number, step = 0.05): { t: number; p: Vector3 }[] {
  const b = getProbe(src.field);
  b.copyFrom(src);
  b.held = false;
  const out: { t: number; p: Vector3 }[] = [];
  let t = 0;
  let next = 0;
  while (t <= duration) {
    if (t >= next) {
      out.push({ t, p: b.pos.clone() });
      next += step;
    }
    b.step(SIM_DT * 2);
    t += SIM_DT * 2;
  }
  return out;
}
