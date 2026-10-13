import { Vector3 } from 'three';
import type { PartyWorld } from './world';
import { Bro } from './bro';

/**
 * Clumsy-but-purposeful AI for footballbro.
 * Field players hold formation slots shifted with the ball; per team one bro chases the ball,
 * one covers goal-side when the other team has it. On the ball: shoot in range, pass when
 * pressed, otherwise push it goalwards. Keepers shuffle, dive and clear.
 * Dead balls: everybody walks to their spot; AI takers play the ball after a beat.
 */

interface Mind {
  t: number;
}
const minds = new WeakMap<Bro, Mind>();
function mind(b: Bro) {
  let m = minds.get(b);
  if (!m) {
    m = { t: 0 };
    minds.set(b, m);
  }
  return m;
}
const tmp = new Vector3();

function steerTo(b: Bro, x: number, z: number, sprint: boolean, stopDist = 0.4) {
  const p = b.position(tmp);
  const dx = x - p.x, dz = z - p.z;
  const d = Math.hypot(dx, dz);
  if (d < stopDist) {
    b.intent.moveX = b.intent.moveZ = 0;
    return d;
  }
  const s = Math.min(1, d / 1.5);
  b.intent.moveX = (dx / d) * s;
  b.intent.moveZ = (dz / d) * s;
  b.intent.sprint = sprint && d > 4;
  return d;
}

/** formation slot shifted with the ball (classic-game logic) */
export function formationSpot(w: PartyWorld, b: Bro, out = new Vector3()) {
  const t = w.teams[b.team];
  const f = w.field;
  const dir = t.dir;
  const bp = w.ballPos();
  const bx = (bp.x * dir) / f.length + 0.5;
  const bz = (bp.z * dir) / (f.width / 2);
  const attacking = w.possessionTeam === b.team;
  let x = b.home.x;
  let z = b.home.z;
  if (b.role !== 'GK') {
    x += (bx - 0.5) * (attacking ? 0.7 : 0.6) + (attacking ? 0.06 : -0.03);
    z = attacking ? z * 1.05 + bz * 0.12 : z * 0.75 + bz * 0.3;
    if (!attacking) x = Math.min(x, bx + (b.home.x > 0.5 ? 0.1 : -0.03));
    x = Math.max(0.08, Math.min(0.9, x));
  }
  z = Math.max(-0.92, Math.min(0.92, z));
  return out.set(dir * (x - 0.5) * f.length, 0, z * dir * (f.width / 2) * 0.9);
}

export function think(w: PartyWorld, b: Bro, dt: number) {
  const it = b.intent;
  it.jump = false;
  it.dive = false;
  it.sprint = false;
  mind(b).t -= dt;
  switch (w.phase) {
    case 'goal':
      it.moveX = it.moveZ = 0;
      if (b.team === w.lastGoalTeam && b.canAct && w.rng.chance(dt * 1.5)) it.jump = true; // happy hops
      return;
    case 'halftime':
    case 'over':
      it.moveX = it.moveZ = 0;
      return;
    case 'kickoff':
    case 'setpiece':
      return deadBall(w, b);
  }
  if (!b.canAct) return;
  if (b.role === 'GK') return keeper(w, b);
  field(w, b, dt);
}

// ---------------------------------------------------------------- dead balls
function deadBall(w: PartyWorld, b: Bro) {
  const it = b.intent;
  const sp = w.setPiece;
  if (sp && sp.taker === b) {
    it.moveX = it.moveZ = 0;
    if (w.controlled === b) return;
    // get (back) behind the ball if we were nudged away
    const bp = sp.pos;
    const p = b.position();
    const dBall = Math.hypot(bp.x - p.x, bp.z - p.z);
    if (dBall > 0.95) {
      const behind = bp.clone().addScaledVector(b.face, -0.8);
      steerTo(b, behind.x, behind.z, false, 0.15);
      if (sp.t > 6) b.teleport(behind.x, behind.z, 1, true);
      return;
    }
    const wait = sp.kind === 'kickoff' ? 1.0 : 1.6;
    if (sp.t > wait && b.canAct && mind(b).t <= 0) {
      mind(b).t = 1;
      takeSetPiece(w, b);
    }
    return;
  }
  const s = b.spot ?? (b.role === 'GK' ? new Vector3(w.ownGoalX(b.team) - Math.sign(w.ownGoalX(b.team)) * 1, 0, 0) : formationSpot(w, b));
  steerTo(b, s.x, s.z, b.position().distanceTo(s) > 8, 0.5);
  if (b.position().distanceTo(s) < 1) b.face.set(w.ballPos().x - b.position().x, 0, w.ballPos().z - b.position().z).normalize();
}

