import { Vector3 } from 'three';
import { BALL } from './config';
import { predictPath } from './kick';
import type { Match } from './match';
import { KickKind, Player } from './player';
import type { Team } from './team';

/**
 * Team AI: formation-based positioning, pressing, ball-carrier decisions,
 * set-piece takers and the goalkeeper.
 */

const tmp = new Vector3();

/** Dynamic formation spot for a player given ball position & possession. */
export function formationTarget(m: Match, p: Player, out = new Vector3()) {
  const t = m.teams[p.team];
  const f = m.field;
  const dir = t.attackDir;
  const bx = (m.ball.pos.x * dir) / f.length + 0.5; // 0 own goal .. 1 opp goal
  const bz = (m.ball.pos.z * dir) / (f.width / 2);
  const attacking = m.possessionTeam === p.team;
  let x = p.home.x;
  let z = p.home.z;
  if (p.role !== 'GK') {
    x += (bx - 0.5) * (attacking ? 0.72 : 0.62) + (attacking ? 0.07 : -0.03);
    z = attacking ? z * 1.05 + bz * 0.12 : z * 0.72 + bz * 0.32;
    if (!attacking) {
      const lim = bx + (p.role === 'FWD' ? 0.12 : p.role === 'MID' ? 0.02 : -0.04);
      x = Math.min(x, lim);
    }
    if (p.role === 'DEF') x = Math.min(x, 0.62);
    x = Math.max(p.role === 'DEF' ? 0.08 : 0.15, Math.min(0.9, x));
  }
  z = Math.max(-0.95, Math.min(0.95, z));
  return out.set(dir * (x - 0.5) * f.length, 0, z * dir * (f.width / 2) * 0.92);
}

function steer(p: Player, target: Vector3, sprint: boolean, arrive = 2) {
  const dx = target.x - p.pos.x;
  const dz = target.z - p.pos.z;
  const d = Math.hypot(dx, dz);
  p.sprint = sprint && d > 3;
  if (d < 0.25) {
    p.desired.set(0, 0, 0);
    return d;
  }
  const max = p.maxSpeed(false);
  const sp = d < arrive ? (max * d) / arrive : max;
  p.desired.set((dx / d) * sp, 0, (dz / d) * sp);
  return d;
}

/** Earliest time a player can reach the predicted ball path. */
function interceptTime(p: Player, path: { t: number; p: Vector3 }[], out?: Vector3) {
  const sp = p.maxSpeed(false) * 1.05;
  for (const s of path) {
    if (s.p.y > 1.6) continue;
    const d = Math.hypot(s.p.x - p.pos.x, s.p.z - p.pos.z) - 0.6;
    if (d / sp <= s.t + 0.05) {
      out?.copy(s.p).setY(0);
      return s.t;
    }
  }
  const last = path[path.length - 1];
  out?.copy(last.p).setY(0);
  return last.t + Math.hypot(last.p.x - p.pos.x, last.p.z - p.pos.z) / sp;
}

/** Minimum clearance of opponents to a pass lane (negative = likely intercepted). */
export function laneSafety(m: Match, team: number, from: Vector3, to: Vector3, lofted = false) {
  const lx = to.x - from.x, lz = to.z - from.z;
  const len = Math.hypot(lx, lz) || 1;
  let safety = 99;
  for (const q of m.teams[1 - team].players) {
    const qx = q.pos.x - from.x, qz = q.pos.z - from.z;
    let s = (qx * lx + qz * lz) / (len * len);
    if (lofted && s < 0.8) continue; // lobs only contested at landing
    s = Math.max(0, Math.min(1, s));
    const dx = qx - lx * s, dz = qz - lz * s;
    const d = Math.hypot(dx, dz);
    const margin = d - (0.9 + s * len * (lofted ? 0.1 : 0.5));
    if (margin < safety) safety = margin;
  }
  return safety;
}

