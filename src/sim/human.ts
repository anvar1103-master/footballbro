import { Vector3 } from 'three';
import type { InputState, Match } from './match';
import { passOptions, shotAim, takeSetPiece } from './ai';
import { Player } from './player';

/**
 * Human control of one player of `m.humanTeam`, FIFA style and context sensitive.
 * Screen mapping: the broadcast camera looks towards -z, so stick right = +x, stick up = -z.
 *
 * With the ball (hold = power, release = kick):
 *   pass · through ball · lob/cross · shot · finesse shot · chip shot · skill (feint)
 * Without the ball:
 *   pass (hold) = contain / jockey · shoot = standing tackle · lob = slide tackle
 *   through (hold) = second man press · switch = change player
 */

const POWER_TIME = 0.85; // seconds to a full power bar
const TAP = 0.12; // shorter than this is a tap (assisted short pass)
let autoSwitchT = 0;
/** last stick direction while a kick was being charged (used if the stick is released first) */
let chargeAim: Vector3 | null = null;

type ChargeKind = NonNullable<Player['chargeKind']>;
const CHARGE_KEYS: [ChargeKind, keyof InputState][] = [
  ['shot', 'shoot'],
  ['finesse', 'finesse'],
  ['chip', 'chip'],
  ['pass', 'pass'],
  ['through', 'through'],
  ['lob', 'lob'],
];

function pressed(m: Match, input: InputState, k: keyof InputState) {
  return !!input[k] && !m.prevInput[k];
}

export function stickDir(input: InputState): Vector3 | null {
  const l = Math.hypot(input.mx, input.my);
  if (l < 0.2) return null;
  return new Vector3(input.mx / l, 0, -input.my / l);
}

