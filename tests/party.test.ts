import { describe, expect, it } from 'vitest';
import { PartyWorld, PARTY_DT, NO_INPUT, PartyInput, ARENA } from '../src/party/world';

async function world(seed = 3, human = -1, size = 4) {
  return PartyWorld.create({ humanTeam: human, size, matchLength: 120, seed, events: false });
}
function run(w: PartyWorld, s: number, inp: Partial<PartyInput> = {}) {
  for (let t = 0; t < s; t += PARTY_DT) w.step(PARTY_DT, { ...NO_INPUT, ...inp });
}
/** skip the countdown, park everybody except `keep` far away, put the ball at the human's feet */
async function sandbox(seed = 5) {
  const w = await world(seed, 0);
  run(w, 2.6); // countdown → play
  const c = w.controlled!;
  const mate = w.teamBros(0).find((b) => b !== c)!;
  const park = (keep: unknown[]) => w.bros.forEach((b, i) => !keep.includes(b) && b.teleport(-18 + i * 1.2, -13, 1));
  c.teleport(0, 0, 1);
  park([c]);
  w.ball.setTranslation({ x: 1.05, y: w.ballR, z: 0 });
  w.ball.setLinvel({ x: 0, y: 0, z: 0 });
  return { w, c, mate, park };
}