function nearestOpponentDist(m: Match, team: number, pos: Vector3) {
  let best = 99;
  for (const q of m.teams[1 - team].players) {
    const d = Math.hypot(q.pos.x - pos.x, q.pos.z - pos.z);
    if (d < best) best = d;
  }
  return best;
}

export interface PassOption {
  to: Player;
  target: Vector3;
  kind: KickKind;
  score: number;
}

/** Evaluate passing options. `dir` (optional) restricts to a cone (for the human). */
export function passOptions(m: Match, p: Player, dir: Vector3 | null, kinds: KickKind[] = ['pass', 'lob', 'through']): PassOption[] {
  const t = m.teams[p.team];
  const opts: PassOption[] = [];
  const f = m.field;
  const from = m.ball.pos;
  for (const q of t.players) {
    if (q === p || q.action === 'fallen') continue;
    const dx = q.pos.x - p.pos.x, dz = q.pos.z - p.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 3) continue;
    let cone = 1;
    if (dir) {
      cone = (dx * dir.x + dz * dir.z) / dist;
      if (cone < 0.5) continue;
    }
    if (q.role === 'GK' && !dir && dist > 25) continue;
    const progress = (q.pos.x - p.pos.x) * t.attackDir;
    const space = Math.min(10, nearestOpponentDist(m, p.team, q.pos));
    for (const kind of kinds) {
      const target = q.pos.clone();
      if (kind === 'pass') {
        if (dist > 45) continue;
        target.addScaledVector(q.vel, dist / 16);
      } else if (kind === 'lob') {
        if (dist < 14) continue;
        target.addScaledVector(q.vel, 0.9);
      } else if (kind === 'through') {
        if (q.role === 'GK' || q.role === 'DEF') continue;
        const ahead = new Vector3(t.attackDir, 0, -Math.sign(q.pos.z) * 0.15).normalize();
        target.addScaledVector(ahead, Math.min(10, 4 + dist * 0.2));
        if (Math.abs(target.x) > f.length / 2 - 2) continue;
      }
      target.x = Math.max(-f.length / 2 + 1, Math.min(f.length / 2 - 1, target.x));
      target.z = Math.max(-f.width / 2 + 1, Math.min(f.width / 2 - 1, target.z));
      const safety = laneSafety(m, p.team, from, target, kind === 'lob');
      const targetSpace = Math.min(10, nearestOpponentDist(m, p.team, target));
      let score =
        progress * 0.07 + (kind === 'through' ? targetSpace : space) * 0.1 + Math.min(2, safety) * 0.3 - dist * 0.01 + (dir ? cone * 0.8 : 0);
      if (kind === 'lob') score -= dist < 22 ? 1.8 : 1.0;
      if (kind === 'through') score += 0.1;
      if (q.role === 'GK') score -= 1.2;
      if (safety < 0) score -= 3;
      const recvSpace = kind === 'through' ? targetSpace : Math.min(space, targetSpace);
      if (recvSpace < 3) score -= 2 * (3 - recvSpace);
      if (kind === 'through' && (targetSpace < 5 || safety < 0.8)) score -= 3;
      opts.push({ to: q, target, kind, score });
    }
  }
  opts.sort((a, b) => b.score - a.score);
  return opts;
}

