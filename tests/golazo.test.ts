import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { LEVELS, LevelDef } from '../src/golazo/levels';
import { Action, GOAL_X, HW, Moment } from '../src/golazo/sim';
import { play, shotGrid } from '../src/golazo/bot';

const shot = (z: number, y: number, curl = 0): Action => ({ type: 'shot', target: new Vector3(GOAL_X, y, z), curl });
const pass = (x: number, z: number, type: 'pass' | 'lob' = 'pass'): Action => ({ type, target: new Vector3(x, 0, z), curl: 0 });
const lvl = (over: Partial<LevelDef>): LevelDef => ({ id: 99, chapter: 0, kind: 'open', title: 't', brief: '', mates: [{ at: [18, 0] }], opps: [], gk: 0.5, stars: [700, 900], ...over });

function runOut(m: Moment) {
  let g = 0;
  while ((m.phase === 'windup' || m.phase === 'fly') && g++ < 2000) m.step();
  return m;
}

describe('golazo kicks', () => {
  it('a shot goes exactly through the drawn point', () => {
    const m = new Moment(lvl({ gk: 0 }), 1);
    const a = shot(2.8, 1.6, 0.6);
    const path = m.preview(a);
    const i = path.findIndex((p) => p.x >= GOAL_X);
    const a0 = path[i - 1], a1 = path[i];
    const cross = a0.clone().lerp(a1, (GOAL_X - a0.x) / (a1.x - a0.x));
    expect(Math.abs(cross.z - 2.8)).toBeLessThan(0.15);
    expect(Math.abs(cross.y - 1.6)).toBeLessThan(0.15);
  });

  it('a curled shot bends the way the line was drawn', () => {
    const m = new Moment(lvl({}), 1);
    const straight = m.preview(shot(0, 1.2, 0));
    const curled = m.preview(shot(0, 1.2, 0.9)); // bends to the right (+z) of its travel
    const mid = (p: Vector3[]) => p[Math.floor(p.length / 2)];
    // it has to start out further left to arrive at the same point
    expect(mid(curled).z).toBeLessThan(mid(straight).z - 0.3);
  });

  it('a ground pass is firm and arrives at the drawn point', () => {
    const m = new Moment(lvl({ mates: [{ at: [30, -5] }, { at: [18, 6] }] }), 1);
    const tgt = new Vector3(GOAL_X - 18, 0, 6);
    m.act(pass(tgt.x, tgt.z));
    runOut(m);
    expect(m.phase).toBe('aim');
    expect(m.holder?.id).toBe(1);
    expect(m.ball.pos.distanceTo(tgt)).toBeLessThan(1.5);
    expect(m.lastKickSpeed).toBeGreaterThan(15);
  });

  it('a defender on the lane cuts out a ground pass but a lob goes over him', () => {
    const L = lvl({ mates: [{ at: [34, 0] }, { at: [15, 0] }], opps: [{ at: [26, 0.3], zone: 3 }] });
    const ground = runOut(new Moment(L, 1).also((m) => m.act(pass(GOAL_X - 15, 0))));
    expect(ground.result?.reason).toBe('Перехват!');
    const m = new Moment(L, 1);
    expect(m.autoLob(new Vector3(GOAL_X - 15, 0, 0))).toBe(true);
    m.act(pass(GOAL_X - 15, 0, 'lob'));
    runOut(m);
    expect(m.result?.reason ?? 'received').not.toBe('Перехват!');
  });

  it('the keeper saves a shot straight at him and is beaten in the corner', () => {
    const L = lvl({ gk: 0.5 });
    expect(runOut(new Moment(L, 1).also((m) => m.act(shot(0, 1.0)))).result?.ok).toBe(false);
    expect(runOut(new Moment(L, 1).also((m) => m.act(shot(HW - 0.3, 0.4)))).result?.ok).toBe(true);
  });

  it('the wall blocks a low straight free kick', () => {
    const L = lvl({ kind: 'freekick', mates: [{ at: [20, 0] }], wall: 5 });
    const m = runOut(new Moment(L, 1).also((mm) => mm.act(shot(0, 0.5))));
    expect(m.result?.reason).toBe('В стенку!');
  });

  it('a cross on a team-mate in the box freezes for a header or volley', () => {
    const L = lvl({ mates: [{ at: [20, -25] }, { at: [10, 0] }], opps: [] });
    const m = new Moment(L, 1);
    m.act(pass(GOAL_X - 10, 0, 'lob'));
    runOut(m);
    expect(m.phase).toBe('aim');
    expect(['header', 'volley']).toContain(m.touch);
    // and the finish
    m.act(shot(-HW + 0.6, 0.6));
    runOut(m);
    expect(m.result).not.toBeNull();
  });

  it('points and stars: a top-corner curler beats a plain goal', () => {
    const L = lvl({ gk: 0 });
    const plain = runOut(new Moment(L, 1).also((m) => m.act(shot(-2.6, 0.6, 0))));
    const fancy = runOut(new Moment(L, 1).also((m) => m.act(shot(HW - 0.4, 2.1, -0.8))));
    expect(plain.result?.ok).toBe(true);
    expect(fancy.result?.ok).toBe(true);
    expect(fancy.result!.points).toBeGreaterThan(plain.result!.points);
    expect(fancy.result!.bonuses.map((b) => b.label)).toContain('В девятку');
  });

  it('the sim is deterministic for a seed', () => {
    const L = LEVELS[2];
    const a = play(L, [shot(2.9, 1.9, 0.5)], 3);
    const b = play(L, [shot(2.9, 1.9, 0.5)], 3);
    expect(a.ball.pos.toArray()).toEqual(b.ball.pos.toArray());
    expect(a.result?.reason).toEqual(b.result?.reason);
  });

  it('clone() plays out identically', () => {
    const m = new Moment(LEVELS[3], 2);
    const c = m.clone();
    const a = pass(GOAL_X - 11, 4);
    runOut(m.also((x) => x.act(a)));
    runOut(c.also((x) => x.act(a)));
    expect(c.ball.pos.distanceTo(m.ball.pos)).toBeLessThan(1e-9);
    expect(c.phase).toBe(m.phase);
  });
});

