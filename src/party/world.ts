import { PBody, PWorld, Tag } from './phys';
import { Vector3 } from 'three';
import type { FieldDims } from '../sim/config';
import { Rng } from '../sim/rng';
import { TEAM_PRESETS, TeamInfo } from '../sim/team';
import { Bro, BRO } from './bro';
import { think } from './brain';

/**
 * Footballbro "Bean Ball": wobbly physics beans (cannon-es) knocking a big bouncy ball around a
 * walled sky-arena. No outs, no fouls — just goals, a ball dropped from the sky at every kick-off,
 * tackles, grabs and random chaos events. Pure logic (no rendering), runs headless in tests.
 */

export const PARTY_DT = 1 / 120;
export const GRAVITY = -11.5;

/** arena (metres). Also a FieldDims so the classic GoalNet can be reused. */
export const ARENA: FieldDims & { wallH: number; corner: number } = {
  length: 46,
  width: 30,
  goalHalfW: 3.6,
  goalH: 3.0,
  goalDepthTop: 1.8,
  goalDepthBottom: 2.4,
  boxDepth: 8,
  boxHalfW: 8,
  smallBoxDepth: 3,
  smallBoxHalfW: 5,
  penaltySpot: 6,
  centerRadius: 4.5,
  boardMargin: 0,
  wallH: 1.4,
  corner: 4,
};

export const BALL_P = {
  radius: 0.5,
  mass: 0.9,
  dragK: 0.011,
  magnusK: 0.002,
  rollC: 0.55,
};

export interface PartyInput {
  /** desired move direction in WORLD space (already camera-relative), length <= 1 */
  mx: number;
  mz: number;
  sprint: boolean;
  jump: boolean;
  kick: boolean;
  pass: boolean;
  lob: boolean;
  tackle: boolean;
  grab: boolean;
  /** switch to another bean of your team */
  switch: boolean;
}
export const NO_INPUT: PartyInput = { mx: 0, mz: 0, sprint: false, jump: false, kick: false, pass: false, lob: false, tackle: false, grab: false, switch: false };

export type EventKind = 'mega' | 'lowgrav' | 'ice' | 'turbo' | 'sweeper';
export const EVENT_INFO: Record<EventKind, { title: string; sub: string }> = {
  mega: { title: 'МЕГА-МЯЧ!', sub: 'мяч вырос в два раза' },
  lowgrav: { title: 'ЛУНА!', sub: 'низкая гравитация' },
  ice: { title: 'ГОЛОЛЁД!', sub: 'держись на ногах' },
  turbo: { title: 'ТУРБО!', sub: 'все носятся как угорелые' },
  sweeper: { title: 'ВЕРТУШКА!', sub: 'прыгай через палку' },
};

export interface PartyEvent {
  type: 'switch' | 'kick' | 'bounce' | 'post' | 'net' | 'wall' | 'goal' | 'bonk' | 'whistle' | 'tackle' | 'grab' | 'header' | 'event' | 'eventEnd' | 'countdown' | 'drop' | 'golden' | 'over';
  pos?: Vector3;
  strength?: number;
  team?: number;
  text?: string;
}

export interface Team {
  index: number;
  info: TeamInfo;
  score: number;
  /** +1 attacks the goal at +x */
  dir: number;
}

export interface WorldOpts {
  humanTeam: number;
  /** beans per team */
  size: number;
  /** match length (s) */
  matchLength: number;
  seed?: number;
  teams?: [TeamInfo, TeamInfo];
  difficulty?: 'easy' | 'normal' | 'hard';
  /** chaos events on/off (tests switch them off) */
  events?: boolean;
  /** control jumps to a teammate who gets the ball (default on) */
  autoSwitch?: boolean;
}

export type Phase = 'countdown' | 'play' | 'goal' | 'over';

const NAMES = ['Боб', 'Пуш', 'Жужа', 'Кекс', 'Буля', 'Тофу', 'Пончик', 'Шмяк', 'Бублик', 'Зефир', 'Хрум', 'Плюх', 'Тыква', 'Бамбл'];

export class PartyWorld {
  world!: PWorld;
  ball!: PBody;
  bros: Bro[] = [];
  teams: [Team, Team];
  field = ARENA;
  rng: Rng;
  humanTeam: number;
  controlled: Bro | null = null;
  /** who the switch key would pick right now (shown in the HUD) */
  switchTarget: Bro | null = null;
  private switchCd = 0;
  private switchCycle: Bro[] = [];
  phase: Phase = 'countdown';
  phaseT = 0;
  /** played time (s) */
  time = 0;
  golden = false;
  events: PartyEvent[] = [];
  lastTouch: Bro | null = null;
  lastScorer: Bro | null = null;
  scoredTeam = -1;
  /** bean the ball is "glued" to while dribbling (sticky, with hysteresis) */
  holder: Bro | null = null;
  ballR = BALL_P.radius;
  gravity = GRAVITY;
  /** active chaos event */
  chaos: { kind: EventKind; t: number; dur: number } | null = null;
  nextChaosAt = 35;
  lastChaos: EventKind | null = null;
  sweeper = { on: false, angle: 0, len: 10, h: 0.55, speed: 1.1 };
  /** render-time slow motion request (seconds left) */
  slowmo = 0;
  /** human buffered actions: fire as soon as the ball is in reach */
  buffer: { kind: 'kick' | 'pass' | 'lob'; power: number; t: number } | null = null;
  private prevInput: PartyInput = { ...NO_INPUT };
  private lastBallVy = 0;
  private cds = { net: 0, post: 0, wall: 0 };
  private bodyMap = new Map<unknown, Bro>();
  private pendingHits: { bro: Bro; speed: number }[] = [];
  private lastCount = 4;

