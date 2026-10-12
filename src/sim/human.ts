import { Vector3 } from 'three';
import type { InputState, Match } from './match';
import { passOptions, shotAim, takeSetPiece } from './ai';
import { Player } from './player';

/**
 * Human control of one player of `m.humanTeam`.
 * Screen mapping: the broadcast camera looks towards -z, so stick right = +x, stick up = -z.
 *
 * With the ball:     K pass · L through ball · O lob/cross · J (hold) shot · I (hold) finesse shot
 * Without the ball:  K (hold) press + standing tackle · J slide tackle · Space switch player
 */

const POWER_TIME = 0.85;
let autoSwitchT = 0;

function pressed(m: Match, input: InputState, k: keyof InputState) {
  return !!input[k] && !m.prevInput[k];
}
function released(m: Match, input: InputState, k: keyof InputState) {
  return !input[k] && !!m.prevInput[k];
}

export function stickDir(input: InputState): Vector3 | null {
  const l = Math.hypot(input.mx, input.my);
  if (l < 0.2) return null;
  return new Vector3(input.mx / l, 0, -input.my / l);
}

function switchPlayer(m: Match) {
  const cur = m.controlled;
  const b = m.ball.pos;
  // prefer whoever is closest to where the ball will be in ~0.4s
  const fut = b.clone().addScaledVector(m.ball.vel, 0.4);
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
  if (best) m.controlled = best;
}

