import { Vector3 } from 'three';
import { Action, GOAL_X, HW, Moment } from './sim';
import type { LevelDef } from './levels';

/**
 * Brute-force solver used by the tests (every level must be beatable) and for balancing:
 * replays action sequences from scratch (the sim is deterministic) and searches passes + shots.
 */

export function play(level: LevelDef, actions: Action[], seed = 1) {
  const m = new Moment(level, seed);
  for (const a of actions) {
    if (m.phase !== 'aim') break;
    m.act(a);
    let guard = 0;
    while (busy(m) && guard++ < 1500) m.step();
  }
  return m;
}

const busy = (m: Moment) => m.phase === 'windup' || m.phase === 'fly';

export function shotGrid(fine = false): Action[] {
  const out: Action[] = [];
  const zs = fine ? 13 : 9;
  for (let i = 0; i < zs; i++) {
    const z = -HW + 0.35 + (i / (zs - 1)) * (2 * HW - 0.7);
    for (const y of fine ? [0.3, 0.9, 1.5, 2.1] : [0.35, 1.3, 2.1])
      for (const curl of fine ? [-0.9, -0.5, 0, 0.5, 0.9] : [-0.8, 0, 0.8]) out.push({ type: 'shot', target: new Vector3(GOAL_X, y, z), curl });
  }
  return out;
}

export function passOptions(m: Moment): Action[] {
  const out: Action[] = [];
  for (const a of m.actors) {
    if (a.team !== 0 || a === m.holder) continue;
    const run = a.runs[m.kicks];
    const refs = [a.pos.clone()];
    if (run && run.length) refs.push(run[run.length - 1].clone());
    for (const r of refs)
      for (const [dx, dz] of [[0, 0], [2.5, 0], [0, 2], [0, -2]])
        for (const type of ['pass', 'lob'] as const) out.push({ type, target: new Vector3(r.x + dx, 0, r.z + dz), curl: 0 });
  }
  return out;
}

export interface SolveReport {
  solved: boolean;
  best: number;
  bestSeq: Action[];
  /** share of grid shots (3 seeds) that score from the best shooting position */
  shotRate: number;
  tried: number;
}

/** pass / lob targets on a grid ahead of the ball (plus each team-mate's position and run end) */
export function passGrid(m: Moment): Action[] {
  const out: Action[] = [];
  const b = m.ball.pos;
  for (let d = 3; d <= 42; d += 3)
    for (let z = -24; z <= 24; z += 3) {
      const x = GOAL_X - d;
      if (x < b.x - 8) continue;
      for (const type of ['pass', 'lob'] as const) out.push({ type, target: new Vector3(x, 0, z), curl: 0 });
    }
  return [...out, ...passOptions(m)];
}

/**
 * Search: from each frozen moment take the 3 best receptions (closest to goal, distinct receiver/touch),
 * up to `maxDepth` touches, and finish with the shot grid.
 */
export function solve(level: LevelDef, maxDepth = 3): SolveReport {
  let best = -1;
  let bestSeq: Action[] = [];
  let bestRate = 0;
  let tried = 0;
  const visit = (seq: Action[], depth: number) => {
    const m = play(level, seq);
    if (m.phase !== 'aim') return;
    let goals = 0;
    const shots = shotGrid();
    for (const s of shots) {
      for (let seed = 1; seed <= 3; seed++) {
        const r = play(level, [...seq, s], seed);
        tried++;
        if (!r.result?.ok) continue;
        goals++;
        if (seed === 1 && r.result.points > best) {
          best = r.result.points;
          bestSeq = [...seq, s];
        }
      }
    }
    bestRate = Math.max(bestRate, goals / shots.length / 3);
    if (depth >= maxDepth) return;
    const ok: { p: Action; score: number; key: string }[] = [];
    for (const p of passGrid(m)) {
      const r = play(level, [...seq, p]);
      tried++;
      if (r.phase !== 'aim' || !r.holder) continue;
      const b = r.ball.pos;
      ok.push({ p, score: -Math.hypot(GOAL_X - b.x, b.z * 0.8) + (r.touch !== 'feet' ? 4 : 0), key: `${r.holder.id}:${r.touch}` });
    }
    ok.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    let n = 0;
    for (const o of ok) {
      if (seen.has(o.key) || n >= 3) continue;
      seen.add(o.key);
      n++;
      visit([...seq, o.p], depth + 1);
    }
  };
  visit([], 1);
  return { solved: best > 0, best, bestSeq, shotRate: bestRate, tried };
}