/** Aim point in the goal mouth with skill-based error. */
export function shotAim(m: Match, p: Player, power: number, finesse: boolean, side: number) {
  const f = m.field;
  const gx = m.attackGoalX(p.team);
  const dist = Math.hypot(gx - m.ball.pos.x, m.ball.pos.z);
  const inset = finesse ? 0.55 : 0.75;
  let tz = side * (f.goalHalfW - inset);
  let ty = finesse ? 0.9 + 0.9 * power : 0.3 + 1.6 * Math.pow(power, 1.6);
  const pressure = Math.max(0, 3 - nearestOpponentDist(m, p.team, p.pos)) / 3;
  let sigma = ((1.1 - p.stats.shot) * 1.3 + Math.pow(power, 3) * 0.75 + pressure * 0.6 + (finesse ? 0.2 : 0)) * Math.max(0.7, dist / 16);
  if (m.controlled === p) sigma *= 0.75; // a little assist for the human
  tz += m.rng.gauss() * sigma * 0.75;
  ty += Math.abs(m.rng.gauss()) * sigma * 0.45 + (power > 0.88 ? (power - 0.88) * 9 : 0);
  ty = Math.max(BALL.radius + 0.05, ty);
  const target = new Vector3(gx, ty, tz);
  // curl towards the goal centre for finesse shots
  let curl = 0;
  if (finesse) {
    const s = Math.abs(tz) > 0.4 ? Math.sign(tz) : -Math.sign(p.pos.z || 1);
    curl = s * m.teams[p.team].attackDir;
  }
  return { target, curl };
}

// --------------------------------------------------------------------------

export function aiTeam(m: Match, team: Team, dt: number) {
  const phase = m.phase;
  const players = team.players;
  // team roles
  let chaser: Player | null = null;
  let cover: Player | null = null;
  let path: { t: number; p: Vector3 }[] | null = null;
  const owner = m.owner;
  if (phase === 'play') {
    const ranked: { p: Player; t: number }[] = [];
    if (owner && owner.team !== team.index) {
      const own = new Vector3(m.ownGoalX(team.index), 0, 0);
      for (const p of players) {
        if (p.role === 'GK') continue;
        const d = p.pos.distanceTo(owner.pos);
        // prefer goal-side defenders
        const goalSide = own.distanceTo(p.pos) < own.distanceTo(owner.pos) ? 0 : 3;
        ranked.push({ p, t: d + goalSide });
      }
    } else if (!owner) {
      path = predictPath(m.ball, 3, 0.1);
      for (const p of players) {
        if (p.role === 'GK') continue;
        ranked.push({ p, t: interceptTime(p, path) });
      }
    }
    ranked.sort((a, b) => a.t - b.t);
    if (ranked.length) {
      chaser = ranked[0].p;
      cover = ranked[1]?.p ?? null;
      if (chaser === m.controlled) {
        // the human handles the press; the next one covers
        chaser = owner ? null : ranked[1]?.p && ranked[1].t < ranked[0].t + 0.4 ? ranked[1].p : null;
        cover = ranked[1]?.p ?? null;
      }
      if (cover === m.controlled) cover = ranked[2]?.p ?? null;
      if (cover === chaser) cover = null;
      // human asks for a second man to press
      if (team.index === m.humanTeam && m.teammatePress && owner && owner.team !== team.index) {
        const r = ranked.find((x) => x.p !== m.controlled);
        if (r) {
          chaser = r.p;
          if (cover === chaser) cover = null;
        }
      }
    }
  }

  for (const p of players) {
    if (p.role === 'GK') continue;
    if (p === m.controlled && (phase === 'play' || (m.setPiece?.taker === p && m.setPiece.ready))) continue;
    p.thinkT -= dt;
    switch (phase) {
      case 'fulltime':
      case 'halftime':
        p.desired.set(0, 0, 0);
        break;
      case 'goal':
        if (p.action === 'celebrate') p.desired.set(0, 0, 0);
        else if (p.celebrateTarget) steer(p, p.celebrateTarget, true, 1);
        else steer(p, formationTarget(m, p, tmp), false, 3);
        break;
      case 'kickoff':
      case 'setpiece':
        setPieceAI(m, p);
        break;
      default:
        playAI(m, p, dt, p === chaser, p === cover, path);
    }
  }
}

function setPieceAI(m: Match, p: Player) {
  const sp = m.setPiece;
  if (sp && sp.taker === p) {
    if (!sp.ready) {
      if (p.spot) steer(p, p.spot, true, 0.8);
      return;
    }
    p.desired.set(0, 0, 0);
    if (m.controlled === p) return;
    if (sp.readyT > (sp.kind === 'kickoff' ? 0.5 : 0.9) && !p.busy) takeSetPiece(m, p, sp.kind);
    return;
  }
  if (p.spot) steer(p, p.spot, true, 1.2);
  else steer(p, formationTarget(m, p, tmp), false, 2);
}