describe('golazo levels', () => {
  it('every level has a sane layout', () => {
    const ids = new Set<number>();
    for (const L of LEVELS) {
      expect(ids.has(L.id)).toBe(false);
      ids.add(L.id);
      expect(L.mates.length).toBeGreaterThan(0);
      expect(L.stars[0]).toBeLessThan(L.stars[1]);
      const m = new Moment(L, 1);
      expect(m.phase).toBe('aim');
      expect(m.holder).toBe(m.actors[0]);
    }
  });

  it('every one-touch level can be scored from the first touch', () => {
    for (const L of LEVELS.filter((l) => l.mates.length === 1)) {
      const goals = shotGrid().filter((s) => play(L, [s]).result?.ok).length;
      expect(goals, `level ${L.id}`).toBeGreaterThan(0);
    }
  });
});

declare module '../src/golazo/sim' {
  interface Moment {
    also(fn: (m: Moment) => void): Moment;
  }
}
Moment.prototype.also = function (fn) {
  fn(this);
  return this;
};

describe('golazo shoot-out keeper', () => {
  const pen = lvl({ kind: 'penalty', mates: [{ at: [11, 0] }], gk: 0.5 });
  it('the player-keeper saves when he dives to the right spot and is beaten when he goes the wrong way', () => {
    const shotAt = shot(2.4, 0.6);
    const right = new Moment(pen, 1);
    right.userKeeper = true;
    right.userGuess = new Vector2(2.3, 0.7);
    right.act(shotAt);
    expect(runOut(right).result?.ok).toBe(false);
    const wrong = new Moment(pen, 1);
    wrong.userKeeper = true;
    wrong.userGuess = new Vector2(-2.3, 0.7);
    wrong.act(shotAt);
    expect(runOut(wrong).result?.ok).toBe(true);
  });
  it('a keeper who does not dive stands still (a ball at him is still saved)', () => {
    const m = new Moment(pen, 1);
    m.userKeeper = true;
    m.act(shot(2.6, 0.5));
    expect(runOut(m).result?.ok).toBe(true);
    const c = new Moment(pen, 1);
    c.userKeeper = true;
    c.act(shot(0.1, 1.0));
    expect(runOut(c).result?.ok).toBe(false);
  });
});

describe('golazo free-kick challenge', () => {
  it('hitting the bonus target adds points', () => {
    const L = lvl({ kind: 'freekick', mates: [{ at: [20, 0] }], wall: 0, gk: 0 });
    const m = new Moment(L, 1);
    m.target = { z: 2.8, y: 1.8, r: 0.55 };
    m.act(shot(2.8, 1.8, 0));
    runOut(m);
    expect(m.result?.ok).toBe(true);
    expect(m.targetHit).toBe(true);
    expect(m.result!.bonuses.map((b) => b.label)).toContain('В мишень!');
  });
  it('after a goal the scorer runs off to celebrate', () => {
    const m = new Moment(lvl({ gk: 0 }), 1);
    m.act(shot(-2.8, 1.0));
    runOut(m);
    expect(m.result?.ok).toBe(true);
    const start = m.scorer!.pos.clone();
    for (let i = 0; i < 120; i++) m.step();
    expect(m.scorer!.pos.distanceTo(start)).toBeGreaterThan(2);
    expect(m.scorer!.celebrate).toBe(true);
  });
});