describe('bean ball', () => {
  it('beans stand upright and wobble but do not fall by themselves', async () => {
    const w = await world();
    run(w, 2);
    for (const b of w.bros) expect(b.uprightness).toBeGreaterThan(0.75);
  });

  it('the ball drops from the sky after the countdown', async () => {
    const w = await world();
    expect(w.phase).toBe('countdown');
    run(w, 2.5);
    expect(w.phase).toBe('play');
    expect(w.events.some((e) => e.type === 'drop')).toBe(true);
  });

  it('a knocked-down bean gets back up', async () => {
    const w = await world();
    run(w, 1);
    const b = w.bros[1];
    b.knockDown(1.0);
    run(w, 0.5);
    expect(b.state).toBe('down');
    let sawUp = false;
    for (let t = 0; t < 3; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      if (b.state === 'up' && b.uprightness > 0.8) sawUp = true;
    }
    expect(sawUp).toBe(true);
  });

  it('kick: holding the button gives a harder shot towards the goal', async () => {
    const { w, c, park } = await sandbox();
    for (let t = 0; t < 0.8; t += PARTY_DT) {
      w.step(PARTY_DT, { ...NO_INPUT, kick: true });
      park([c]);
    }
    w.step(PARTY_DT, NO_INPUT);
    const v = w.ballVel();
    expect(v.length()).toBeGreaterThan(20);
    expect(v.x).toBeGreaterThan(0); // towards the goal we attack (+x)
  });

  it('pass reaches the teammate', async () => {
    const { w, c, mate, park } = await sandbox(7);
    mate.teleport(14, 4, -1);
    w.step(PARTY_DT, { ...NO_INPUT, pass: true });
    let got = false;
    for (let t = 0; t < 4 && !got; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c, mate]);
      mate.teleport(14, 4, -1, true);
      const bp = w.ballPos();
      if (Math.hypot(bp.x - 14, bp.z - 4) < 1.6) got = true;
    }
    expect(got).toBe(true);
  });

  it('lob flies high and lands near the target', async () => {
    const { w, c, mate, park } = await sandbox(8);
    mate.teleport(16, 0, -1);
    const target = w.lobTarget(c);
    expect(target.x).toBeGreaterThan(15);
    w.step(PARTY_DT, { ...NO_INPUT, lob: true });
    let maxY = 0, landed: number | null = null;
    for (let t = 0; t < 4; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c]); // nobody in the way: measure the flight itself
      const bp = w.ballPos();
      maxY = Math.max(maxY, bp.y);
      if (landed === null && t > 0.3 && bp.y < w.ballR + 0.15) landed = bp.x;
    }
    expect(maxY).toBeGreaterThan(3);
    expect(Math.abs((landed ?? 0) - target.x)).toBeLessThan(3);
  });

  it('the ball sticks to a dribbling bean', async () => {
    const { w, c, park } = await sandbox(9);
    let held = 0, n = 0;
    for (let t = 0; t < 3; t += PARTY_DT) {
      w.step(PARTY_DT, { ...NO_INPUT, mx: Math.cos(t * 0.8), mz: Math.sin(t * 0.8) * 0.7 });
      park([c]);
      n++;
      if (w.holder === c) held++;
    }
    expect(held / n).toBeGreaterThan(0.8);
  });

  it('a sliding tackle flattens the opponent with the ball', async () => {
    const { w, c, park } = await sandbox(10);
    const opp = w.teamBros(1)[1];
    opp.teleport(3, 0, -1);
    w.ball.setTranslation({ x: 9, y: w.ballR, z: 6 });
    w.step(PARTY_DT, { ...NO_INPUT, mx: 1, tackle: true });
    for (let t = 0; t < 0.6; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c, opp]);
      if (opp.state === 'up') opp.teleport(3, 0, -1, true); // stand still and take it
    }
    expect(opp.state).not.toBe('up');
  });

  it('grab holds on to an opponent and slows him down', async () => {
    const { w, c, park } = await sandbox(11);
    const opp = w.teamBros(1)[1];
    opp.teleport(1.2, 0, 1);
    w.ball.setTranslation({ x: -6, y: w.ballR, z: 5 });
    w.step(PARTY_DT, { ...NO_INPUT, grab: true });
    expect(c.grabbing).toBe(opp);
    for (let t = 0; t < 0.5; t += PARTY_DT) {
      w.step(PARTY_DT, { ...NO_INPUT, grab: true });
      park([c, opp]);
    }
    expect(opp.speedMul).toBeLessThan(0.5);
    w.step(PARTY_DT, NO_INPUT);
    expect(c.grabbing).toBe(null);
  });

  it('switch key takes over the teammate closest to the ball, again cycles to the next', async () => {
    const { w, c, park } = await sandbox(14);
    const [a, b2, b3] = w.teamBros(0).filter((b) => b !== c);
    a.teleport(-4, 3, 1);
    b2.teleport(-8, -3, 1);
    b3.teleport(-14, 0, 1);
    park([c, a, b2, b3]);
    w.ball.setTranslation({ x: -3, y: w.ballR, z: 4 });
    w.step(PARTY_DT, NO_INPUT);
    expect(w.switchTarget).toBe(a);
    w.step(PARTY_DT, { ...NO_INPUT, switch: true });
    expect(w.controlled).toBe(a);
    w.step(PARTY_DT, NO_INPUT);
    w.step(PARTY_DT, { ...NO_INPUT, switch: true });
    expect(w.controlled).not.toBe(a);
    expect(w.controlled!.team).toBe(0);
    // the previous bean is back under AI control and keeps playing
    run(w, 0.5);
    expect(c.intent).toBeDefined();
  });

  it('after a pass the control follows the ball to the receiver', async () => {
    const { w, c, mate, park } = await sandbox(15);
    mate.teleport(10, 2, -1);
    w.step(PARTY_DT, { ...NO_INPUT, pass: true });
    let switched = false;
    for (let t = 0; t < 4 && !switched; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c, mate]);
      if (w.controlled === mate) switched = true;
    }
    expect(switched).toBe(true);
  });

  it('auto switch can be turned off', async () => {
    const w = await PartyWorld.create({ humanTeam: 0, size: 4, matchLength: 120, seed: 16, events: false, autoSwitch: false });
    run(w, 2.6);
    const c = w.controlled!;
    const mate = w.teamBros(0).find((b) => b !== c)!;
    w.bros.forEach((b, i) => b !== mate && b.teleport(-18 + i * 1.2, -13, 1));
    mate.teleport(5, 0, 1);
    w.ball.setTranslation({ x: 6.05, y: w.ballR, z: 0 });
    run(w, 0.5);
    expect(w.controlled).toBe(c);
  });

  it('a ball over the goal line counts and the next kick-off follows', async () => {
    const w = await world(12);
    run(w, 2.6);
    w.ball.setTranslation({ x: ARENA.length / 2 + 1.2, y: 1, z: 0 });
    w.ball.setLinvel({ x: 2, y: 0, z: 0 });
    run(w, 0.05);
    expect(w.teams[0].score).toBe(1);
    expect(w.phase).toBe('goal');
    run(w, 4);
    expect(w.phase).toBe('countdown');
  });

  it('chaos events switch on and off', async () => {
    const w = await world(13);
    run(w, 2.6);
    w.startChaos('mega');
    expect(w.ballR).toBeGreaterThan(0.9);
    w.endChaos();
    expect(w.ballR).toBeLessThan(0.6);
    w.startChaos('lowgrav');
    expect(w.gravity).toBeGreaterThan(-6);
    w.startChaos('sweeper');
    run(w, 3);
    expect(w.sweeper.on).toBe(true);
    w.endChaos();
    expect(w.gravity).toBeLessThan(-10);
  });

  it('an AI match with events produces goals and no NaN', async () => {
    const w = await PartyWorld.create({ humanTeam: -1, size: 4, matchLength: 90, seed: 4 });
    let goals = 0, events = 0;
    for (let t = 0; t < 200 && w.phase !== 'over'; t += PARTY_DT) {
      w.step(PARTY_DT);
      goals += w.events.filter((e) => e.type === 'goal').length;
      events += w.events.filter((e) => e.type === 'event').length;
      w.events.length = 0;
    }
    expect(goals).toBeGreaterThan(0);
    expect(events).toBeGreaterThan(0);
    expect(w.phase).toBe('over');
    for (const b of w.bros) expect(Number.isFinite(b.position().x)).toBe(true);
  }, 30000);
});