export function takeSetPiece(m: Match, p: Player, kind: string) {
  const t = m.teams[p.team];
  const f = m.field;
  if (kind === 'kickoff') {
    const mates = t.players.filter((q) => q !== p && q.role !== 'GK').sort((a, b) => a.pos.distanceTo(p.pos) - b.pos.distanceTo(p.pos));
    const q = mates[0];
    m.orderKick(p, 'pass', q.pos.clone(), 0.5, q);
    return;
  }
  if (kind === 'penalty') {
    const side = m.rng.chance(0.5) ? 1 : -1;
    const { target } = shotAim(m, p, m.rng.range(0.45, 0.8), false, side);
    m.orderKick(p, 'shot', target, 0.7);
    return;
  }
  if (kind === 'corner') {
    const gx = m.attackGoalX(p.team);
    const inBox = t.players.filter((q) => q !== p && Math.abs(q.pos.x - gx) < f.boxDepth && Math.abs(q.pos.z) < f.boxHalfW);
    const q = inBox.length ? m.rng.pick(inBox) : m.nearestOutfield(p.team, p.pos, p);
    const target = q.pos.clone();
    m.orderKick(p, 'cross', target, 0.7, q);
    return;
  }
  if (kind === 'freekick' && m.distToGoal(p.team, m.ball.pos) < 30) {
    const gk = m.opp(p.team).players[0];
    const side = Math.abs(gk.pos.z) > 0.3 ? -Math.sign(gk.pos.z) : m.rng.chance(0.5) ? 1 : -1;
    const { target, curl } = shotAim(m, p, m.rng.range(0.55, 0.85), true, side);
    target.y = Math.max(target.y, 1.5);
    m.orderKick(p, 'finesse', target, 0.75, null, curl);
    return;
  }
  if (kind === 'goalkick') {
    gkDistribute(m, p, false);
    return;
  }
  // throw-in / free kick: safest useful option
  const kinds: KickKind[] = kind === 'throwin' ? ['pass'] : ['pass', 'lob'];
  const opts = passOptions(m, p, null, kinds).filter((o) => kind !== 'throwin' || o.to.pos.distanceTo(p.pos) < 22);
  const o = opts[0];
  if (o) m.orderKick(p, kind === 'throwin' ? 'throwin' : o.kind, o.target, 0.6, o.to);
  else {
    const q = m.nearestOutfield(p.team, p.pos, p);
    m.orderKick(p, kind === 'throwin' ? 'throwin' : 'pass', q.pos.clone(), 0.6, q);
  }
}

function playAI(m: Match, p: Player, dt: number, chaser: boolean, cover: boolean, path: { t: number; p: Vector3 }[] | null) {
  if (p.action === 'fallen' || p.action === 'slide') {
    p.desired.set(0, 0, 0);
    return;
  }
  const t = m.teams[p.team];
  const owner = m.owner;
  if (owner === p) {
    carrierAI(m, p, dt);
    return;
  }
  // receiving a pass
  if (p.receiving && m.pass?.to === p && !owner) {
    const target = m.pass.target;
    // meet the ball: if the ball is already close, go straight to it
    const bd = Math.hypot(m.ball.pos.x - p.pos.x, m.ball.pos.z - p.pos.z);
    if (bd < 4) steer(p, m.ball.pos, true, 0.5);
    else steer(p, target, true, 1);
    return;
  }
  if (chaser) {
    if (!owner) {
      const it = new Vector3();
      if (path) interceptTime(p, path, it);
      else it.copy(m.ball.pos);
      steer(p, it, true, 0.3);
      return;
    }
    if (owner.team !== p.team) {
      press(m, p, owner, dt);
      return;
    }
  }
  if (cover && owner && owner.team !== p.team) {
    const own = new Vector3(m.ownGoalX(p.team), 0, 0);
    const dir = own.clone().sub(owner.pos).setY(0).normalize();
    const target = owner.pos.clone().addScaledVector(dir, 7).setY(0);
    steer(p, target, true, 2);
    return;
  }
  // positional play (re-think target a few times per second)
  if (p.thinkT <= 0 || !p.runTarget) {
    p.thinkT = 0.25 + m.rng.next() * 0.2;
    const target = formationTarget(m, p, new Vector3());
    if (owner && owner.team === p.team) {
      // attacking runs
      if (p.role === 'FWD' || (p.role === 'MID' && m.rng.chance(0.4))) {
        const defLine = lastDefenderX(m, p.team);
        const runX = defLine + t.attackDir * (p.role === 'FWD' ? -0.5 : -3);
        if ((runX - target.x) * t.attackDir > 0) target.x = runX;
      }
      findSpace(m, p, target);
    }
    p.runTarget = target;
  }
  const urgent = owner ? owner.team !== p.team : true;
  steer(p, p.runTarget, urgent && p.pos.distanceTo(p.runTarget) > 8, 2.5);
}

