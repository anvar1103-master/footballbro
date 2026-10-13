import { describe, expect, it } from 'vitest';
import { PartyWorld, PARTY_DT, NO_INPUT, PartyInput } from '../src/party/world';

async function world(seed = 3, human = -1) {
  return PartyWorld.create({ humanTeam: human, perTeam: 3, matchLength: 120, seed });
}
function run(w: PartyWorld, s: number, inp: Partial<PartyInput> = {}) {
  for (let t = 0; t < s; t += PARTY_DT) w.step(PARTY_DT, { ...NO_INPUT, ...inp });
}

describe('party football', () => {
  it('bros stand upright and wobble but do not fall by themselves', async () => {
    const w = await world();
    run(w, 1.5);
    for (const b of w.bros) expect(b.uprightness).toBeGreaterThan(0.75);
  });

  it('a knocked-down bro gets back up', async () => {
    const w = await world();
    run(w, 1.3);
    const b = w.bros[1];
    b.knockDown(1.0);
    run(w, 0.5);
    expect(b.state).toBe('down');
    run(w, 3);
    expect(b.state).toBe('up');
    expect(b.uprightness).toBeGreaterThan(0.7);
  });

  it('human can run and kick the ball', async () => {
    const w = await world(5, 0);
    run(w, 1.3);
    const c = w.controlled!;
    // place the ball in front of the human
    const p = c.position();
    w.ball.setTranslation({ x: p.x + c.face.x * 0.7, y: 0.31, z: p.z + c.face.z * 0.7 }, true);
    w.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    run(w, 0.4, { kick: true });
    run(w, 0.05);
    const kicks = w.events.filter((e) => e.type === 'kick');
    expect(kicks.length).toBeGreaterThan(0);
    expect(w.ballVel().length()).toBeGreaterThan(8);
  });

  it('dive makes the bro go down and get up again', async () => {
    const w = await world(6, 0);
    run(w, 1.3);
    const c = w.controlled!;
    run(w, 0.05, { dive: true });
    run(w, 0.6);
    expect(['dive', 'down', 'getup']).toContain(c.state);
    run(w, 3);
    expect(c.state).toBe('up');
  });

  it('an AI match produces goals and no NaN', async () => {
    const w = await world(4);
    let goals = 0;
    for (let t = 0; t < 120 && w.phase !== 'over'; t += PARTY_DT) {
      w.step(PARTY_DT);
      goals += w.events.filter((e) => e.type === 'goal').length;
      w.events.length = 0;
    }
    expect(goals).toBeGreaterThan(0);
    for (const b of w.bros) expect(Number.isFinite(b.position().x)).toBe(true);
  }, 30000);
});
