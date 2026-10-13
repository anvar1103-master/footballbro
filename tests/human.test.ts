import { describe, expect, it } from 'vitest';
import { Match, InputState, EMPTY_INPUT } from '../src/sim/match';
import { SIM_DT } from '../src/sim/config';
import { TEAM_PRESETS } from '../src/sim/team';

function setup() {
  const m = new Match({ teamSize: 11, halfLength: 300, difficulty: 'normal', humanTeam: 0, teams: [TEAM_PRESETS[0], TEAM_PRESETS[1]], seed: 42 });
  // skip kickoff: give the ball to our striker 20 m from goal
  const gx = m.attackGoalX(0);
  const dir = Math.sign(gx);
  const p = m.teams[0].players.find((q) => q.role === 'FWD')!;
  m.phase = 'play';
  m.setPiece = null;
  p.pos.set(gx - dir * 22, 0, 6);
  p.face.set(dir, 0, 0);
  m.ball.place(p.pos.x + dir * 0.5, p.pos.z);
  m.setOwner(p);
  m.controlled = p;
  // clear the way
  for (const q of m.teams[1].players) if (q.role !== 'GK') q.pos.set(-gx * 0.5, 0, q.pos.z);
  return { m, p, gx, dir };
}

function run(m: Match, seconds: number, input: Partial<InputState> = {}) {
  const inp = { ...EMPTY_INPUT, ...input };
  for (let t = 0; t < seconds; t += SIM_DT) m.step(SIM_DT, inp);
}

function kicks(m: Match) {
  const k = m.events.filter((e) => e.type === 'kick').map((e) => e.kind);
  m.events.length = 0;
  return k;
}

describe('human controls', () => {
  it('hold J then release shoots at goal', () => {
    const { m, gx } = setup();
    run(m, 0.5, { shoot: true });
    run(m, 0.3);
    expect(kicks(m)).toContain('shot');
    expect(Math.sign(m.ball.vel.x)).toBe(Math.sign(gx));
    expect(m.shot).not.toBeNull();
  });

  it('I releases a curling finesse shot', () => {
    const { m } = setup();
    run(m, 0.6, { finesse: true });
    run(m, 0.3);
    expect(kicks(m)).toContain('finesse');
    expect(Math.abs(m.ball.spin.y)).toBeGreaterThan(20);
  });

  it('K passes to a teammate in the stick direction and switches control', () => {
    const { m, p, dir } = setup();
    run(m, 0.05, { pass: true, mx: -dir, my: 0 });
    run(m, 0.3);
    expect(kicks(m)).toContain('pass');
    expect(m.controlled).not.toBe(p);
  });

  it('lob key without the ball starts a slide tackle', () => {
    const { m, p } = setup();
    // give the ball to an opponent nearby
    const o = m.teams[1].players[5];
    o.pos.set(p.pos.x + 3, 0, p.pos.z);
    m.ball.place(o.pos.x + 0.4, o.pos.z);
    m.setOwner(o);
    run(m, 0.05, { lob: true });
    expect(p.action).toBe('slide');
  });

  it('shoot key without the ball tackles a nearby carrier', () => {
    const { m, p } = setup();
    const o = m.teams[1].players[5];
    o.pos.set(p.pos.x + 1.2, 0, p.pos.z);
    m.ball.place(o.pos.x + 0.4, o.pos.z);
    m.setOwner(o);
    run(m, 0.05, { shoot: true });
    expect(p.action).toBe('tackle');
  });

  it('holding pass without the ball jockeys the carrier', () => {
    const { m, p } = setup();
    const o = m.teams[1].players[5];
    o.pos.set(p.pos.x + 6, 0, p.pos.z);
    m.ball.place(o.pos.x + 0.4, o.pos.z);
    m.setOwner(o);
    run(m, 0.5, { pass: true });
    expect(p.jockey).toBe(true);
    expect(p.pos.distanceTo(o.pos)).toBeLessThan(6);
  });

  it('chip key + shot lofts the ball', () => {
    const { m } = setup();
    run(m, 0.3, { shoot: true, chip: true });
    run(m, 0.3, { chip: true });
    expect(kicks(m)).toContain('chip');
    expect(m.ball.vel.y).toBeGreaterThan(4);
  });

  it('sprinting drains stamina', () => {
    const { m, p } = setup();
    run(m, 4, { sprint: true, mx: 0, my: 1 });
    expect(p.stamina).toBeLessThan(0.9);
  });

  it('a full AI-vs-human-idle match finishes without errors', () => {
    const m = new Match({ teamSize: 7, halfLength: 40, difficulty: 'hard', humanTeam: 0, teams: [TEAM_PRESETS[2], TEAM_PRESETS[3]], seed: 7 });
    let steps = 0;
    while (m.phase !== 'fulltime' && steps < 40000) {
      m.step(SIM_DT, EMPTY_INPUT);
      m.events.length = 0;
      steps++;
    }
    expect(m.phase).toBe('fulltime');
    expect(Number.isFinite(m.ball.pos.x)).toBe(true);
  });
});