/** x of the opponents' deepest outfield player (offside-ish line) */
function lastDefenderX(m: Match, team: number) {
  const dir = m.teams[team].attackDir;
  let best = -1e9;
  for (const q of m.teams[1 - team].players) {
    if (q.role === 'GK') continue;
    const v = q.pos.x * dir;
    if (v > best) best = v;
  }
  return best * dir;
}

/** nudge target away from nearby opponents */
function findSpace(m: Match, p: Player, target: Vector3) {
  for (const q of m.teams[1 - p.team].players) {
    const dx = target.x - q.pos.x, dz = target.z - q.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 5 && d > 0.01) {
      target.z += (dz / d) * (5 - d) * 0.6;
      target.x += (dx / d) * (5 - d) * 0.3;
    }
  }
  const f = m.field;
  target.x = Math.max(-f.length / 2 + 2, Math.min(f.length / 2 - 2, target.x));
  target.z = Math.max(-f.width / 2 + 1.5, Math.min(f.width / 2 - 1.5, target.z));
}

function press(m: Match, p: Player, owner: Player, dt: number) {
  const own = new Vector3(m.ownGoalX(p.team), 0, 0);
  const toGoal = own.clone().sub(owner.pos).setY(0).normalize();
  const target = owner.pos.clone().addScaledVector(toGoal, 0.8).addScaledVector(owner.vel, 0.25);
  steer(p, target, true, 0.6);
  const d = Math.hypot(m.ball.pos.x - p.pos.x, m.ball.pos.z - p.pos.z);
  if (p.busy || m.time - p.lastTackleT < 1.0 || owner.holding) return;
  const skill = m.teams[p.team].skill;
  const rate = 0.5 + 1.0 * skill;
  if (d < 1.5 && m.rng.chance(rate * dt)) {
    m.startTackle(p);
  } else if (d < 3 && d > 1.4 && owner.speed > 4 && m.rng.chance(0.25 * dt * skill)) {
    // slide if beaten
    const dir = m.ball.pos.clone().addScaledVector(m.ball.vel, 0.15).sub(p.pos).setY(0);
    m.startSlide(p, dir);
  }
}

