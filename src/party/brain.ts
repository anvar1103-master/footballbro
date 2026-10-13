import { Vector3 } from 'three';
import { BRO, Bro } from './bro';
import type { PartyWorld } from './world';
import { ARENA } from './world';

/**
 * Bean AI. Each team has a chaser (best placed to reach the ball), a back bean that guards the
 * goal, and supporters who spread out ahead of the ball. The chaser gets behind the ball, dribbles
 * at goal, shoots, passes when blocked, lobs from wide, and tackles / grabs opponents on the ball.
 * Decisions are re-taken a few times per second; difficulty scales reaction time and accuracy.
 */

const SKILL = { easy: { react: 0.35, aim: 0.5, aggro: 0.5 }, normal: { react: 0.2, aim: 0.75, aggro: 0.8 }, hard: { react: 0.1, aim: 0.95, aggro: 1 } };

interface Mind {
  t: number;
  target: Vector3;
  sprint: boolean;
  role: 'chase' | 'back' | 'support';
}
const minds = new WeakMap<Bro, Mind>();

function mind(b: Bro) {
  let m = minds.get(b);
  if (!m) {
    m = { t: (b.id % 5) * 0.04, target: new Vector3(), sprint: false, role: 'support' };
    minds.set(b, m);
  }
  return m;
}

/** who on `team` should go for the ball: shortest time to it (the human counts if close) */
function chaserOf(w: PartyWorld, team: number) {
  const bp = w.ballPos();
  let best: Bro | null = null;
  let bt = 1e9;
  for (const b of w.teamBros(team)) {
    if (b.state === 'down') continue;
    const p = b.position();
    let t = Math.hypot(bp.x - p.x, bp.z - p.z) / 7;
    if (b.number === 1) t += 1.2; // the back bean stays home unless it is right there
    if (b === w.controlled) t -= 0.3; // humans tend to go for it themselves
    if (t < bt) {
      bt = t;
      best = b;
    }
  }
  return best;
}

export function think(w: PartyWorld, b: Bro, dt: number) {
  const m = mind(b);
  const sk = SKILL[w.opts.difficulty ?? 'normal'];
  const p = b.position();
  const bp = w.ballPos();
  const intent = { moveX: 0, moveZ: 0, sprint: false, jump: false, dive: false };

  // celebrations / despair
  if (w.phase === 'goal' || w.phase === 'over') {
    const won = w.phase === 'goal' ? w.scoredTeam === b.team : w.teams[b.team].score > w.teams[1 - b.team].score;
    if (won && b.canAct) {
      intent.jump = w.rng.next() < 0.04;
      intent.moveX = Math.sin(w.phaseT * 3.3 + b.id) * 0.4;
      intent.moveZ = Math.cos(w.phaseT * 3.8 + b.id) * 0.4;
    }
    b.intent = intent;
    b.charging = null;
    return;
  }
  if (!b.canAct) {
    b.intent = intent;
    return;
  }

  m.t -= dt;
  if (m.t <= 0) {
    m.t = sk.react * (0.7 + w.rng.next() * 0.6);
    decide(w, b, m, sk);
  }

  // steer to the target
  const dx = m.target.x - p.x, dz = m.target.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.25) {
    const s = Math.min(1, d / 1.2);
    intent.moveX = (dx / d) * s;
    intent.moveZ = (dz / d) * s;
  }
  intent.sprint = m.sprint && d > 2;
  intent.dive = consumeDive(b);

  // jump for balls dropping on our head
  const bv = w.ballVel();
  if (bp.y > 1.6 && bp.y < 3.4 && bv.y < 1 && Math.hypot(bp.x - p.x, bp.z - p.z) < 1.6 && w.rng.next() < 0.25) intent.jump = true;
  // the sweeper bar: hop over it
  if (w.sweeper.on) {
    const s = w.sweeper;
    const sx = Math.cos(s.angle), sz = Math.sin(s.angle);
    const along = p.x * sx + p.z * sz;
    const perp = -p.x * sz + p.z * sx;
    const approaching = Math.sign(perp) !== Math.sign(s.speed * along) || Math.abs(perp) < 0.2;
    if (Math.abs(along) < s.len && Math.abs(perp) < 1.3 && approaching && w.rng.next() < 0.6 * sk.aggro) intent.jump = true;
  }
  b.intent = intent;

  // grabs: let go after a while
  if (b.grabbing && (b.grabT > 1.2 + w.rng.next() || w.holder !== b.grabbing)) w.release(b);
}