  constructor(public opts: WorldOpts) {
    this.rng = new Rng(opts.seed ?? (Date.now() & 0xffff));
    this.humanTeam = opts.humanTeam;
    const infos = opts.teams ?? [TEAM_PRESETS[0], TEAM_PRESETS[1]];
    this.teams = [
      { index: 0, info: infos[0], score: 0, dir: 1 },
      { index: 1, info: infos[1], score: 0, dir: -1 },
    ];
  }

  static async create(opts: WorldOpts) {
    const w = new PartyWorld(opts);
    w.build();
    return w;
  }

  private build() {
    const f = ARENA;
    this.world = new PWorld(GRAVITY);
    const W = this.world;
    W.ground();
    const L = f.length / 2, Wd = f.width / 2, c = f.corner, H = 5; // physics walls are taller than the inflatables
    // long sides
    W.box('wall', L - c, H / 2, 0.5, 0, H / 2, -Wd - 0.5);
    W.box('wall', L - c, H / 2, 0.5, 0, H / 2, Wd + 0.5);
    // ends, either side of the goal mouth
    const seg = (Wd - c - f.goalHalfW) / 2;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) W.box('wall', 0.5, H / 2, seg, sx * (L + 0.5), H / 2, sz * (f.goalHalfW + seg));
    // chamfered corners
    const d = (c * Math.SQRT2) / 2;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const cx = sx * (L - c / 2 + 0.35), cz = sz * (Wd - c / 2 + 0.35);
        W.box('wall', d + 0.4, H / 2, 0.5, cx, H / 2, cz, sx * sz > 0 ? -Math.PI / 4 : Math.PI / 4);
      }
    // goals: chunky posts and soft net boxes
    for (const dir of [-1, 1]) {
      const x0 = dir * L;
      const r = 0.15;
      W.cylinder('post', r, f.goalH / 2, x0, f.goalH / 2, -f.goalHalfW - r);
      W.cylinder('post', r, f.goalH / 2, x0, f.goalH / 2, f.goalHalfW + r);
      W.cylinder('post', r, f.goalHalfW + r, x0, f.goalH + r, 0, true);
      const dd = f.goalDepthBottom + 0.3;
      W.box('net', 0.1, f.goalH / 2 + 0.3, f.goalHalfW + 0.3, x0 + dir * (dd + 0.1), f.goalH / 2, 0);
      W.box('net', dd / 2, f.goalH / 2 + 0.2, 0.1, x0 + dir * (dd / 2), f.goalH / 2, -(f.goalHalfW + 0.35));
      W.box('net', dd / 2, f.goalH / 2 + 0.2, 0.1, x0 + dir * (dd / 2), f.goalH / 2, f.goalHalfW + 0.35);
      W.box('net', dd / 2, 0.1, f.goalHalfW + 0.3, x0 + dir * (dd / 2), f.goalH + 0.35, 0);
    }
    this.ball = W.ball(BALL_P.radius, BALL_P.mass, 0.0, 0.05);
    this.ball.setTranslation({ x: 0, y: 9, z: 0 });
    W.onBallHit = (tag: Tag, sp: number, other) => {
      if (tag === 'net' && sp > 3 && this.cds.net <= 0) {
        this.cds.net = 0.4;
        this.emit({ type: 'net', pos: this.ballPos(), strength: sp });
      }
      if (tag === 'post' && sp > 3 && this.cds.post <= 0) {
        this.cds.post = 0.4;
        this.emit({ type: 'post', pos: this.ballPos(), strength: sp });
      }
      if (tag === 'wall' && sp > 4 && this.cds.wall <= 0) {
        this.cds.wall = 0.25;
        this.emit({ type: 'wall', pos: this.ballPos(), strength: sp });
      }
      if (tag === 'bro') {
        const b = this.bodyMap.get(other);
        if (b) {
          this.lastTouch = b;
          this.pendingHits.push({ bro: b, speed: sp });
        }
      }
    };
    // squads
    let id = 0;
    const names = [...NAMES].sort(() => this.rng.next() - 0.5);
    for (const t of this.teams) {
      for (let i = 0; i < this.opts.size; i++) {
        const b = new Bro(W, id, t.index, i === 0 ? 'GK' : 'FIELD', id, names[id % names.length], 0, 0);
        b.number = i === 0 ? 1 : [7, 9, 10, 11, 8, 4][i - 1] ?? 12 + i;
        this.bodyMap.set(b.body.b, b);
        this.bros.push(b);
        id++;
      }
    }
    if (this.humanTeam >= 0) {
      // the human is the striker of their team (not the back bean)
      const mine = this.teamBros(this.humanTeam);
      this.controlled = mine[Math.min(1, mine.length - 1)];
    }
    this.startCountdown();
  }

  // ---------------- helpers ----------------
  ballPos(out = new Vector3()) {
    const t = this.ball.translation();
    return out.set(t.x, t.y, t.z);
  }
  ballVel(out = new Vector3()) {
    const v = this.ball.linvel();
    return out.set(v.x, v.y, v.z);
  }
  /** x of the goal `team` attacks */
  goalX(team: number) {
    return (this.teams[team].dir * ARENA.length) / 2;
  }
  ownGoalX(team: number) {
    return (-this.teams[team].dir * ARENA.length) / 2;
  }
  teamBros(team: number) {
    return this.bros.filter((b) => b.team === team);
  }
  emit(e: PartyEvent) {
    this.events.push(e);
  }
  get remaining() {
    return Math.max(0, this.opts.matchLength - this.time);
  }
  grabbedBy(b: Bro) {
    return this.bros.find((o) => o.grabbing === b) ?? null;
  }

  // ---------------- kick-off: everyone on their spots, ball drops from the sky ----------------
  spotFor(b: Bro) {
    const t = this.teams[b.team];
    const mates = this.teamBros(b.team);
    const i = mates.indexOf(b);
    const n = mates.length;
    if (i === 0) return new Vector3(-t.dir * (ARENA.length / 2 - 4), 0, 0);
    const k = n - 1;
    const z = k === 1 ? 0 : -9 + (18 * (i - 1)) / (k - 1);
    const x = -t.dir * (i % 2 === 1 ? 5 : 10);
    return new Vector3(x, 0, z * (k > 3 ? 1 : 0.8));
  }

  startCountdown() {
    this.phase = 'countdown';
    this.phaseT = 0;
    this.lastCount = 4;
    this.holder = null;
    this.buffer = null;
    for (const b of this.bros) {
      const s = this.spotFor(b);
      b.teleport(s.x, s.z, this.teams[b.team].dir);
      b.grabbing = null;
      b.celebrate = false;
    }
    this.ball.setTranslation({ x: 0, y: 9, z: 0 });
    this.ball.setLinvel({ x: 0, y: 0, z: 0 });
    this.ball.setAngvel({ x: 0, y: 2, z: 0 });
  }

  private dropBall() {
    this.phase = 'play';
    this.phaseT = 0;
    this.ball.setTranslation({ x: 0, y: 9, z: 0 });
    this.ball.setLinvel({ x: this.rng.range(-1.2, 1.2), y: -2, z: this.rng.range(-1.2, 1.2) });
    this.ball.setAngvel({ x: this.rng.range(-3, 3), y: 3, z: this.rng.range(-3, 3) });
    this.emit({ type: 'drop', pos: this.ballPos() });
    this.emit({ type: 'whistle', strength: 1 });
  }

  // ---------------- main step ----------------
  step(dt: number, input: PartyInput = NO_INPUT) {
    this.phaseT += dt;
    for (const k of Object.keys(this.cds) as (keyof typeof this.cds)[]) this.cds[k] -= dt;
    this.slowmo = Math.max(0, this.slowmo - dt);
    this.switchCd -= dt;

    if (this.phase === 'countdown') {
      const left = Math.ceil(2.4 - this.phaseT);
      if (left < this.lastCount && left > 0) {
        this.lastCount = left;
        this.emit({ type: 'countdown', strength: left });
      }
      // hold everyone on their spots (they still wobble), ball hovers
      for (const b of this.bros) {
        const s = this.spotFor(b);
        const p = b.position();
        b.intent = { moveX: (s.x - p.x) * 0.8, moveZ: (s.z - p.z) * 0.8, sprint: false, jump: false, dive: false };
        b.face.set(this.teams[b.team].dir, 0, 0);
      }
      this.ball.setTranslation({ x: 0, y: 9 + Math.sin(this.phaseT * 3) * 0.2, z: 0 });
      this.ball.setLinvel({ x: 0, y: 0, z: 0 });
      if (this.phaseT >= 2.4) this.dropBall();
    } else if (this.phase === 'play') {
      this.time += dt;
      if (this.time >= this.opts.matchLength && !this.golden) {
        if (this.teams[0].score === this.teams[1].score) {
          this.golden = true;
          this.emit({ type: 'golden' });
        } else this.finish();
      }
      this.updateChaos(dt);
    } else if (this.phase === 'goal') {
      if (this.phaseT > 3.6) {
        if (this.golden) this.finish();
        else this.startCountdown();
      }
    }

    // --- control: human first (once per step), then the AI ---
    const humanOk = this.controlled && this.phase !== 'countdown' && this.phase !== 'over';
    if (humanOk) this.human(this.controlled!, input, dt);
    if (this.phase !== 'countdown') for (const b of this.bros) if (b !== this.controlled || !humanOk) think(this, b, dt);
    this.prevInput = { ...input };

    this.updateGrabs(dt);
    for (const b of this.bros) b.step(dt, this.world);
    this.ballForces(dt);
    if (this.phase === 'play') this.dribbleAssist(dt);
    if (this.phase === 'play') this.autoSwitch();
    this.switchTarget = this.pickSwitch();
    if (this.sweeper.on) this.updateSweeper(dt);
    this.pendingHits.length = 0;
    this.world.step(dt);
    this.afterHits();
    this.bodyCollisions();
    this.ballEvents();
    if (this.phase === 'play') this.checkBall();
  }

  private finish() {
    this.phase = 'over';
    this.phaseT = 0;
    this.emit({ type: 'whistle', strength: 3 });
    this.emit({ type: 'over' });
    this.endChaos();
    const [a, b] = this.teams;
    const loser = a.score > b.score ? 1 : b.score > a.score ? 0 : -1;
    if (loser >= 0) for (const x of this.teamBros(1 - loser)) x.celebrate = true;
    if (loser >= 0) for (const x of this.teamBros(loser)) x.knockDown(3, new Vector3(this.rng.range(-80, 80), 120, this.rng.range(-80, 80)));
  }

  // ---------------- chaos events ----------------
  private updateChaos(dt: number) {
    if (this.opts.events === false) return;
    if (this.chaos) {
      this.chaos.t += dt;
      if (this.chaos.t >= this.chaos.dur) this.endChaos();
      return;
    }
    if (this.time >= this.nextChaosAt) {
      const kinds = (Object.keys(EVENT_INFO) as EventKind[]).filter((k) => k !== this.lastChaos);
      this.startChaos(this.rng.pick(kinds));
    }
  }

  startChaos(kind: EventKind) {
    this.endChaos();
    this.chaos = { kind, t: 0, dur: kind === 'sweeper' ? 18 : 14 };
    this.lastChaos = kind;
    if (kind === 'mega') this.setBallRadius(1.0, 1.6);
    if (kind === 'lowgrav') this.setGravity(-4.2);
    if (kind === 'sweeper') {
      this.sweeper.on = true;
      this.sweeper.angle = this.rng.range(0, Math.PI);
    }
    this.applyMods();
    this.emit({ type: 'event', text: kind });
  }

  endChaos() {
    if (!this.chaos) return;
    const kind = this.chaos.kind;
    this.chaos = null;
    this.nextChaosAt = this.time + 24;
    if (kind === 'mega') this.setBallRadius(BALL_P.radius, BALL_P.mass);
    if (kind === 'lowgrav') this.setGravity(GRAVITY);
    if (kind === 'sweeper') this.sweeper.on = false;
    this.applyMods();
    this.emit({ type: 'eventEnd', text: kind });
  }

  private setBallRadius(r: number, mass: number) {
    const p = this.ballPos();
    this.ballR = r;
    this.world.setSphereRadius(this.ball, r, mass);
    if (p.y < r) this.ball.setTranslation({ x: p.x, y: r + 0.02, z: p.z });
  }
  private setGravity(g: number) {
    this.gravity = g;
    this.world.setGravity(g);
  }
  /** per-bean speed/accel multipliers from the active event and grabs */
  private applyMods() {
    const k = this.chaos?.kind;
    for (const b of this.bros) {
      b.speedMul = k === 'turbo' ? 1.45 : 1;
      b.accelMul = k === 'ice' ? 0.16 : k === 'turbo' ? 1.5 : 1;
    }
  }

  private updateSweeper(dt: number) {
    const s = this.sweeper;
    s.angle += s.speed * dt;
    const dx = Math.cos(s.angle), dz = Math.sin(s.angle);
    // tangential speed at radius r is speed*r: things in the way get swept
    for (const b of this.bros) {
      const p = b.position();
      const along = p.x * dx + p.z * dz;
      if (Math.abs(along) > s.len) continue;
      const perp = -p.x * dz + p.z * dx;
      const bottom = p.y - BRO.centerY;
      if (Math.abs(perp) < BRO.radius + 0.25 && bottom < s.h + 0.1 && b.state !== 'down') {
        const tv = s.speed * along; // signed tangential speed
        const push = new Vector3(-dz, 0, dx).multiplyScalar(Math.sign(tv) * (6 + Math.abs(tv)) * BRO.mass * 0.5).setY(BRO.mass * 3);
        b.knockDown(1.0, push);
        this.emit({ type: 'bonk', pos: p, strength: 9 });
      }
    }
    const bp = this.ballPos();
    const along = bp.x * dx + bp.z * dz;
    const perp = -bp.x * dz + bp.z * dx;
    if (Math.abs(along) < s.len && Math.abs(perp) < this.ballR + 0.25 && bp.y - this.ballR < s.h) {
      const tv = s.speed * along;
      const n = new Vector3(-dz, 0, dx).multiplyScalar(Math.sign(tv) || 1);
      const v = this.ballVel();
      if (v.dot(n) < Math.abs(tv) + 4) this.ball.setLinvel({ x: n.x * (Math.abs(tv) + 6), y: 3, z: n.z * (Math.abs(tv) + 6) });
    }
  }

  // ---------------- ball ----------------
  private ballForces(dt: number) {
    const v = this.ball.linvel();
    const w = this.ball.angvel();
    const sp = Math.hypot(v.x, v.y, v.z);
    const m = this.ball.mass();
    const y = this.ball.translation().y;
    const air = y > this.ballR + 0.04;
    let fx = -BALL_P.dragK * sp * v.x;
    let fy = -BALL_P.dragK * sp * v.y;
    let fz = -BALL_P.dragK * sp * v.z;
    if (air) {
      fx += BALL_P.magnusK * (w.y * v.z - w.z * v.y);
      fy += BALL_P.magnusK * (w.z * v.x - w.x * v.z);
      fz += BALL_P.magnusK * (w.x * v.y - w.y * v.x);
    } else {
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0.01) {
        const k = Math.min(hs, BALL_P.rollC * dt) / hs;
        this.ball.applyImpulse({ x: -v.x * k * m, y: 0, z: -v.z * k * m }, true);
        // keep the spin consistent with rolling, or ground friction would undo the slowdown
        const rx = v.x * (1 - k), rz = v.z * (1 - k);
        this.ball.setAngvel({ x: rz / this.ballR, y: w.y * 0.98, z: -rx / this.ballR }, true);
      }
    }
    this.ball.applyImpulse({ x: fx * m * dt, y: fy * m * dt, z: fz * m * dt }, true);
  }

  /** dribbling: the ball sticks (loosely) in front of the bean who runs it along */
  private dribbleAssist(dt: number) {
    const bp = this.ballPos();
    if (bp.y > this.ballR + 0.5) {
      this.holder = null;
      return;
    }
    const bv = this.ballVel();
    let best: Bro | null = null;
    let bd = 1e9;
    const reachBase = BRO.radius + this.ballR;
    for (const b of this.bros) {
      if (!b.canAct || b.kickT >= 0 || this.grabbedBy(b)) continue;
      const p = b.position();
      const dx = bp.x - p.x, dz = bp.z - p.z;
      const d = Math.hypot(dx, dz);
      const front = (dx * b.face.x + dz * b.face.z) / (d || 1);
      const mine = b === this.holder;
      if (d < reachBase + (mine ? 1.0 : 0.55) && front > (mine ? -0.3 : 0.3)) {
        const score = d - (mine ? 0.45 : 0);
        if (score < bd) {
          bd = score;
          best = b;
        }
      }
    }
    if (best !== this.holder && best) this.emit({ type: 'kick', pos: bp, strength: 2, team: best.team });
    this.holder = best;
    if (!best) return;
    const p = best.position();
    const v = best.velocity();
    const human = best === this.controlled;
    const off = reachBase + 0.12 + Math.min(0.4, best.speed * 0.04);
    const tx = p.x + best.face.x * off, tz = p.z + best.face.z * off;
    const k = human ? 7 : 5.5;
    const wantX = v.x + (tx - bp.x) * k, wantZ = v.z + (tz - bp.z) * k;
    const m = this.ball.mass();
    const blend = Math.min(1, dt * (human ? 14 : 10));
    this.ball.applyImpulse({ x: (wantX - bv.x) * m * blend, y: 0, z: (wantZ - bv.z) * m * blend }, true);
    this.lastTouch = best;
  }

  /** after the physics step: headers and beans flattened by a fast ball */
  private afterHits() {
    for (const h of this.pendingHits) {
      const b = h.bro;
      const bp = this.ballPos();
      const p = b.position();
      if (!b.grounded && b.state === 'up' && bp.y > p.y + 0.2) {
        // header: nod it towards the goal
        const gx = this.goalX(b.team);
        const d = new Vector3(gx - bp.x, 0, -bp.z * 0.5).normalize();
        const v = this.ballVel();
        this.ball.setLinvel({ x: v.x * 0.3 + d.x * 11, y: Math.max(v.y, 3.5), z: v.z * 0.3 + d.z * 11 });
        this.emit({ type: 'header', pos: bp, team: b.team, strength: 10 });
      } else if (h.speed > 13 && b.state === 'up' && b.kickT < 0) {
        b.knockDown(1.1);
        this.emit({ type: 'bonk', pos: p, strength: h.speed });
      }
    }
  }

  private ballEvents() {
    const v = this.ball.linvel();
    const y = this.ball.translation().y;
    if (this.lastBallVy < -2.5 && v.y > 0.5 && y < this.ballR + 0.2) this.emit({ type: 'bounce', pos: this.ballPos(), strength: -this.lastBallVy });
    this.lastBallVy = v.y;
    const p = this.ballPos();
    // escaped the arena (over the walls): drop a new one from the sky
    if (Math.abs(p.x) > ARENA.length / 2 + ARENA.goalDepthBottom + 3 || Math.abs(p.z) > ARENA.width / 2 + 2 || !Number.isFinite(p.x)) {
      this.ball.setTranslation({ x: 0, y: 9, z: 0 });
      this.ball.setLinvel({ x: 0, y: -2, z: 0 });
      this.emit({ type: 'drop', pos: this.ballPos() });
    }
  }

  private checkBall() {
    const p = this.ballPos();
    const L = ARENA.length / 2;
    if (Math.abs(p.x) > L + this.ballR * 0.9 && Math.abs(p.z) < ARENA.goalHalfW && p.y < ARENA.goalH + 0.3) {
      const scoredOn = p.x > 0 ? (this.teams[0].dir > 0 ? 1 : 0) : this.teams[0].dir > 0 ? 0 : 1; // defends that end
      const team = 1 - scoredOn;
      this.teams[team].score++;
      this.scoredTeam = team;
      this.lastScorer = this.lastTouch;
      this.phase = 'goal';
      this.phaseT = 0;
      this.slowmo = 1.2;
      this.holder = null;
      this.endChaos();
      this.emit({ type: 'goal', team, pos: p });
      this.emit({ type: 'whistle', strength: 2 });
      for (const b of this.teamBros(team)) b.celebrate = true;
      // the conceding team flops over in despair
      for (const b of this.teamBros(scoredOn)) if (this.rng.chance(0.75)) b.knockDown(2.2, new Vector3(this.rng.range(-60, 60), 90, this.rng.range(-60, 60)));
    }
  }

  // ---------------- beans vs beans ----------------
  private bodyCollisions() {
    const bs = this.bros;
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        const pa = a.position(), pb = b.position();
        const d = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        const diving = a.state === 'dive' || b.state === 'dive';
        if (d > BRO.radius * 2 + (diving ? 0.5 : 0.12) || Math.abs(pa.y - pb.y) > 1.3) continue;
        const n = pb.clone().sub(pa).setY(0).normalize();
        const rel = a.velocity().sub(b.velocity()).dot(n); // closing speed
        if (a.team !== b.team) {
          // a sliding tackle flattens whoever it hits
          for (const [diver, victim, s] of [[a, b, 1], [b, a, -1]] as const) {
            if (diver.state === 'dive' && victim.state === 'up' && Math.abs(rel) > 1.5) {
              victim.knockDown(1.3, n.clone().multiplyScalar(s * 110).setY(70));
              this.emit({ type: 'tackle', pos: pa.clone().lerp(pb, 0.5), strength: 9 });
              if (this.holder === victim) this.holder = null;
              return;
            }
          }
        }
        if (rel < 4.6) continue;
        if (rel > 9) {
          a.knockDown(1.3);
          b.knockDown(1.3);
        } else if (a.speed > b.speed) b.knockDown(1.1, n.clone().multiplyScalar(rel * 25).setY(80));
        else a.knockDown(1.1, n.clone().multiplyScalar(-rel * 25).setY(80));
        this.emit({ type: 'bonk', pos: pa.clone().lerp(pb, 0.5), strength: rel });
      }
    // a diving bean that reaches the ball pokes it away
    const bp = this.ballPos();
    for (const b of bs) {
      if (b.state !== 'dive') continue;
      const p = b.position();
      if (Math.hypot(bp.x - p.x, bp.z - p.z) < BRO.radius + this.ballR + 0.35 && bp.y < 1.6) {
        const v = this.ballVel();
        if (v.dot(b.face) < 7) {
          this.ball.setLinvel({ x: b.face.x * 9, y: 2.5, z: b.face.z * 9 });
          this.lastTouch = b;
          if (this.holder && this.holder.team !== b.team) this.holder = null;
          this.emit({ type: 'kick', pos: bp, strength: 9, team: b.team });
        }
      }
    }
  }

  // ---------------- grabs (Fall Guys!) ----------------
  tryGrab(b: Bro) {
    if (b.grabbing || b.grabCd > 0 || !b.canAct) return false;
    const p = b.position();
    let best: Bro | null = null;
    let bd = 1.7;
    for (const o of this.bros) {
      if (o.team === b.team || o.state === 'down') continue;
      const q = o.position();
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      const front = ((q.x - p.x) * b.face.x + (q.z - p.z) * b.face.z) / (d || 1);
      if (d < bd && front > 0.2) {
        bd = d;
        best = o;
      }
    }
    if (!best) {
      b.grabCd = 0.4; // whiffed grab
      return false;
    }
    b.grabbing = best;
    b.grabT = 0;
    if (this.holder === best) this.holder = null;
    this.emit({ type: 'grab', pos: best.position(), team: b.team });
    return true;
  }
  release(b: Bro) {
    if (!b.grabbing) return;
    b.grabbing = null;
    b.grabCd = 1.6;
  }
  private updateGrabs(dt: number) {
    for (const b of this.bros) {
      const g = b.grabbing;
      if (!g) continue;
      b.grabT += dt;
      const p = b.position(), q = g.position();
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (b.grabT > 2.4 || d > 2.6 || b.state !== 'up' || g.state === 'down') {
        this.release(b);
        continue;
      }
      // elastic arm: pull the victim back towards the grabber
      if (d > 1.0) {
        const k = (d - 1.0) * 160 * dt;
        g.body.applyImpulse({ x: ((p.x - q.x) / d) * k, y: 0, z: ((p.z - q.z) / d) * k }, true);
      }
    }
    this.applyMods();
    for (const b of this.bros) {
      if (b.grabbing) b.speedMul *= 0.6;
      if (this.grabbedBy(b)) b.speedMul *= 0.35;
    }
  }

  // ---------------- actions ----------------
  /** can `b` strike the ball right now? */
  inReach(b: Bro) {
    if (!b.canAct) return false;
    const bp = this.ballPos();
    const p = b.position();
    const dx = bp.x - p.x, dz = bp.z - p.z;
    const d = Math.hypot(dx, dz);
    const front = (dx * b.face.x + dz * b.face.z) / (d || 1);
    return d < BRO.radius + this.ballR + 0.95 && (front > -0.1 || d < BRO.radius + this.ballR + 0.3) && bp.y < 2.4;
  }

  /** strike the ball with velocity `vel` (world). Returns false on a whiff. */
  private strike(b: Bro, vel: Vector3, spinY = 0, roll = false) {
    b.kickT = 0;
    if (!this.inReach(b)) return false;
    const turbo = this.chaos?.kind === 'turbo' ? 1.2 : 1;
    vel.x *= turbo;
    vel.z *= turbo;
    const bp = this.ballPos();
    // lift the ball off the ground a touch so it does not scrape
    if (bp.y < this.ballR + 0.05) this.ball.setTranslation({ x: bp.x, y: this.ballR + 0.05, z: bp.z });
    this.ball.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
    const h = Math.hypot(vel.x, vel.z) || 1;
    const r = roll ? h / this.ballR : 4;
    this.ball.setAngvel({ x: (vel.z / h) * r, y: spinY, z: (-vel.x / h) * r }, true);
    this.holder = null;
    this.lastTouch = b;
    this.emit({ type: 'kick', pos: bp, strength: Math.hypot(vel.x, vel.y, vel.z), team: b.team });
    return true;
  }

  /** shot: towards the goal when roughly facing it (aim assist), else straight ahead */
  shoot(b: Bro, power: number, aimZ?: number) {
    const bp = this.ballPos();
    const gx = this.goalX(b.team);
    const toGoal = new Vector3(gx - bp.x, 0, (aimZ ?? 0) - bp.z);
    const dist = toGoal.length();
    toGoal.normalize();
    let dir = b.face.clone();
    if (dir.dot(toGoal) > 0.35 || aimZ !== undefined) {
      const z = aimZ ?? this.rng.range(-1, 1) * (ARENA.goalHalfW - 1.0);
      dir = new Vector3(gx - bp.x, 0, z - bp.z).normalize();
    }
    // clumsiness
    dir.applyAxisAngle(new Vector3(0, 1, 0), this.rng.gauss() * (0.02 + 0.05 * power));
    const speed = 13 + power * 15;
    const lift = Math.min(0.32, 0.1 + 0.2 * power + (dist > 20 ? 0.06 : 0));
    return this.strike(b, dir.multiplyScalar(speed).setY(speed * lift), this.rng.range(-6, 6));
  }

  /** ground pass to a mate, leading his run */
  passTo(b: Bro, mate: Bro) {
    const bp = this.ballPos();
    const q = mate.position();
    const mv = mate.velocity();
    let d = Math.hypot(q.x - bp.x, q.z - bp.z);
    const arrive = 4.5;
    let v = Math.sqrt(arrive * arrive + 2 * BALL_P.rollC * d);
    const lead = d / Math.max(6, v);
    const tx = q.x + mv.x * lead * 0.8, tz = q.z + mv.z * lead * 0.8;
    d = Math.hypot(tx - bp.x, tz - bp.z);
    v = Math.min(24, Math.sqrt(arrive * arrive + 2 * BALL_P.rollC * d) * (1 + BALL_P.dragK * d * 0.6));
    const dir = new Vector3(tx - bp.x, 0, tz - bp.z).normalize();
    dir.applyAxisAngle(new Vector3(0, 1, 0), this.rng.gauss() * 0.03);
    return this.strike(b, dir.multiplyScalar(v).setY(0.5), 0, true);
  }

  /** lofted ball (cross / chip) landing at `target` */
  lob(b: Bro, target: Vector3) {
    const bp = this.ballPos();
    const d = Math.max(3, Math.hypot(target.x - bp.x, target.z - bp.z));
    const T = 0.55 + d / 19;
    const g = -this.gravity;
    const vy = (g * T) / 2;
    const vh = (d / T) * (1 + BALL_P.dragK * d * 0.5);
    const dir = new Vector3(target.x - bp.x, 0, target.z - bp.z).normalize();
    dir.applyAxisAngle(new Vector3(0, 1, 0), this.rng.gauss() * 0.04);
    return this.strike(b, dir.multiplyScalar(vh).setY(vy), 0);
  }

  /** teammate `b` would pass to: in the facing cone, otherwise the best-placed one */
  bestMate(b: Bro, ahead = false) {
    const p = b.position();
    let best: Bro | null = null;
    let bs = -1e9;
    for (const q of this.teamBros(b.team)) {
      if (q === b || q.state === 'down') continue;
      const qp = q.position();
      const dx = qp.x - p.x, dz = qp.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 2.5) continue;
      const cos = (dx * b.face.x + dz * b.face.z) / dist;
      const fwd = (qp.x - p.x) * this.teams[b.team].dir;
      // is an opponent standing in the lane?
      let blocked = 0;
      for (const o of this.teamBros(1 - b.team)) {
        const op = o.position();
        const t = ((op.x - p.x) * dx + (op.z - p.z) * dz) / (dist * dist);
        if (t < 0.1 || t > 0.95) continue;
        const px = p.x + dx * t, pz = p.z + dz * t;
        if (Math.hypot(op.x - px, op.z - pz) < 1.3) blocked++;
      }
      const s = cos * 3 + (ahead ? fwd * 0.12 : 0) - dist * 0.04 - blocked * (ahead ? 0.5 : 2);
      if (s > bs) {
        bs = s;
        best = q;
      }
    }
    return best;
  }

  /** where a lob goes: the most advanced mate ahead, or the far post when near the goal */
  lobTarget(b: Bro) {
    const p = b.position();
    const gx = this.goalX(b.team);
    const dir = this.teams[b.team].dir;
    if (Math.abs(gx - p.x) < 14) return new Vector3(gx - dir * 3.5, 0, -Math.sign(p.z || 1) * 2);
    const m = this.bestMate(b, true);
    if (m) {
      const q = m.position();
      return new Vector3(q.x + dir * 2.5, 0, q.z);
    }
    return p.clone().addScaledVector(b.face, 18);
  }

  // ---------------- switching beans ----------------
  /** best teammate to take over: the one on the ball, else the one who gets to it first */
  pickSwitch(skip: Bro[] = []): Bro | null {
    const c = this.controlled;
    if (!c) return null;
    const bp = this.ballPos();
    let best: Bro | null = null;
    let bs = 1e9;
    for (const b of this.teamBros(c.team)) {
      if (b === c || skip.includes(b)) continue;
      const p = b.position();
      let s = Math.hypot(bp.x - p.x, bp.z - p.z);
      if (b === this.holder) s -= 100;
      if (b.state !== 'up') s += 8;
      if (s < bs) {
        bs = s;
        best = b;
      }
    }
    return best;
  }

  switchTo(b: Bro | null) {
    const c = this.controlled;
    if (!b || !c || b === c || b.team !== c.team) return;
    c.charging = null;
    c.kickCharge = 0;
    if (c.grabbing) this.release(c);
    this.buffer = null;
    this.controlled = b;
    this.switchCd = 0.6;
    this.emit({ type: 'switch', pos: b.position(), team: b.team });
  }

  /** a teammate got the ball (e.g. your pass arrived): take him over */
  private autoSwitch() {
    const c = this.controlled;
    const h = this.holder;
    if (!c || this.opts.autoSwitch === false || !h || h === c || h.team !== c.team || this.switchCd > 0) return;
    this.switchTo(h);
    this.switchCycle = [];
  }

  // ---------------- the human bean ----------------
  private human(b: Bro, input: PartyInput, dt: number) {
    const prev = this.prevInput;
    if (input.switch && !prev.switch) {
      // repeated presses cycle through the next-best teammates
      if (this.switchCycle.length && this.switchCycle[this.switchCycle.length - 1] === b && this.switchCd > -1.2) {
        const next = this.pickSwitch(this.switchCycle);
        if (next) this.switchCycle.push(next);
        else this.switchCycle = [b];
      } else this.switchCycle = [b];
      const target = this.switchCycle.length > 1 ? this.switchCycle[this.switchCycle.length - 1] : this.pickSwitch();
      if (this.switchCycle.length === 1 && target) this.switchCycle.push(target);
      this.switchTo(target);
      b = this.controlled!;
    }
    b.intent = { moveX: input.mx, moveZ: input.mz, sprint: input.sprint, jump: input.jump, dive: input.tackle && !prev.tackle };
    if (this.phase === 'goal') return;
    // grab: hold to hang on
    if (input.grab && !prev.grab) this.tryGrab(b);
    if (!input.grab && b.grabbing) this.release(b);
    // kick: hold to charge, release to strike
    if (input.kick && b.canAct) {
      b.charging = 'kick';
      b.kickCharge = Math.min(0.8, b.kickCharge + dt);
    } else if (!input.kick && prev.kick && b.charging === 'kick') {
      this.buffer = { kind: 'kick', power: Math.min(1, b.kickCharge / 0.8), t: 0 };
      b.charging = null;
      b.kickCharge = 0;
    } else if (!input.kick) b.charging = null;
    if (input.pass && !prev.pass) this.buffer = { kind: 'pass', power: 0, t: 0 };
    if (input.lob && !prev.lob) this.buffer = { kind: 'lob', power: 0, t: 0 };
    // buffered action fires as soon as the ball is in reach (forgiving timing)
    const buf = this.buffer;
    if (buf) {
      buf.t += dt;
      if (this.inReach(b)) {
        this.buffer = null;
        if (buf.kind === 'kick') this.shoot(b, buf.power);
        else if (buf.kind === 'pass') {
          const m = this.bestMate(b);
          if (m) this.passTo(b, m);
          else this.shoot(b, 0.3);
        } else this.lob(b, this.lobTarget(b));
      } else if (buf.t > 0.6) {
        this.buffer = null;
        b.kickT = 0; // swing at thin air
      }
    }
  }
}