function carrierAI(m: Match, p: Player, dt: number) {
  const t = m.teams[p.team];
  const f = m.field;
  const gx = m.attackGoalX(p.team);
  const dir = t.attackDir;
  if (p.busy) {
    p.desired.set(0, 0, 0);
    return;
  }
  const distGoal = Math.hypot(gx - p.pos.x, p.pos.z);
  const pressure = nearestOpponentDist(m, p.team, p.pos);
  const skill = t.skill;

  if (p.thinkT <= 0 && m.ownerT > 0.2) {
    p.thinkT = 0.18 + (1 - skill) * 0.25 + m.rng.next() * 0.1;
    // --- shoot? ---
    const angleOpen = Math.abs(p.pos.z) / Math.max(1, Math.abs(gx - p.pos.x));
    const facingGoal = ((gx - p.pos.x) * p.face.x + -p.pos.z * p.face.z) / (distGoal || 1);
    const range = Math.min(28, f.length * 0.32);
    if (distGoal < range && angleOpen < 1.8 && facingGoal > -0.5) {
      const blockers = laneSafety(m, p.team, m.ball.pos, new Vector3(gx, 0, 0));
      let q = (1 - distGoal / (range + 2)) * 1.6 - angleOpen * 0.3 + (blockers > 0 ? 0.3 : -0.05);
      if (distGoal < 16) q += 0.5;
      if (pressure < 2 && distGoal < 22) q += 0.3;
      if (m.rng.chance(Math.max(0, q) * (0.6 + skill * 0.5))) {
        const gk = m.opp(p.team).players[0];
        const side = Math.abs(gk.pos.z) > 0.4 ? -Math.sign(gk.pos.z) : m.rng.chance(0.5) ? 1 : -1;
        const gkOff = Math.abs(gk.pos.x - gx);
        if (gkOff > 5 && distGoal < 22 && distGoal > 9 && m.rng.chance(0.25)) {
          m.orderKick(p, 'chip', new Vector3(gx, 0, side * 1.5), 0.6);
          return;
        }
        const finesse = distGoal > 12 && m.rng.chance(0.55);
        const power = finesse ? m.rng.range(0.5, 0.85) : m.rng.range(0.55, 0.92);
        const { target, curl } = shotAim(m, p, power, finesse, side);
        m.orderKick(p, finesse ? 'finesse' : 'shot', target, power, null, curl);
        return;
      }
    }
    // --- cross from wide areas ---
    const wide = Math.abs(p.pos.z) > f.boxHalfW - 1 && Math.abs(gx - p.pos.x) < 22;
    if (wide && m.rng.chance(0.55)) {
      const inBox = t.players.filter((q) => q !== p && Math.abs(q.pos.x - gx) < f.boxDepth + 1 && Math.abs(q.pos.z) < f.boxHalfW);
      if (inBox.length) {
        const q = inBox.sort((a, b) => Math.abs(a.pos.z) - Math.abs(b.pos.z))[0];
        m.orderKick(p, 'cross', q.pos.clone().addScaledVector(q.vel, 0.8), 0.7, q);
        return;
      }
    }
    // --- clear under pressure in own box ---
    if (m.inBox(p.team, p.pos, 3) && pressure < 3 && p.role === 'DEF') {
      const target = new Vector3(p.pos.x + dir * 35, 0, Math.sign(p.pos.z || 1) * f.width * 0.35);
      m.orderKick(p, 'clear', target, 0.8);
      return;
    }
    // --- pass? ---
    const opts = passOptions(m, p, null);
    const best = opts[0];
    const ahead = new Vector3(p.pos.x + dir * 6, 0, p.pos.z);
    const space = nearestOpponentDist(m, p.team, ahead);
    const underPressure = pressure < 1.8;
    if (best && best.score > 0) {
      const progress = (best.target.x - p.pos.x) * dir;
      let go = false;
      if (underPressure) go = m.ownerT > 0.3 && m.rng.chance(0.6 + 0.3 * skill);
      else if (space > 6) go = progress > 10 && best.score > 1.6 && m.rng.chance(0.4);
      else go = m.ownerT > 0.5 && m.rng.chance(0.45);
      if (go) {
        m.orderKick(p, best.kind, best.target, 0.6, best.to);
        return;
      }
    }
  }
  // --- dribble ---
  const target = new Vector3(gx - dir * 9, 0, p.pos.z * 0.6);
  const want = target.sub(p.pos).setY(0).normalize();
  for (const q of m.teams[1 - p.team].players) {
    const dx = p.pos.x - q.pos.x, dz = p.pos.z - q.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 6 && d > 0.01) {
      const inFront = -(dx * want.x + dz * want.z) / d;
      if (inFront > -0.2) {
        const w = ((6 - d) / 6) * 1.4;
        // step away from the side the opponent is on (perpendicular to the wanted direction)
        const px = -want.z, pz = want.x;
        const side = Math.sign(-dx * px + -dz * pz) || 1;
        want.x -= px * side * w;
        want.z -= pz * side * w;
      }
    }
  }
  if (Math.abs(p.pos.z) > f.width / 2 - 3) want.z -= Math.sign(p.pos.z) * 0.8;
  want.normalize();
  p.sprint = pressure > 3.5 || m.rng.chance(0.02);
  const sp = p.maxSpeed(true);
  p.desired.set(want.x * sp, 0, want.z * sp);
}