function decide(w: PartyWorld, b: Bro, m: Mind, sk: (typeof SKILL)['normal']) {
  const p = b.position();
  const bp = w.ballPos();
  const bv = w.ballVel();
  const dir = w.teams[b.team].dir;
  const gx = w.goalX(b.team);
  const ogx = w.ownGoalX(b.team);
  const chaser = chaserOf(w, b.team);
  const mates = w.teamBros(b.team);
  const R = BRO.radius + w.ballR;
  m.sprint = false;

  if (chaser === b) {
    m.role = 'chase';
    m.sprint = true;
    const holder = w.holder;
    // an opponent has it: tackle or grab him
    if (holder && holder.team !== b.team) {
      const hp = holder.position();
      const dh = Math.hypot(hp.x - p.x, hp.z - p.z);
      m.target.set(hp.x + (bp.x - hp.x) * 0.6, 0, hp.z + (bp.z - hp.z) * 0.6);
      b.face.set(hp.x - p.x, 0, hp.z - p.z).normalize();
      if (dh < 2.4 && dh > 1.1 && w.rng.next() < 0.35 * sk.aggro) pendingDive.add(b);
      else if (dh < 1.5 && w.rng.next() < 0.25 * sk.aggro) w.tryGrab(b);
      return;
    }
    // lead a moving ball a little
    const lead = Math.min(0.6, Math.hypot(bp.x - p.x, bp.z - p.z) / 12);
    const fx = bp.x + bv.x * lead, fz = bp.z + bv.z * lead;
    // get behind the ball, on the line to the goal
    const aimZ = Math.max(-ARENA.goalHalfW + 1, Math.min(ARENA.goalHalfW - 1, p.z * 0.3));
    const toGoal = new Vector3(gx - fx, 0, aimZ - fz).normalize();
    const behind = new Vector3(fx - toGoal.x * (R + 0.15), 0, fz - toGoal.z * (R + 0.15));
    const toBall = new Vector3(fx - p.x, 0, fz - p.z);
    const dBall = toBall.length();
    toBall.normalize();
    const aligned = toBall.dot(toGoal);
    if (aligned < 0.5 && dBall < 3.5) {
      // swing round the ball instead of pushing it towards our own goal
      const side = new Vector3(-toGoal.z, 0, toGoal.x);
      const s = Math.sign(side.dot(new Vector3(p.x - fx, 0, p.z - fz))) || 1;
      m.target.set(behind.x + side.x * s * 1.3 - toGoal.x * 0.8, 0, behind.z + side.z * s * 1.3 - toGoal.z * 0.8);
    } else m.target.copy(dBall > 1.6 ? behind : new Vector3(fx + toGoal.x * 2, 0, fz + toGoal.z * 2));

    if (w.inReach(b)) {
      const distGoal = Math.hypot(gx - bp.x, bp.z);
      const facingGoal = b.face.dot(new Vector3(gx - bp.x, 0, -bp.z).normalize());
      // opponent right in front?
      let blocked = false;
      for (const o of w.teamBros(1 - b.team)) {
        const op = o.position();
        const t = (op.x - p.x) * b.face.x + (op.z - p.z) * b.face.z;
        if (t > 0 && t < 3 && Math.abs((op.x - p.x) * b.face.z - (op.z - p.z) * b.face.x) < 1.2) blocked = true;
      }
      if (distGoal < 17 && facingGoal > 0.3 && w.rng.next() < 0.55) {
        const z = (w.rng.next() * 2 - 1) * (ARENA.goalHalfW - 1.1) * sk.aim;
        w.shoot(b, Math.min(1, 0.45 + distGoal / 30 + w.rng.next() * 0.2), z);
      } else if ((blocked || facingGoal < -0.2) && w.rng.next() < 0.6) {
        const mate = w.bestMate(b, true);
        if (mate) w.passTo(b, mate);
      } else if (Math.abs(bp.z) > ARENA.width / 2 - 5 && Math.abs(gx - bp.x) < 16 && w.rng.next() < 0.35) {
        w.lob(b, w.lobTarget(b));
      } else if (facingGoal < -0.5 && Math.abs(ogx - bp.x) < 10) {
        // panic clearance
        w.shoot(b, 0.8);
      }
    }
    return;
  }

  // back bean: between the ball and our goal, close to the goal mouth
  const isBack = b === mates.find((q) => q.number === 1) || (mates.length > 1 && b === mates[0]);
  if (isBack) {
    m.role = 'back';
    const t = Math.min(0.35, Math.max(0.12, Math.abs(bp.x - ogx) / 60));
    m.target.set(ogx + (bp.x - ogx) * t, 0, Math.max(-ARENA.goalHalfW, Math.min(ARENA.goalHalfW, bp.z * 0.5)));
    // ball flying at our goal: throw yourself at it
    const dBall = Math.hypot(bp.x - p.x, bp.z - p.z);
    if (Math.sign(bv.x) === Math.sign(ogx) && Math.abs(bv.x) > 6 && dBall < 4 && dBall > 1.2) {
      b.face.set(bp.x - p.x, 0, bp.z - p.z).normalize();
      pendingDive.add(b);
    }
    if (Math.abs(bp.x - ogx) < 12) m.sprint = true;
    // clear it if it is at our feet
    if (w.inReach(b)) {
      const mate = w.bestMate(b, true);
      if (mate && w.rng.next() < 0.5) w.passTo(b, mate);
      else w.shoot(b, 0.9);
    }
    return;
  }

  // supporters: spread out ahead of the ball, keep away from the chaser
  m.role = 'support';
  const sup = mates.filter((q) => q !== chaser && q.number !== 1);
  const i = Math.max(0, sup.indexOf(b));
  const n = Math.max(1, sup.length);
  const attacking = (w.holder?.team ?? w.lastTouch?.team ?? b.team) === b.team;
  const ahead = attacking ? 7 : -3;
  const x = Math.max(-ARENA.length / 2 + 4, Math.min(ARENA.length / 2 - 4, bp.x + dir * ahead));
  const lane = n === 1 ? -Math.sign(bp.z || 1) * 6 : -9 + (18 * i) / (n - 1);
  m.target.set(x, 0, lane);
  // a loose ball close by: go for it too
  if (!w.holder && Math.hypot(bp.x - p.x, bp.z - p.z) < 3) m.target.set(bp.x, 0, bp.z);
  m.sprint = Math.hypot(m.target.x - p.x, m.target.z - p.z) > 6;
  if (w.inReach(b) && w.holder === b) {
    const mate = w.bestMate(b, true);
    if (Math.abs(gx - bp.x) < 15) w.shoot(b, 0.7);
    else if (mate) w.passTo(b, mate);
  }
}

/** dives decided in `decide` fire through the intent of the same step */
const pendingDive = new Set<Bro>();
export function consumeDive(b: Bro) {
  if (pendingDive.has(b)) {
    pendingDive.delete(b);
    return true;
  }
  return false;
}