export function humanControl(m: Match, input: InputState, dt: number) {
  if (!m.controlled || m.controlled.team !== m.humanTeam) {
    m.controlled = m.nearestOutfield(m.humanTeam, m.ball.pos);
  }
  const c = m.controlled;
  const dir = stickDir(input);
  const mag = Math.min(1, Math.hypot(input.mx, input.my));
  const sp = m.setPiece;

  // ---- set pieces ----
  if (m.phase === 'kickoff' || m.phase === 'setpiece') {
    if (sp && sp.taker === c && sp.ready) {
      c.desired.set(0, 0, 0);
      if (dir) c.turnTowards(dir.x, dir.z, dt, 5);
      if (c.busy) return;
      const aim = dir ?? c.face.clone();
      if (pressed(m, input, 'pass') || pressed(m, input, 'through')) {
        const opts = passOptions(m, c, aim, ['pass']);
        if (opts[0]) m.orderKick(c, sp.kind === 'throwin' ? 'throwin' : 'pass', opts[0].target, 0.6, opts[0].to);
        else m.orderKick(c, sp.kind === 'throwin' ? 'throwin' : 'pass', c.pos.clone().addScaledVector(aim, 12), 0.6);
      } else if (pressed(m, input, 'lob')) {
        const opts = passOptions(m, c, aim, ['lob', 'pass']);
        const kind = sp.kind === 'corner' ? 'cross' : sp.kind === 'throwin' ? 'throwin' : 'lob';
        if (opts[0]) m.orderKick(c, kind, opts[0].target, 0.7, opts[0].to);
        else m.orderKick(c, kind, c.pos.clone().addScaledVector(aim, 25), 0.7);
      } else if (sp.kind !== 'throwin' && sp.kind !== 'kickoff' && (released(m, input, 'shoot') || released(m, input, 'finesse'))) {
        shoot(m, c, input, released(m, input, 'finesse'));
      } else if (sp.kind !== 'throwin' && sp.kind !== 'kickoff' && (input.shoot || input.finesse)) {
        c.charge += dt;
      } else if (sp.readyT > 12) {
        takeSetPiece(m, c, sp.kind);
      }
      return;
    }
    return; // AI walks him to his spot
  }
  if (m.phase !== 'play') return;

  // ---- switching ----
  if (pressed(m, input, 'switch') && m.owner !== c) {
    switchPlayer(m);
    return;
  }
  autoSwitchT -= dt;
  if (autoSwitchT <= 0 && m.owner !== c) {
    autoSwitchT = 0.6;
    const toBall = Math.hypot(c.pos.x - m.ball.pos.x, c.pos.z - m.ball.pos.z);
    const nearest = m.nearestOutfield(m.humanTeam, m.ball.pos);
    const nd = Math.hypot(nearest.pos.x - m.ball.pos.x, nearest.pos.z - m.ball.pos.z);
    const oppBall = m.owner && m.owner.team !== m.humanTeam;
    if (nearest !== c && toBall > 14 && nd < toBall - 7 && (oppBall || !m.owner) && !input.pass) m.controlled = nearest;
  }
  if (m.owner && m.owner.team === m.humanTeam && m.owner !== c && m.owner.role !== 'GK') m.controlled = m.owner;

  // ---- movement ----
  c.sprint = input.sprint;
  const max = c.maxSpeed(m.owner === c);
  if (dir) c.desired.set(dir.x * max * mag, 0, dir.z * max * mag);
  else c.desired.set(0, 0, 0);
  if (c.busy) return;

  const ballDist = Math.hypot(m.ball.pos.x - c.pos.x, m.ball.pos.z - c.pos.z);
  const canPlay = m.owner === c || (!m.owner && ballDist < 2.0 && m.ball.pos.y < 1.3);

  if (canPlay) {
    const aim = dir ?? c.face.clone();
    if (input.shoot || input.finesse) c.charge += dt;
    if (released(m, input, 'shoot') || released(m, input, 'finesse')) {
      shoot(m, c, input, released(m, input, 'finesse'));
      return;
    }
    if (pressed(m, input, 'pass')) {
      const opts = passOptions(m, c, aim, ['pass']);
      if (opts[0]) m.orderKick(c, 'pass', opts[0].target, 0.6, opts[0].to);
      else m.orderKick(c, 'pass', c.pos.clone().addScaledVector(aim, 14), 0.6);
      return;
    }
    if (pressed(m, input, 'through')) {
      const opts = passOptions(m, c, aim, ['through']);
      if (opts[0]) m.orderKick(c, 'through', opts[0].target, 0.6, opts[0].to);
      else m.orderKick(c, 'through', c.pos.clone().addScaledVector(aim, 18), 0.6);
      return;
    }
    if (pressed(m, input, 'lob')) {
      const gx = m.attackGoalX(c.team);
      const f = m.field;
      const wide = Math.abs(c.pos.z) > f.boxHalfW - 2 && Math.abs(gx - c.pos.x) < 25;
      if (wide) {
        const inBox = m.teams[c.team].players.filter((q) => q !== c && Math.abs(q.pos.x - gx) < f.boxDepth + 2 && Math.abs(q.pos.z) < f.boxHalfW);
        const q = inBox.sort((a, b) => Math.abs(a.pos.z) - Math.abs(b.pos.z))[0];
        const target = q ? q.pos.clone().addScaledVector(q.vel, 0.8) : new Vector3(gx - Math.sign(gx) * f.penaltySpot, 0, 0);
        m.orderKick(c, 'cross', target, 0.7, q ?? null);
        return;
      }
      const opts = passOptions(m, c, aim, ['lob']);
      if (opts[0]) m.orderKick(c, 'lob', opts[0].target, 0.7, opts[0].to);
      else m.orderKick(c, 'lob', c.pos.clone().addScaledVector(aim, 28), 0.7);
      return;
    }
    return;
  }
  c.charge = 0;

  // ---- defending ----
  const owner = m.owner;
  if (input.pass) {
    // press: auto-run at the ball / carrier
    const target = owner && owner.team !== c.team ? owner.pos.clone().addScaledVector(owner.vel, 0.2) : m.ball.pos.clone();
    const dx = target.x - c.pos.x, dz = target.z - c.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const s = c.maxSpeed(false);
    if (!dir) c.desired.set((dx / d) * s, 0, (dz / d) * s);
    if (owner && owner.team !== c.team && d < 1.6 && m.time - c.lastTackleT > 0.6) m.startTackle(c);
  }
  if (pressed(m, input, 'shoot')) {
    const target = m.ball.pos.clone().addScaledVector(m.ball.vel, 0.2);
    const sdir = dir ?? target.sub(c.pos).setY(0);
    m.startSlide(c, sdir);
  }
}

function shoot(m: Match, c: Player, input: InputState, finesse: boolean) {
  const power = Math.min(1, Math.max(0.15, c.charge / POWER_TIME));
  c.charge = 0;
  // side: stick lateral (screen up = -z), else far from the keeper
  const gk = m.opp(c.team).players[0];
  let side: number;
  const sz = -input.my;
  if (Math.abs(sz) > 0.3) side = Math.sign(sz);
  else side = Math.abs(gk.pos.z) > 0.4 ? -Math.sign(gk.pos.z) : -Math.sign(c.pos.z || 1);
  const { target, curl } = shotAim(m, c, power, finesse, side);
  m.orderKick(c, finesse ? 'finesse' : 'shot', target, power, null, curl);
}

/** current shot charge 0..1 for the HUD */
export function chargeLevel(p: Player | null) {
  return p ? Math.min(1, p.charge / POWER_TIME) : 0;
}