// --------------------------------------------------------------------------

export function gkDistribute(m: Match, gk: Player, fromHands: boolean) {
  const t = m.teams[gk.team];
  const short = passOptions(m, gk, null, ['pass']).filter((o) => o.to.role === 'DEF' && Math.min(10, nearestOpponentDist(m, gk.team, o.to.pos)) > 7 && o.to.pos.distanceTo(gk.pos) < 30);
  if (short.length && m.rng.chance(0.6)) {
    const o = short[0];
    m.orderKick(gk, fromHands ? 'throwin' : 'pass', o.target, 0.6, o.to);
    return;
  }
  const fwd = t.players.filter((q) => q.role === 'MID' || q.role === 'FWD');
  const q = fwd.length ? m.rng.pick(fwd) : t.players[1];
  const target = q.pos.clone();
  target.x = Math.max(-m.field.length / 2 + 5, Math.min(m.field.length / 2 - 5, target.x));
  m.orderKick(gk, 'punt', target, 0.9, q);
}

export function gkThink(m: Match, gk: Player, dt: number) {
  if (gk === m.controlled) return;
  const f = m.field;
  const gx = m.ownGoalX(gk.team);
  const dirIn = -Math.sign(gx);
  const phase = m.phase;
  if (phase === 'goal' || phase === 'halftime' || phase === 'fulltime') {
    steer(gk, new Vector3(gx + dirIn * 1.5, 0, 0), false, 2);
    return;
  }
  if (phase === 'kickoff' || phase === 'setpiece') {
    if (m.setPiece?.taker === gk) {
      setPieceAI(m, gk);
      return;
    }
    steer(gk, gk.spot ?? new Vector3(gx + dirIn * 1, 0, 0), true, 1);
    return;
  }
  if (gk.action === 'dive' || gk.action === 'kick' || gk.action === 'throw') return;
  if (gk.action === 'fallen') return;

  // holding the ball: distribute
  if (gk.holding) {
    gk.holdT += dt;
    steer(gk, new Vector3(gx + dirIn * (f.smallBoxDepth + 2), 0, gk.pos.z * 0.5), false, 2);
    if (gk.holdT > 1.4) {
      gkDistribute(m, gk, m.rng.chance(0.5));
    }
    return;
  }
  if (m.owner === gk) {
    // ball at feet (back-pass): clear it
    if (m.ownerT > 0.4) gkDistribute(m, gk, false);
    gk.desired.set(0, 0, 0);
    return;
  }

  // react to shots
  const shot = m.shot;
  const reaction = 0.08 + (1 - gk.stats.gk) * 0.25 + (m.humanTeam >= 0 && gk.team !== m.humanTeam ? m.diff.reaction * 0.3 : 0.05);
  if (shot && shot.team !== gk.team && !shot.handled && m.time - shot.t0 > reaction) {
    shot.handled = true;
    const elapsed = m.time - shot.t0;
    // find crossing of the keeper's plane
    let P: Vector3 | null = null;
    let tP = 0;
    for (let i = 1; i < shot.path.length; i++) {
      const a = shot.path[i - 1].p, c = shot.path[i].p;
      if ((a.x - gk.pos.x) * (c.x - gk.pos.x) <= 0 && shot.path[i].t > elapsed) {
        const k = (gk.pos.x - a.x) / (c.x - a.x || 1e-6);
        P = a.clone().lerp(c, k);
        tP = shot.path[i - 1].t + (shot.path[i].t - shot.path[i - 1].t) * k - elapsed;
        break;
      }
    }
    if (P && (shot.onTarget || Math.abs(P.z) < f.goalHalfW + 0.6)) {
      const lateral = P.z - gk.pos.z;
      const speed = m.ball.vel.length();
      const skill = gk.stats.gk * (m.humanTeam >= 0 && gk.team !== m.humanTeam ? 0.85 + 0.25 * m.diff.gk : 1);
      if (Math.abs(lateral) < 0.8 && P.y < 1.9) {
        // straight at him: shuffle across, contact logic catches it
        gk.desired.set(0, 0, Math.sign(lateral) * 3);
        return;
      }
      const reachTime = Math.max(0.12, tP);
      const difficulty = Math.abs(lateral) / (1.5 + reachTime * 5.5) + Math.max(0, P.y - 1.9) * 0.4;
      const corner = Math.abs(P.z) > f.goalHalfW - 0.8 && (P.y > 1.6 || P.y < 0.5) ? 0.15 : 0;
      let pSave = skill * 1.0 - difficulty * 0.9 - Math.max(0, speed - 18) / 30 - corner * 1.5;
      if (!shot.onTarget) pSave = 0.9;
      pSave = Math.max(0.04, Math.min(0.92, pSave));
      const saves = difficulty < 1.15 && m.rng.chance(pSave);
      const target = new Vector3(gk.pos.x, Math.min(2.4, Math.max(0.3, P.y)), P.z);
      if (!saves) target.z -= Math.sign(lateral) * Math.min(Math.abs(lateral) * 0.5, 1.1);
      target.z -= Math.sign(lateral) * 0.55; // body is offset from hands
      m.startDive(gk, target, reachTime, saves);
      return;
    }
  }

  // positioning: on the line between ball and goal centre
  const b = m.ball.pos;
  const vx = b.x - gx, vz = b.z;
  const d = Math.hypot(vx, vz) || 1;
  const off = Math.max(0.6, Math.min(4.5, d * 0.11));
  const target = new Vector3(gx + (vx / d) * off, 0, (vz / d) * off);
  target.z = Math.max(-f.goalHalfW + 0.3, Math.min(f.goalHalfW - 0.3, target.z));
  if ((target.x - gx) * dirIn < 0.4) target.x = gx + dirIn * 0.4;

  // rush out for loose balls in the box or 1v1s
  const owner = m.owner;
  if (!owner && m.inBox(gk.team, b, -1) && b.y < 2.2) {
    let mine = Math.hypot(b.x - gk.pos.x, b.z - gk.pos.z) / 7;
    let theirs = 99;
    for (const q of m.opp(gk.team).players) theirs = Math.min(theirs, Math.hypot(b.x - q.pos.x, b.z - q.pos.z) / 7.5);
    if (mine < theirs + 0.15) {
      steer(gk, b, true, 0.3);
      return;
    }
    void mine;
  }
  if (owner && owner.team !== gk.team && Math.hypot(owner.pos.x - gx, owner.pos.z) < f.boxDepth * 0.8) {
    const toward = owner.pos.clone().sub(new Vector3(gx, 0, 0)).setY(0);
    const dist = toward.length();
    toward.normalize().multiplyScalar(Math.min(dist - 1.5, Math.max(1.5, dist * 0.45)));
    target.set(gx + toward.x, 0, toward.z);
    steer(gk, target, true, 0.8);
    if (dist < 3.2 && m.rng.chance(dt * 2 * gk.stats.gk)) m.startSlide(gk, owner.pos.clone().sub(gk.pos));
    return;
  }
  steer(gk, target, false, 1.5);
}
