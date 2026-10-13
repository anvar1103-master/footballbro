import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { PartyWorld, PARTY_DT, NO_INPUT, PartyInput } from '../src/party/world';

async function world(seed = 3, human = -1) {
  return PartyWorld.create({ humanTeam: human, size: 5, halfLength: 60, seed });
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
    // someone who is not taking the kick-off
    const c = w.teamBros(0).find((b) => b.role === 'FIELD' && b !== w.setPiece?.taker)!;
    w.controlled = c;
    run(w, 0.05, { dive: true });
    run(w, 0.6);
    expect(['dive', 'down', 'getup']).toContain(c.state);
    run(w, 3);
    expect(c.state).toBe('up');
  });

  it('switch key changes the controlled bro and it stays switched', async () => {
    const w = await world(8, 0);
    // let the AI kick off so we are in open play
    w.setPiece!.taker = w.teamBros(1).find((b) => b.role === 'FIELD')!;
    run(w, 3);
    const before = w.controlled!;
    run(w, 0.05, { switch: true });
    run(w, 0.3);
    expect(w.controlled).not.toBe(before);
    expect(w.controlled!.team).toBe(0);
  });

  it('the ball going over the touch line gives a throw-in', async () => {
    const w = await world(9);
    run(w, 3);
    w.ball.setTranslation({ x: 0, y: 0.2, z: w.field.width / 2 + 1 });
    w.ball.setLinvel({ x: 0, y: 0, z: 1 });
    run(w, 0.05);
    expect(w.setPiece?.kind).toBe('throwin');
    run(w, 6);
    expect(w.phase).toBe('play');
  });

  it('the ball sticks to a dribbling bro and ground passes reach the mate', async () => {
    const w = await world(2, 0);
    run(w, 1.3);
    (w as unknown as { phase: string }).phase = 'play';
    w.setPiece = null;
    const c = w.controlled!;
    const others = w.bros.filter((b) => b !== c);
    const park = () => others.forEach((b, i) => b.teleport(-20 + i, -14, 1));
    c.teleport(0, 0, 1);
    w.ball.setTranslation({ x: 0.8, y: 0.16, z: 0 }, true);
    w.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    let held = 0, n = 0;
    for (let t = 0; t < 3; t += PARTY_DT) {
      w.step(PARTY_DT, { ...NO_INPUT, mx: Math.cos(t * 1.2), my: Math.sin(t * 1.2) * 0.8 });
      park();
      n++;
      if (w.holder === c) held++;
    }
    expect(held / n).toBeGreaterThan(0.9);
    // a ground pass over 20 m arrives with pace
    c.teleport(0, 0, 1);
    c.face.set(1, 0, 0);
    w.ball.setTranslation({ x: 0.8, y: 0.16, z: 0 }, true);
    w.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    w.kick(c, 0.3, new Vector3(21, 0, 0), 0, 0, true);
    let vAt20 = 0;
    for (let t = 0; t < 4 && !vAt20; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park();
      if (w.ballPos().x > 20) vAt20 = w.ballVel().length();
    }
    expect(vAt20).toBeGreaterThan(4);
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
