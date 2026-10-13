import { Vector3 } from 'three';
import { ARENA, BALL_P, PartyWorld } from './world';
import { Bro } from './bro';

/**
 * Clumsy-but-purposeful AI for party football.
 * GK: shuffles on the line, dives at shots. Field: the nearest bro chases and tries to get
 * behind the ball to push/kick it goalwards; the others support. Everybody shoves sometimes.
 */

interface Mind {
  t: number;
  goal: Vector3;
  celebrate: number;
}
const minds = new WeakMap<Bro, Mind>();
function mind(b: Bro) {
  let m = minds.get(b);
  if (!m) {
    m = { t: 0, goal: new Vector3(), celebrate: 0 };
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
  b.intent.sprint = sprint && d > 3;
  return d;
}

export function think(w: PartyWorld, b: Bro, dt: number) {
  const it = b.intent;
  it.jump = false;
  it.dive = false;
  it.sprint = false;
  const mm = mind(b);
  mm.t -= dt;

  if (w.phase === 'goal') {
    it.moveX = it.moveZ = 0;
    if (b.team === w.lastGoalTeam && b.canAct && w.rng.chance(dt * 1.5)) it.jump = true; // happy hops
    return;
  }
  if (w.phase !== 'play') {
    it.moveX = it.moveZ = 0;
    return;
  }
  if (!b.canAct) return;
  if (b.role === 'GK') return keeper(w, b);
  field(w, b, dt);
}

function keeper(w: PartyWorld, b: Bro) {
  const it = b.intent;
  const gx = w.ownGoalX(b.team);
  const dirIn = -Math.sign(gx);
  const bp = w.ballPos();
  const bv = w.ballVel();
  const p = b.position();
  // incoming shot? (linear prediction to the keeper's x)
  const towards = (gx - bp.x) * bv.x > 0 && Math.abs(bv.x) > 6;
  if (towards) {
    const t = (p.x - bp.x) / bv.x;
    if (t > 0 && t < 0.8) {
      const z = bp.z + bv.z * t;
      const y = bp.y + bv.y * t - 5.7 * t * t;
      const lateral = z - p.z;
      if (Math.abs(z) < ARENA.goalHalfW + 0.8 && Math.abs(lateral) > 0.9 && Math.abs(lateral) < 4.5 && y < ARENA.goalH + 0.5) {
        // dive sideways: face the dive direction for a moment
        b.face.set(0, 0, Math.sign(lateral));
        it.moveX = it.moveZ = 0;
        it.dive = w.rng.chance(0.85);
        return;
      }
    }
  }
  // ball loose in our area: rush and clear
  const inArea = Math.abs(bp.x - gx) < ARENA.boxDepth * 0.8 && Math.abs(bp.z) < ARENA.boxHalfW;
  if (inArea && bp.y < 1.2) {
    let mine = true;
    for (const o of w.bros) if (o.team !== b.team && o.position().distanceTo(bp) < p.distanceTo(bp) - 1) mine = false;
    if (mine) {
      steerTo(b, bp.x, bp.z, true, 0.1);
      if (p.distanceTo(bp) < 1.3) w.kick(b, 0.9, new Vector3(-gx * 0.3, 0, (w.rng.next() - 0.5) * ARENA.width * 0.6), 0.45);
      return;
    }
  }
  const z = Math.max(-ARENA.goalHalfW + 0.6, Math.min(ARENA.goalHalfW - 0.6, bp.z * 0.55));
  steerTo(b, gx + dirIn * 1.0, z, false, 0.25);
  b.face.set(dirIn, 0, 0);
}

function field(w: PartyWorld, b: Bro, dt: number) {
  const it = b.intent;
  const team = w.teams[b.team];
  const gx = w.goalX(b.team);
  const bp = w.ballPos();
  const p = b.position();
  const mates = w.teamBros(b.team).filter((x) => x.role === 'FIELD');
  // chaser = closest field bro of the team (counting the human-controlled one)
  let chaser = mates[0];
  for (const x of mates) if (x.position().distanceTo(bp) < chaser.position().distanceTo(bp)) chaser = x;

  // opportunistic shove on whoever is near the ball in front of us
  for (const o of w.bros) {
    if (o.team === b.team || !o.canAct) continue;
    const op = o.position();
    if (op.distanceTo(p) < 1.3 && op.distanceTo(bp) < 1.6 && op.clone().sub(p).setY(0).normalize().dot(b.face) > 0.5 && w.rng.chance(dt * 0.9)) {
      w.shove(b);
      return;
    }
  }

  if (chaser === b || (chaser === w.controlled && b.position().distanceTo(bp) < 2.5)) {
    const toGoal = new Vector3(gx - bp.x, 0, -bp.z * 0.7).normalize();
    const behind = bp.clone().addScaledVector(toGoal, -0.95);
    const dBall = Math.hypot(bp.x - p.x, bp.z - p.z);
    // are we goal-side of the ball? then we must go around it
    const ahead = (p.x - bp.x) * team.dir > 0.3;
    if (ahead && dBall < 4) behind.z += (p.z > bp.z ? 1 : -1) * 1.6;
    // ball against the boards: just get to it and hack it back into play
    const nearWall = Math.abs(bp.x) > ARENA.length / 2 + ARENA.boardMargin - 1.3 || Math.abs(bp.z) > ARENA.width / 2 + ARENA.boardMargin - 1.3;
    if (nearWall) {
      steerTo(b, bp.x, bp.z, true, 0.1);
      if (dBall < 1.4 && mind(b).t <= 0) {
        mind(b).t = 0.5;
        b.face.set(bp.x - p.x, 0, bp.z - p.z).normalize();
        w.kick(b, 0.6, new Vector3(gx * 0.6, 0, -bp.z * 0.3), 0.3);
      }
      return;
    }
    behind.x = Math.max(-ARENA.length / 2 - ARENA.boardMargin + 0.6, Math.min(ARENA.length / 2 + ARENA.boardMargin - 0.6, behind.x));
    behind.z = Math.max(-ARENA.width / 2 - ARENA.boardMargin + 0.6, Math.min(ARENA.width / 2 + ARENA.boardMargin - 0.6, behind.z));
    const dBehind = steerTo(b, behind.x, behind.z, true, 0.15);
    const aligned = new Vector3(bp.x - p.x, 0, bp.z - p.z).normalize().dot(toGoal) > 0.75;
    if (dBehind < 0.9 || (dBall < 1.3 && aligned)) {
      // push through the ball towards goal
      it.moveX = toGoal.x;
      it.moveZ = toGoal.z;
      it.sprint = true;
      b.face.copy(toGoal);
      const distGoal = Math.hypot(gx - bp.x, bp.z);
      if (dBall < 1.25 && bp.y < 1.0 && mind(b).t <= 0) {
        mind(b).t = 0.35 + w.rng.next() * 0.4;
        if (distGoal < 17 && w.rng.chance(0.55)) {
          const side = w.rng.chance(0.5) ? 1 : -1;
          const target = new Vector3(gx, 0, side * (ARENA.goalHalfW - 0.6 - w.rng.next()));
          const curl = w.rng.chance(0.4) ? -side * team.dir * 0.6 : 0;
          w.kick(b, 0.55 + w.rng.next() * 0.45, target, 0.12 + w.rng.next() * 0.15, curl);
        } else if (distGoal > 12) {
          // pass to a mate further forward if one is free
          const fwd = mates.filter((x) => x !== b && (x.position().x - p.x) * team.dir > 3 && x.state === 'up');
          if (fwd.length && w.rng.chance(0.35)) {
            const q = fwd[0];
            const tp = q.position();
            w.kick(b, Math.min(1, tp.distanceTo(p) / 24), tp, 0.08);
          }
        }
      }
    }
    // clumsy diving header at a bouncing ball
    if (dBall < 2.6 && bp.y > 0.7 && bp.y < 1.6 && w.rng.chance(dt * 1.2)) {
      b.face.set(bp.x - p.x, 0, bp.z - p.z).normalize();
      it.moveX = it.moveZ = 0;
      it.dive = true;
    }
    return;
  }

  // support: spread out; attack-minded when we're nearer the ball than they are
  const attacking = (bp.x - 0) * team.dir > -6;
  const idx = mates.indexOf(b);
  const lane = idx % 2 === 0 ? 1 : -1;
  let tx: number, tz: number;
  if (attacking) {
    tx = bp.x + team.dir * 7;
    tz = lane * ARENA.width * 0.25 - bp.z * 0.2;
  } else {
    const own = w.ownGoalX(b.team);
    tx = bp.x + (own - bp.x) * 0.45;
    tz = bp.z * 0.5 + lane * 4;
  }
  tx = Math.max(-ARENA.length / 2 + 2, Math.min(ARENA.length / 2 - 2, tx));
  tz = Math.max(-ARENA.width / 2 + 1.5, Math.min(ARENA.width / 2 - 1.5, tz));
  steerTo(b, tx, tz, false, 0.8);
  if (Math.hypot(tx - p.x, tz - p.z) < 1) b.face.set(bp.x - p.x, 0, bp.z - p.z).normalize();
  void BALL_P;
}