/** whoever is closest to where the ball will be in ~0.4 s */
function switchCandidate(m: Match): Player | null {
  const cur = m.controlled;
  const fut = m.ball.pos.clone().addScaledVector(m.ball.vel, 0.4);
  let best: Player | null = null;
  let bd = 1e9;
  for (const p of m.teams[m.humanTeam].players) {
    if (p === cur || p.role === 'GK') continue;
    const d = Math.hypot(p.pos.x - fut.x, p.pos.z - fut.z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

function setControlled(m: Match, p: Player) {
  if (m.controlled) {
    m.controlled.jockey = false;
    m.controlled.charge = 0;
    m.controlled.chargeKind = null;
  }
  m.controlled = p;
}

export function humanControl(m: Match, input: InputState, dt: number) {
  if (!m.controlled || m.controlled.team !== m.humanTeam) setControlled(m, m.nearestOutfield(m.humanTeam, m.ball.pos));
  const c = m.controlled!;
  const dir = stickDir(input);
  const mag = Math.min(1, Math.hypot(input.mx, input.my));
  const sp = m.setPiece;
  m.teammatePress = false;
  c.jockey = false;
  m.switchTarget = m.phase === 'play' && m.owner !== c ? switchCandidate(m) : null;

  // ---- set pieces ----
  if (m.phase === 'kickoff' || m.phase === 'setpiece') {
    if (sp && sp.taker === c && sp.ready) {
      c.desired.set(0, 0, 0);
      if (dir) c.turnTowards(dir.x, dir.z, dt, 5);
      if (c.busy) return;
      const kind = chargeAndRelease(m, c, input, dt, sp.kind === 'throwin' || sp.kind === 'kickoff' ? ['pass', 'through', 'lob'] : undefined);
      if (kind) executeKick(m, c, kind, input, dir ?? chargeAim ?? c.face.clone(), sp.kind);
      else if (sp.readyT > 12 && !c.chargeKind) takeSetPiece(m, c, sp.kind);
      return;
    }
    return; // the AI walks him to his spot
  }
  if (m.phase !== 'play') return;

  // ---- switching ----
  if (pressed(m, input, 'switch') && m.owner !== c) {
    const t = switchCandidate(m);
    if (t) setControlled(m, t);
    return;
  }
  autoSwitchT -= dt;
  if (autoSwitchT <= 0 && m.owner !== c) {
    autoSwitchT = 0.6;
    const toBall = Math.hypot(c.pos.x - m.ball.pos.x, c.pos.z - m.ball.pos.z);
    const nearest = m.nearestOutfield(m.humanTeam, m.ball.pos);
    const nd = Math.hypot(nearest.pos.x - m.ball.pos.x, nearest.pos.z - m.ball.pos.z);
    const oppBall = m.owner && m.owner.team !== m.humanTeam;
    const ourPass = !!m.pass && m.pass.to.team === m.humanTeam;
    if (nearest !== c && !ourPass && toBall > 16 && nd < toBall - 8 && (oppBall || !m.owner) && !input.pass) setControlled(m, nearest);
  }
  if (m.owner && m.owner.team === m.humanTeam && m.owner !== c && m.owner.role !== 'GK') setControlled(m, m.owner);

  // ---- movement ----
  c.sprint = input.sprint;
  const max = c.maxSpeed(m.owner === c);
  if (dir) c.desired.set(dir.x * max * mag, 0, dir.z * max * mag);
  else c.desired.set(0, 0, 0);
  if (c.busy) return;

  const ballDist = Math.hypot(m.ball.pos.x - c.pos.x, m.ball.pos.z - c.pos.z);
  const canPlay = m.owner === c || (!m.owner && ballDist < 2.2 && m.ball.pos.y < 1.3);

  if (canPlay) {
    if (pressed(m, input, 'skill') && m.owner === c) {
      // feint to the stick side (or a random side)
      const side = new Vector3(-c.face.z, 0, c.face.x);
      let s = dir ? Math.sign(dir.dot(side)) : 0;
      if (!s) s = m.rng.chance(0.5) ? 1 : -1;
      c.setAction('skill', 0.42);
      c.actionDir.copy(side).multiplyScalar(s);
      return;
    }
    const kind = chargeAndRelease(m, c, input, dt);
    if (kind) executeKick(m, c, kind, input, dir ?? chargeAim ?? c.face.clone(), null);
    return;
  }
  c.charge = 0;
  c.chargeKind = null;

  // ---- defending ----
  const owner = m.owner;
  const oppBall = owner && owner.team !== c.team;
  if (input.through && oppBall) m.teammatePress = true;
  if (input.pass) {
    if (oppBall) {
      // contain: shadow the carrier goal-side, facing him, at a safe distance
      c.jockey = true;
      const own = new Vector3(m.ownGoalX(c.team), 0, 0);
      const toGoal = own.sub(owner.pos).setY(0).normalize();
      const spot = owner.pos.clone().addScaledVector(toGoal, 1.6).addScaledVector(owner.vel, 0.25);
      const dx = spot.x - c.pos.x, dz = spot.z - c.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const s = Math.min(c.maxSpeed(false), d * 3);
      c.desired.set((dx / d) * s, 0, (dz / d) * s);
      if (dir) c.desired.addScaledVector(dir, 1.5);
    } else if (!dir) {
      // loose ball: run onto it
      const dx = m.ball.pos.x - c.pos.x, dz = m.ball.pos.z - c.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const s = c.maxSpeed(false);
      c.desired.set((dx / d) * s, 0, (dz / d) * s);
    }
  }
  if (pressed(m, input, 'shoot')) {
    // standing tackle; lunge towards the ball if slightly too far
    if (oppBall && Math.hypot(owner.pos.x - c.pos.x, owner.pos.z - c.pos.z) < 2.4) {
      c.face.set(m.ball.pos.x - c.pos.x, 0, m.ball.pos.z - c.pos.z).normalize();
      m.startTackle(c);
    } else if (!dir) {
      const dx = m.ball.pos.x - c.pos.x, dz = m.ball.pos.z - c.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      c.desired.set((dx / d) * max, 0, (dz / d) * max);
    }
  }
  if (pressed(m, input, 'lob')) {
    const target = m.ball.pos.clone().addScaledVector(m.ball.vel, 0.2);
    m.startSlide(c, dir ?? target.sub(c.pos).setY(0));
  }
}

/**
 * Charge a kick while its button is held; returns the kick kind on release.
 * Modifiers: holding finesse/chip while releasing shoot turns the shot into that kind.
 */
function chargeAndRelease(m: Match, c: Player, input: InputState, dt: number, allowed?: ChargeKind[]): ChargeKind | null {
  if (!c.chargeKind) {
    for (const [kind, key] of CHARGE_KEYS) {
      if (allowed && !allowed.includes(kind)) continue;
      if (pressed(m, input, key)) {
        c.chargeKind = kind;
        c.charge = 0;
        chargeAim = stickDir(input);
        break;
      }
    }
    return null;
  }
  const key = CHARGE_KEYS.find(([k]) => k === c.chargeKind)![1];
  if (input[key]) {
    c.charge += dt;
    chargeAim = stickDir(input) ?? chargeAim;
    return null;
  }
  let kind = c.chargeKind;
  if (kind === 'shot' && input.finesse) kind = 'finesse';
  if (kind === 'shot' && input.chip) kind = 'chip';
  c.chargeKind = null;
  return kind;
}

function power(c: Player) {
  return Math.min(1, Math.max(0.15, c.charge / POWER_TIME));
}

function executeKick(m: Match, c: Player, kind: ChargeKind, input: InputState, aim: Vector3, setPiece: string | null) {
  const tap = c.charge < TAP;
  const pw = power(c);
  c.charge = 0;
  const f = m.field;
  const handThrow = setPiece === 'throwin';
  if (kind === 'shot' || kind === 'finesse' || kind === 'chip') {
    const gk = m.opp(c.team).players[0];
    const sz = -input.my;
    const side = Math.abs(sz) > 0.3 ? Math.sign(sz) : Math.abs(gk.pos.z) > 0.4 ? -Math.sign(gk.pos.z) : -Math.sign(c.pos.z || 1);
    const { target, curl } = shotAim(m, c, kind === 'chip' ? 0.5 : pw, kind === 'finesse', side);
    m.orderKick(c, kind, target, pw, null, curl);
    return;
  }
  // preferred pass length grows with power (a tap = nearest good option)
  const pref = tap ? 10 : 6 + pw * (kind === 'lob' ? 50 : 38);
  const rank = (kinds: ('pass' | 'through' | 'lob')[]) =>
    passOptions(m, c, aim, kinds)
      .map((o) => ({ o, s: o.score - Math.abs(o.to.pos.distanceTo(c.pos) - pref) * 0.05 }))
      .sort((a, b) => b.s - a.s)[0]?.o;
  if (kind === 'pass') {
    const o = rank(['pass']);
    const k = handThrow ? 'throwin' : 'pass';
    if (o) m.orderKick(c, k, o.target, tap ? 0.45 : pw, o.to);
    else m.orderKick(c, k, c.pos.clone().addScaledVector(aim, 6 + pw * 25), pw);
    return;
  }
  if (kind === 'through') {
    const o = rank(['through', 'pass']);
    if (o) {
      const lead = o.target.clone();
      if (o.kind === 'through') lead.addScaledVector(new Vector3(m.teams[c.team].attackDir, 0, 0), (pw - 0.5) * 6);
      m.orderKick(c, handThrow ? 'throwin' : o.kind === 'through' ? 'through' : 'pass', lead, pw, o.to);
    } else m.orderKick(c, handThrow ? 'throwin' : 'through', c.pos.clone().addScaledVector(aim, 10 + pw * 20), pw);
    return;
  }
  // lob / cross
  const gx = m.attackGoalX(c.team);
  const wide = Math.abs(c.pos.z) > f.boxHalfW - 2 && Math.abs(gx - c.pos.x) < 28;
  if ((wide && !handThrow) || setPiece === 'corner') {
    const inBox = m.teams[c.team].players.filter((q) => q !== c && Math.abs(q.pos.x - gx) < f.boxDepth + 2 && Math.abs(q.pos.z) < f.boxHalfW);
    // aim decides near / far post
    const q = inBox.sort((a, b) => a.pos.distanceTo(c.pos.clone().addScaledVector(aim, 20)) - b.pos.distanceTo(c.pos.clone().addScaledVector(aim, 20)))[0];
    const target = q ? q.pos.clone().addScaledVector(q.vel, 0.8) : new Vector3(gx - Math.sign(gx) * f.penaltySpot, 0, 0);
    m.orderKick(c, 'cross', target, pw, q ?? null);
    return;
  }
  const o = rank(['lob', 'pass']);
  const k = handThrow ? 'throwin' : 'lob';
  if (o) m.orderKick(c, k, o.target, pw, o.to);
  else m.orderKick(c, k, c.pos.clone().addScaledVector(aim, 12 + pw * 35), pw);
}

/** current charge 0..1 for the HUD */
export function chargeLevel(p: Player | null) {
  return p && p.chargeKind ? Math.min(1, p.charge / POWER_TIME) : 0;
}