function takeSetPiece(w: PartyWorld, b: Bro) {
  const sp = w.setPiece!;
  const f = w.field;
  const gx = w.goalX(b.team);
  const mates = w.teamBros(b.team).filter((q) => q !== b && q.role === 'FIELD');
  const p = b.position();
  const byDist = (a: Bro, c: Bro) => a.position().distanceTo(p) - c.position().distanceTo(p);
  switch (sp.kind) {
    case 'kickoff': {
      const q = mates.sort(byDist)[0];
      b.face.set(q.position().x - p.x, 0, q.position().z - p.z).normalize();
      w.kick(b, 0.3, q.position(), 0, 0, true);
      return;
    }
    case 'throwin': {
      const q = mates.filter((m) => m.position().distanceTo(p) < 22).sort(byDist)[0] ?? mates.sort(byDist)[0];
      b.face.set(q.position().x - p.x, 0, q.position().z - p.z).normalize();
      w.throwBall(b, q.position().addScaledVector(q.velocity(), 0.5));
      return;
    }
    case 'corner': {
      const inBox = mates.filter((m) => Math.abs(m.position().x - gx) < f.boxDepth && Math.abs(m.position().z) < f.boxHalfW);
      const q = inBox.length ? w.rng.pick(inBox) : mates[0];
      const t = q.position();
      b.face.set(t.x - p.x, 0, t.z - p.z).normalize();
      w.kick(b, Math.min(1, t.distanceTo(p) / 32), t, 0.38);
      return;
    }
    case 'goalkick': {
      const fwd = mates.sort((a, c) => (c.home.x - a.home.x));
      const q = w.rng.chance(0.5) ? fwd[0] : w.rng.pick(mates);
      const t = q.position();
      b.face.set(t.x - p.x, 0, t.z - p.z).normalize();
      w.kick(b, Math.min(1, t.distanceTo(p) / 45), t, 0.42);
      return;
    }
    case 'penalty': {
      const side = w.rng.chance(0.5) ? 1 : -1;
      const t = new Vector3(gx, 0, side * (f.goalHalfW - 0.8));
      b.face.set(gx - p.x, 0, -p.z).normalize();
      w.kick(b, 0.6 + w.rng.next() * 0.3, t, 0.08 + w.rng.next() * 0.1);
      return;
    }
    case 'freekick': {
      const dist = Math.hypot(gx - p.x, p.z);
      if (dist < 27) {
        const side = w.rng.chance(0.5) ? 1 : -1;
        const t = new Vector3(gx, 0, side * (f.goalHalfW - 0.8));
        b.face.set(gx - p.x, 0, -p.z).normalize();
        w.kick(b, 0.7, t, 0.2, -side * w.teams[b.team].dir * 0.7);
      } else {
        const q = mates.filter((m) => (m.position().x - p.x) * w.teams[b.team].dir > 0).sort(byDist)[0] ?? mates.sort(byDist)[0];
        const t = q.position();
        b.face.set(t.x - p.x, 0, t.z - p.z).normalize();
        w.kick(b, 0.5, t, 0, 0, true);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------- keeper
function keeper(w: PartyWorld, b: Bro) {
  const it = b.intent;
  const f = w.field;
  const gx = w.ownGoalX(b.team);
  const dirIn = -Math.sign(gx);
  const bp = w.ballPos();
  const bv = w.ballVel();
  const p = b.position();
  const towards = (gx - bp.x) * bv.x > 0 && Math.abs(bv.x) > 6;
  if (towards) {
    const t = (p.x - bp.x) / bv.x;
    if (t > 0 && t < 0.8) {
      const z = bp.z + bv.z * t;
      const y = bp.y + bv.y * t - 5.7 * t * t;
      const lateral = z - p.z;
      if (Math.abs(z) < f.goalHalfW + 0.8 && Math.abs(lateral) > 0.8 && Math.abs(lateral) < 4.8 && y < f.goalH + 0.5) {
        b.face.set(0, 0, Math.sign(lateral));
        it.moveX = it.moveZ = 0;
        it.dive = w.rng.chance(0.88);
        return;
      }
    }
  }
  // loose ball in our area: rush out and hoof it
  if (w.inBox(b.team, bp, -2) && bp.y < 1.2) {
    let mine = true;
    for (const o of w.bros) if (o.team !== b.team && o.position().distanceTo(bp) < p.distanceTo(bp) - 1) mine = false;
    if (mine) {
      steerTo(b, bp.x, bp.z, true, 0.1);
      if (p.distanceTo(bp) < 1.4) {
        b.face.set(dirIn, 0, 0);
        w.kick(b, 0.95, new Vector3(gx + dirIn * f.length * 0.55, 0, (w.rng.next() - 0.5) * f.width * 0.6), 0.45);
      }
      return;
    }
  }
  const z = Math.max(-f.goalHalfW + 0.6, Math.min(f.goalHalfW - 0.6, bp.z * 0.5));
  const off = Math.min(3, Math.max(0.8, Math.abs(bp.x - gx) * 0.06));
  steerTo(b, gx + dirIn * off, z, false, 0.25);
  b.face.set(dirIn, 0, 0);
}

// ---------------------------------------------------------------- field players
function openness(w: PartyWorld, team: number, p: Vector3) {
  let d = 99;
  for (const o of w.bros) if (o.team !== team) d = Math.min(d, o.position().distanceTo(p));
  return d;
}

/** clear lane from a to b (no opponent within ~1.8 m of the segment) */
function laneClear(w: PartyWorld, team: number, a: Vector3, c: Vector3) {
  const ab = c.clone().sub(a).setY(0);
  const len = ab.length() || 1;
  ab.divideScalar(len);
  for (const o of w.bros) {
    if (o.team === team) continue;
    const op = o.position().sub(a).setY(0);
    const s = Math.max(0, Math.min(len, op.dot(ab)));
    const d = op.clone().sub(ab.clone().multiplyScalar(s)).length();
    if (d < 1.4 + s * 0.08) return false;
  }
  return true;
}

function field(w: PartyWorld, b: Bro, dt: number) {
  const team = w.teams[b.team];
  const f = w.field;
  const gx = w.goalX(b.team);
  const bp = w.ballPos();
  const p = b.position();
  const mates = w.teamBros(b.team).filter((x) => x.role === 'FIELD');
  // chaser = closest field bro (the human-controlled one counts); cover = second closest
  const ranked = [...mates].sort((x, y) => x.position().distanceTo(bp) - y.position().distanceTo(bp));
  const chaser = ranked[0];
  const second = ranked[1];
  const theirBall = w.possessionTeam >= 0 && w.possessionTeam !== b.team;

  // opportunistic shove on an opponent at the ball in front of us
  for (const o of w.bros) {
    if (o.team === b.team || !o.canAct) continue;
    const op = o.position();
    if (op.distanceTo(p) < 1.4 && op.distanceTo(bp) < 1.6 && op.clone().sub(p).setY(0).normalize().dot(b.face) > 0.5 && w.rng.chance(dt * 0.7)) {
      w.shove(b);
      return;
    }
  }

  if (chaser === b) return chase(w, b, dt);
  if (second === b && theirBall) {
    // cover: goal-side of the ball
    const own = new Vector3(w.ownGoalX(b.team), 0, 0);
    const c = bp.clone().add(own.sub(bp).setY(0).normalize().multiplyScalar(6));
    steerTo(b, c.x, c.z, true, 0.8);
    return;
  }
  // support: formation slot, forwards make runs when we have it
  const s = formationSpot(w, b);
  if (!theirBall && b.home.x > 0.5) s.x += team.dir * 4;
  s.x = Math.max(-f.length / 2 + 2, Math.min(f.length / 2 - 2, s.x));
  const d = steerTo(b, s.x, s.z, p.distanceTo(s) > 10, 1);
  if (d < 1.2) b.face.set(bp.x - p.x, 0, bp.z - p.z).normalize();
  void gx;
}

function chase(w: PartyWorld, b: Bro, dt: number) {
  const it = b.intent;
  const team = w.teams[b.team];
  const f = w.field;
  const gx = w.goalX(b.team);
  const bp = w.ballPos();
  const p = b.position();
  const toGoal = new Vector3(gx - bp.x, 0, -bp.z * 0.7).normalize();
  const dBall = Math.hypot(bp.x - p.x, bp.z - p.z);
  const nearLine = Math.abs(bp.z) > f.width / 2 - 1.2 || Math.abs(bp.x) > f.length / 2 - 1.2;
  if (nearLine && dBall < 3) {
    // scrappy: just get it back infield
    steerTo(b, bp.x, bp.z, true, 0.1);
    if (dBall < 1.3 && mind(b).t <= 0) {
      mind(b).t = 0.5;
      b.face.set(bp.x - p.x, 0, bp.z - p.z).normalize();
      w.kick(b, 0.5, new Vector3(bp.x + team.dir * 10, 0, bp.z * 0.4), 0.15);
    }
    return;
  }
  const behind = bp.clone().addScaledVector(toGoal, -(0.36 + 0.15 + 0.35));
  const ahead = (p.x - bp.x) * team.dir > 0.3;
  if (ahead && dBall < 4) behind.z += (p.z > bp.z ? 1 : -1) * 1.6;
  const dBehind = steerTo(b, behind.x, behind.z, true, 0.15);
  const aligned = new Vector3(bp.x - p.x, 0, bp.z - p.z).normalize().dot(toGoal) > 0.7;
  if (dBehind < 0.9 || (dBall < 1.3 && aligned)) {
    // on the ball: push towards goal and decide
    it.moveX = toGoal.x;
    it.moveZ = toGoal.z;
    it.sprint = openness(w, b.team, p) > 4;
    b.face.copy(toGoal);
    const distGoal = Math.hypot(gx - bp.x, bp.z);
    if (dBall < 1.3 && bp.y < 0.9 && mind(b).t <= 0) {
      mind(b).t = 0.3 + w.rng.next() * 0.35;
      const range = Math.min(26, f.length * 0.3);
      const pressed = openness(w, b.team, p) < 2.6;
      if (distGoal < range && w.rng.chance(distGoal < 14 ? 0.7 : 0.4)) {
        const side = w.rng.chance(0.5) ? 1 : -1;
        const t = new Vector3(gx, 0, side * (f.goalHalfW - 0.7 - w.rng.next() * 0.8));
        const curl = Math.abs(bp.z) > 5 && w.rng.chance(0.5) ? Math.sign(bp.z) * team.dir * -0.6 : 0;
        const pw = 0.55 + w.rng.next() * 0.45;
        w.kick(b, pw, t, 0.05 + 0.12 * pw + (distGoal > 18 ? 0.04 : 0), curl);
        return;
      }
      if (pressed || w.rng.chance(0.25)) {
        // pass to an open teammate, preferably forward
        const mates = w.teamBros(b.team).filter((q) => q !== b && q.role === 'FIELD' && q.state === 'up');
        let best: Bro | null = null;
        let bs = -1e9;
        for (const q of mates) {
          const qp = q.position();
          const dist = qp.distanceTo(p);
          if (dist < 4 || dist > 38) continue;
          if (!laneClear(w, b.team, bp, qp)) continue;
          const s = (qp.x - p.x) * team.dir * 0.08 + Math.min(8, openness(w, b.team, qp)) * 0.25 - dist * 0.02;
          if (s > bs) {
            bs = s;
            best = q;
          }
        }
        if (best) {
          const t = best.position().addScaledVector(best.velocity(), 0.6);
          b.face.set(t.x - p.x, 0, t.z - p.z).normalize();
          if (t.distanceTo(p) > 28) w.kick(b, Math.min(1, t.distanceTo(p) / 45), t, 0.35);
          else w.kick(b, 0.5, t, 0, 0, true);
          return;
        }
      }
    }
  }
  // clumsy diving header at a bouncing ball
  if (dBall < 2.6 && bp.y > 0.8 && bp.y < 1.7 && w.rng.chance(dt * 1.2)) {
    b.face.set(bp.x - p.x, 0, bp.z - p.z).normalize();
    it.moveX = it.moveZ = 0;
    it.dive = true;
  }
}
