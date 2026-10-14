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
      for (const [dx, dz] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [3.5, 0]])
        for (const type of ['pass', 'lob'] as const) out.push({ type, target: new Vector3(r.x + dx, 0, r.z + dz), curl: 0 });
  }
  return out;
}

export interface SolveReport {
  solved: boolean;
  best: number;
  bestSeq: Action[];
  /** share of grid shots that score from the best shooting position */
  shotRate: number;
  tried: number;
}

export function solve(level: LevelDef, maxDepth = 3, fine = false): SolveReport {
  let best = -1;
  let bestSeq: Action[] = [];
  let bestRate = 0;
  let tried = 0;
  const visit = (seq: Action[], depth: number) => {
    const m = play(level, seq);
    if (m.phase !== 'aim') return;
    let goals = 0;
    const shots = shotGrid(fine);
    for (const s of shots) {
      const r = play(level, [...seq, s]);
      tried++;
      for (let seed = 2; seed <= 3; seed++) if (play(level, [...seq, s], seed).result?.ok) goals += 0.5;
      if (r.result?.ok) {
        if (r.result.points > best) {
          best = r.result.points;
          bestSeq = [...seq, s];
        }
      }
    }
    bestRate = Math.max(bestRate, goals / shots.length / 1);
    if (depth >= maxDepth) return;
    for (const p of passOptions(m)) {
      const r = play(level, [...seq, p]);
      tried++;
      if (r.phase === 'aim') visit([...seq, p], depth + 1);
    }
  };
  visit([], 1);
  return { solved: best > 0, best, bestSeq, shotRate: bestRate, tried };
}
