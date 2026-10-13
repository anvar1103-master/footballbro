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
    if (b.role === 'GK') continue; // keepers keep goal
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
      // aim for the corner away from their keeper
      const gk = w.teamBros(1 - b.team).find((q) => q.role === 'GK');
      const corner = -Math.sign((gk?.position().z ?? 0) - bp.z * 0.2 || w.rng.next() - 0.5) * (ARENA.goalHalfW - 0.5) * (0.6 + 0.4 * sk.aim);
      const airborne = bp.y - w.ballR > 0.25;
      if (airborne && distGoal < 20 && w.rng.next() < 0.6) {
        // volley / overhead kick
        w.smartKick(b, 0.8, new Vector3(gx - bp.x, 0, corner - bp.z));
      } else if (distGoal < 18 && facingGoal > 0.3 && w.rng.next() < 0.5) {
        w.shoot(b, Math.min(1, 0.35 + distGoal / 28 + w.rng.next() * 0.2), corner);
      } else if (blocked && w.holder === b && w.rng.next() < 0.3 * sk.aggro) {
        // try to beat him with a skill move
        const side = new Vector3(-b.face.z, 0, b.face.x).multiplyScalar(w.rng.chance(0.5) ? 1 : -1);
        w.doSkill(b, w.rng.chance(0.35) ? b.face.clone() : side);
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

  if (b.role === 'GK') {
    keeper(w, b, m);
    return;
  }

  // a pass is coming my way: go and meet it
  const meet = receivePoint(w, b);
  if (meet) {
    m.role = 'support';
    m.target.copy(meet);
    m.sprint = true;
    b.face.set(bp.x - p.x, 0, bp.z - p.z).normalize();
    return;
  }

  // supporters: spread out ahead of the ball, keep away from the chaser
  m.role = 'support';
  const sup = mates.filter((q) => q !== chaser && q.role !== 'GK');
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

/** keeper: on the line between ball and goal centre, rushes out at loose balls, dives at shots */
function keeper(w: PartyWorld, b: Bro, m: Mind) {
  m.role = 'back';
  const p = b.position();
  const bp = w.ballPos();
  const bv = w.ballVel();
  const ogx = w.ownGoalX(b.team);
  const out = -Math.sign(ogx); // towards the field
  m.sprint = false;
  if (w.gkHold?.gk === b) {
    m.target.copy(p);
    b.face.set(out, 0, 0);
    return;
  }
  const lim = ARENA.goalHalfW - 0.35;
  m.target.set(ogx + out * 1.0, 0, Math.max(-lim, Math.min(lim, bp.z * 0.45)));
  const dBall = Math.hypot(bp.x - p.x, bp.z - p.z);
  const inBox = Math.abs(bp.x - ogx) < 8 && Math.abs(bp.z) < 8;
  // shot coming: predict where it crosses and dive there
  if (Math.sign(bv.x) === Math.sign(ogx) && Math.abs(bv.x) > 6) {
    const tt = (p.x - bp.x) / bv.x;
    const zPred = bp.z + bv.z * tt;
    if (tt > 0 && tt < 1.2 && Math.abs(zPred) < ARENA.goalHalfW + 1.2) {
      m.target.set(p.x, 0, Math.max(-lim - 0.5, Math.min(lim + 0.5, zPred)));
      m.sprint = true;
      if (tt < 0.55 && Math.abs(zPred - p.z) > 0.8 && bp.y < 2.6) {
        b.face.set(bv.x * 0.15, 0, zPred - p.z).normalize();
        pendingDive.add(b);
      }
      return;
    }
  }
  // loose ball in the box: come and get it
  if (inBox && !w.holder && dBall < 6) {
    m.target.set(bp.x, 0, bp.z);
    m.sprint = true;
  } else if (inBox && w.holder && w.holder.team !== b.team && dBall < 3) {
    // 1-on-1: close the angle and dive at his feet
    m.target.set(bp.x, 0, bp.z);
    m.sprint = true;
    if (dBall < 2.2 && dBall > 1.0 && w.rng.next() < 0.3) {
      b.face.set(bp.x - p.x, 0, bp.z - p.z).normalize();
      pendingDive.add(b);
    }
  }
  if (w.inReach(b) && !w.gkHold) {
    const mate = w.bestMate(b, true);
    if (mate && w.rng.next() < 0.5) w.passTo(b, mate);
    else w.lob(b, w.lobTarget(b));
  }
}

/** if a team-mate's pass is rolling past, the point where `b` should meet it */
function receivePoint(w: PartyWorld, b: Bro) {
  if (w.holder || w.lastTouch?.team !== b.team || w.lastTouch === b) return null;
  const bp = w.ballPos();
  const bv = w.ballVel();
  const sp = Math.hypot(bv.x, bv.z);
  if (sp < 2.5) return null;
  const p = b.position();
  // closest approach of the ball's ground path within the next 2.5 s
  const t = Math.max(0, Math.min(2.5, ((p.x - bp.x) * bv.x + (p.z - bp.z) * bv.z) / (sp * sp)));
  const cx = bp.x + bv.x * t, cz = bp.z + bv.z * t;
  if (Math.hypot(cx - p.x, cz - p.z) > 5) return null;
  // nobody of ours closer to that point
  for (const q of w.teamBros(b.team)) {
    if (q === b || q === w.lastTouch || q.role === 'GK') continue;
    const qp = q.position();
    if (Math.hypot(cx - qp.x, cz - qp.z) < Math.hypot(cx - p.x, cz - p.z) - 0.5) return null;
  }
  return new Vector3(cx - (bv.x / sp) * 0.6, 0, cz - (bv.z / sp) * 0.6);
}
