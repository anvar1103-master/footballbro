import { describe, expect, it } from 'vitest';
import { PartyWorld, PARTY_DT, NO_INPUT, PartyInput, ARENA, HALL_H } from '../src/party/world';
import { Tutorial } from '../src/party/tutorial';

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
  const mate = w.teamBros(0).find((b) => b !== c && b.role === 'FIELD')!;
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
    expect(Math.abs((landed ?? 0) - target.x)).toBeLessThan(4);
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
    const [a, b2] = w.teamBros(0).filter((b) => b !== c && b.role === 'FIELD');
    a.teleport(-4, 3, 1);
    b2.teleport(-8, -3, 1);
    park([c, a, b2]);
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
    const mate = w.teamBros(0).find((b) => b !== c && b.role === 'FIELD')!;
    w.bros.forEach((b, i) => b !== mate && b.teleport(-18 + i * 1.2, -13, 1));
    mate.teleport(5, 0, 1);
    w.ball.setTranslation({ x: 6.05, y: w.ballR, z: 0 });
    run(w, 0.5);
    expect(w.controlled).toBe(c);
  });

  it('aiming wide of the post curls the shot back into the goal', async () => {
    const { w, c, park } = await sandbox(17);
    c.teleport(10, -6, 1);
    w.ball.setTranslation({ x: 10.75, y: w.ballR, z: -6 });
    // aim at the right of the far post: the ball has to bend in
    const aim = { mx: 0.83, mz: 0.56 };
    for (let t = 0; t < 0.5; t += PARTY_DT) {
      w.step(PARTY_DT, { ...NO_INPUT, ...aim, kick: true });
      park([c]);
    }
    w.step(PARTY_DT, { ...NO_INPUT, ...aim });
    const spin = w.ball.angvel();
    expect(Math.abs(spin.y)).toBeGreaterThan(5);
    let crossed: number | null = null;
    for (let t = 0; t < 2 && crossed === null; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c]);
      w.teamBros(1)[0].teleport(0, 14, 1); // no keeper
      const bp = w.ballPos();
      if (bp.x > ARENA.length / 2 - 0.3) crossed = bp.z;
    }
    expect(crossed).not.toBe(null);
    expect(Math.abs(crossed!)).toBeLessThan(ARENA.goalHalfW + 0.3);
  });

  it('skill moves: rainbow flick lifts the ball, a cut changes direction', async () => {
    const { w, c, park } = await sandbox(18);
    run(w, 0.3, { mx: 1 });
    park([c]);
    expect(w.holder).toBe(c);
    w.step(PARTY_DT, { ...NO_INPUT, mx: 1, skill: true });
    expect(c.skill?.kind).toBe('rainbow');
    expect(w.ballVel().y).toBeGreaterThan(4);
    const s2 = await sandbox(19);
    run(s2.w, 0.4, { mx: 1 });
    s2.park([s2.c]);
    const before = s2.c.face.clone();
    s2.w.step(PARTY_DT, { ...NO_INPUT, mz: 1, skill: true });
    expect(s2.c.skill?.kind).toBe('cut');
    expect(s2.c.face.angleTo(before)).toBeGreaterThan(0.8);
  });

  it('a ball at chest height with the back to goal becomes a bicycle kick', async () => {
    const { w, c, park } = await sandbox(20);
    c.teleport(14, 0, -1); // facing our own half, goal behind
    w.ball.setTranslation({ x: 13.3, y: 1.6, z: 0 });
    w.ball.setLinvel({ x: 0, y: 0, z: 0 });
    w.step(PARTY_DT, { ...NO_INPUT, kick: true });
    w.step(PARTY_DT, NO_INPUT);
    expect(c.kickKind).toBe('bicycle');
    expect(w.ballVel().x).toBeGreaterThan(10);
    park([c]);
  });

  it('keepers catch soft shots', async () => {
    const w = await world(21);
    run(w, 2.6);
    const gk = w.teamBros(1)[0];
    expect(gk.role).toBe('GK');
    const gx = gk.position().x;
    w.ball.setTranslation({ x: gx - 6, y: 0.8, z: gk.position().z });
    w.ball.setLinvel({ x: 7, y: 1, z: 0 });
    let caught = false;
    for (let t = 0; t < 2 && !caught; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      if (w.gkHold?.gk === gk) caught = true;
    }
    expect(caught).toBe(true);
  });

  it('mouse aim: LMB pass goes where you point (into space), RMB shot follows the aim', async () => {
    const { w, c, park } = await sandbox(22);
    // point 60° to the left of where the player faces: no mate there → pass into space along the aim
    const aim = { aimX: Math.cos(1.05), aimZ: Math.sin(1.05) };
    w.step(PARTY_DT, { ...NO_INPUT, ...aim, pass: true });
    park([c]);
    const v = w.ballVel();
    expect(v.length()).toBeGreaterThan(4);
    expect(Math.abs(Math.atan2(v.z, v.x) - 1.05)).toBeLessThan(0.15);
    const s2 = await sandbox(23);
    const aim2 = { aimX: Math.cos(-0.5), aimZ: Math.sin(-0.5) };
    for (let t = 0; t < 0.4; t += PARTY_DT) s2.w.step(PARTY_DT, { ...NO_INPUT, ...aim2, kick: true });
    s2.w.step(PARTY_DT, { ...NO_INPUT, ...aim2 });
    const v2 = s2.w.ballVel();
    expect(Math.hypot(v2.x, v2.z)).toBeGreaterThan(15);
    expect(Math.abs(Math.atan2(v2.z, v2.x) + 0.5)).toBeLessThan(0.2);
  });

  it('the hall has a roof: a ball blasted upwards comes back down inside', async () => {
    const w = await world(24);
    run(w, 2.6);
    w.events.length = 0;
    w.ball.setTranslation({ x: 0, y: 2, z: 0 });
    w.ball.setLinvel({ x: 3, y: 30, z: 2 });
    let maxY = 0;
    for (let t = 0; t < 3; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      maxY = Math.max(maxY, w.ballPos().y);
    }
    expect(maxY).toBeLessThan(HALL_H + 0.1);
    expect(w.events.filter((e) => e.type === 'drop').length).toBe(0);
  });

  it('auto switch: a teammate clearly closer to a loose ball is taken over', async () => {
    const { w, c, mate, park } = await sandbox(25);
    c.teleport(-10, -8, 1);
    mate.teleport(6, 5, 1);
    w.ball.setTranslation({ x: 8, y: w.ballR, z: 6 });
    w.ball.setLinvel({ x: 0, y: 0, z: 0 });
    for (let t = 0; t < 0.3; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c, mate]);
    }
    expect(w.controlled).toBe(mate);
  });

  it('without the ball: pass = switch player, shot near the carrier = slide tackle', async () => {
    const { w, c, park } = await sandbox(26);
    const opp = w.teamBros(1)[1];
    // opponent dribbling right in front of us
    opp.teleport(2.2, 0, 1);
    w.ball.setTranslation({ x: 3.0, y: w.ballR, z: 0 });
    w.ball.setLinvel({ x: 0, y: 0, z: 0 });
    for (let t = 0; t < 0.2; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c, opp]);
      opp.teleport(2.2, 0, 1, true);
    }
    w.holder = opp; // (the AI may already have played it on)
    w.ball.setTranslation({ x: 3.0, y: w.ballR, z: 0 });
    w.step(PARTY_DT, { ...NO_INPUT, kick: true });
    w.step(PARTY_DT, NO_INPUT);
    expect(c.state).toBe('dive');
    const s2 = await sandbox(27);
    s2.c.teleport(-15, 0, 1);
    s2.park([s2.c]);
    const before = s2.w.controlled;
    s2.w.step(PARTY_DT, { ...NO_INPUT, pass: true });
    expect(s2.w.controlled).not.toBe(before);
  });

  it('ball and players that slip through a wall are put back inside', async () => {
    const w = await world(28);
    run(w, 2.6);
    w.ball.setTranslation({ x: 3, y: 0.5, z: ARENA.width / 2 + 0.4 });
    w.ball.setLinvel({ x: 0, y: 0, z: 5 });
    const b = w.bros[3];
    b.teleport(ARENA.length / 2 + 0.3, 8, 1); // beside the goal, in the wall
    run(w, 0.1);
    expect(Math.abs(w.ballPos().z)).toBeLessThan(ARENA.width / 2);
    expect(w.ballVel().z).toBeLessThan(0.1);
    expect(Math.abs(b.position().x)).toBeLessThan(ARENA.length / 2);
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
    expect(w.ballR).toBeGreaterThan(0.7);
    w.endChaos();
    expect(w.ballR).toBeLessThan(0.3);
    w.startChaos('lowgrav');
    expect(w.gravity).toBeGreaterThan(-6);
    w.startChaos('sweeper');
    run(w, 3);
    expect(w.sweeper.on).toBe(true);
    w.endChaos();
    expect(w.gravity).toBeLessThan(-10);
  });

  it('keyboard shot without aiming goes on target (assist picks a corner)', async () => {
    const { w, c, park } = await sandbox(31);
    // out wide on the right, facing straight up the pitch: the shot still goes at the goal
    c.teleport(14, 9, 1);
    w.ball.setTranslation({ x: 14.75, y: w.ballR, z: 9 });
    const gk = w.teamBros(1)[0];
    for (let t = 0; t < 0.4; t += PARTY_DT) {
      w.step(PARTY_DT, { ...NO_INPUT, kick: true });
      park([c]);
    }
    w.step(PARTY_DT, NO_INPUT);
    let crossed: number | null = null;
    for (let t = 0; t < 2 && crossed === null; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c]);
      gk.teleport(24, 14, -1);
      const bp = w.ballPos();
      if (bp.x > ARENA.length / 2 - 0.3) crossed = bp.z;
    }
    expect(crossed).not.toBe(null);
    expect(Math.abs(crossed!)).toBeLessThan(ARENA.goalHalfW + 0.3);
  });

  it('the pass target is previewed, completed passes fill the ОГОНЬ meter', async () => {
    const { w, c, mate, park } = await sandbox(32);
    mate.teleport(8, 0, -1);
    run(w, 0.3, { mx: 0.01 });
    park([c, mate]);
    expect(w.passTarget).toBe(mate);
    const before = w.teams[0].fire;
    w.step(PARTY_DT, { ...NO_INPUT, pass: true });
    let combo = false;
    for (let t = 0; t < 2 && !combo; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c, mate]);
      combo = w.events.some((e) => e.type === 'combo' && e.team === 0);
      w.events.length = 0;
    }
    expect(combo).toBe(true);
    expect(w.teams[0].fire).toBeGreaterThan(before + 0.04);
  });

  it('a fire shot burns through a defender and the keeper', async () => {
    const { w, c, park } = await sandbox(33);
    c.teleport(14, 0, 1);
    w.ball.setTranslation({ x: 14.75, y: w.ballR, z: 0 });
    w.teams[0].fire = 1;
    const def = w.teamBros(1)[1];
    const gk = w.teamBros(1)[0];
    w.step(PARTY_DT, { ...NO_INPUT, kick: true });
    w.step(PARTY_DT, NO_INPUT);
    expect(w.fireBall).not.toBe(null);
    expect(w.teams[0].fire).toBe(0);
    // a defender right in the path is flattened, the ball keeps flying
    const bp = w.ballPos(), v = w.ballVel().normalize();
    def.teleport(bp.x + v.x * 3, bp.z + v.z * 3, -1);
    let burnt = false, goal = false;
    for (let t = 0; t < 2 && !goal; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c, def, gk]);
      burnt ||= w.events.some((e) => e.type === 'burn');
      goal ||= w.events.some((e) => e.type === 'goal');
      w.events.length = 0;
    }
    expect(burnt).toBe(true);
    expect(def.state).not.toBe('up');
    expect(goal || w.events.some((e) => e.type === 'save')).toBe(true);
  });

  it('a fast shot is not stopped dead by an opponent foot', async () => {
    const { w, c, park } = await sandbox(34);
    const o = w.teamBros(1)[1];
    o.teleport(6, 0.5, -1);
    w.ball.setTranslation({ x: 3, y: w.ballR, z: 0.5 });
    w.ball.setLinvel({ x: 25, y: 0, z: 0 });
    for (let t = 0; t < 0.3; t += PARTY_DT) {
      w.step(PARTY_DT, NO_INPUT);
      park([c, o]);
      expect(w.holder).not.toBe(o);
    }
  });

  it('the tutorial can be played through', async () => {
    const w = await PartyWorld.create({ humanTeam: 0, size: 3, matchLength: 1e6, seed: 3, difficulty: 'easy', events: false, autoSwitch: true });
    let step = 0, done = false;
    const tut = new Tutorial(w, { show: (s) => (step = s), praise: () => {}, finish: () => (done = true) }, (a) => a);
    let tap = 0;
    for (let T = 0; T < 90 && !done; T += PARTY_DT) {
      const c = w.controlled!;
      const bp = w.ballPos();
      const p = c.position();
      const to = (x: number, z: number) => {
        const d = Math.hypot(x - p.x, z - p.z) || 1;
        return { mx: (x - p.x) / d, mz: (z - p.z) / d };
      };
      tap = (tap + 1) % 60;
      const has = w.holder === c;
      let inp: PartyInput = NO_INPUT;
      if (step === 1) inp = { ...NO_INPUT, ...to(bp.x, bp.z) };
      else if (step === 2) inp = { ...NO_INPUT, pass: has && tap < 5 };
      else if (step === 3 || step === 6) inp = { ...NO_INPUT, mx: 1, kick: has && tap < 30 };
      else if (step === 4) {
        const o = w.holder?.team === 1 ? w.holder.position() : null;
        if (o) inp = { ...NO_INPUT, ...to(o.x, o.z), kick: Math.hypot(o.x - p.x, o.z - p.z) < 3 && tap < 3 };
      } else if (step === 5) inp = { ...NO_INPUT, skill: has && tap < 3 };
      tut.preStep(PARTY_DT);
      w.step(PARTY_DT, inp);
      tut.onEvents(w.events);
      w.events.length = 0;
    }
    expect(done).toBe(true);
  }, 30000);

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
