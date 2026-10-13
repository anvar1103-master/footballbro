import { PBody, PWorld, Tag } from './phys';
import { Vector3 } from 'three';
import type { FieldDims } from '../sim/config';
import { Rng } from '../sim/rng';
import { TEAM_PRESETS, TeamInfo, CHARACTER_MODELS } from '../sim/team';
import { Bro, BRO } from './bro';
import { think } from './brain';

/**
 * Party football world (new footballbro): Rapier physics, wobbly bros, a big bouncy ball
 * with drag + Magnus curl, boarded arena (no throw-ins), goals with soft nets.
 * Pure logic — no rendering — so it runs headless in tests.
 */

export const PARTY_DT = 1 / 120;

export const BALL_P = {
  radius: 0.3,
  mass: 0.6,
  dragK: 0.012,
  magnusK: 0.004,
};

/** Arena: a small pitch fully enclosed by boards. Shaped like FieldDims so classic visuals can be reused. */
export const ARENA: FieldDims = {
  length: 46,
  width: 30,
  goalHalfW: 3.2,
  goalH: 2.3,
  goalDepthTop: 1.4,
  goalDepthBottom: 2.0,
  boxDepth: 8,
  boxHalfW: 9,
  smallBoxDepth: 3,
  smallBoxHalfW: 5,
  penaltySpot: 6.5,
  centerRadius: 4.5,
  boardMargin: 1.6,
};

export interface PartyInput {
  mx: number;
  my: number;
  sprint: boolean;
  jump: boolean;
  kick: boolean;
  pass: boolean;
  dive: boolean;
  shove: boolean;
  switch: boolean;
}
export const NO_INPUT: PartyInput = { mx: 0, my: 0, sprint: false, jump: false, kick: false, pass: false, dive: false, shove: false, switch: false };

export interface PartyEvent {
  type: 'kick' | 'bounce' | 'post' | 'net' | 'goal' | 'bonk' | 'shove' | 'whistle' | 'save';
  pos?: Vector3;
  strength?: number;
  team?: number;
}

export interface Team {
  index: number;
  info: TeamInfo;
  score: number;
  /** +1 attacks the goal at +x */
  dir: number;
}

export type Phase = 'kickoff' | 'play' | 'goal' | 'over';

export class PartyWorld {
  world!: PWorld;
  ball!: PBody;
  bros: Bro[] = [];
  teams: Team[];
  rng: Rng;
  time = 0;
  clock = 0;
  phase: Phase = 'kickoff';
  phaseT = 0;
  events: PartyEvent[] = [];
  controlled: Bro | null = null;
  humanTeam: number;
  lastTouch: Bro | null = null;
  lastScorer: Bro | null = null;
  lastGoalTeam = -1;
  prevInput: PartyInput = { ...NO_INPUT };
  private lastBallVy = 0;
  kickoffTeam = 0;

  constructor(public opts: { humanTeam: number; perTeam: number; matchLength: number; seed?: number; teams?: [TeamInfo, TeamInfo] }) {
    this.rng = new Rng(opts.seed ?? (Date.now() & 0xffff));
    this.humanTeam = opts.humanTeam;
    const infos = opts.teams ?? [TEAM_PRESETS[0], TEAM_PRESETS[1]];
    this.teams = [
      { index: 0, info: infos[0], score: 0, dir: 1 },
      { index: 1, info: infos[1], score: 0, dir: -1 },
    ];
  }

  /** async for API stability (a WASM engine would need an init) */
  static async create(opts: PartyWorld['opts']) {
    const w = new PartyWorld(opts);
    w.build();
    return w;
  }

  private build() {
    const f = ARENA;
    this.world = new PWorld(-11.5);
    const W = this.world;
    W.ground();
    // boards + invisible tall walls (ball and bros stay in the arena)
    const bx = f.length / 2 + f.boardMargin + 1.5; // same as the classic stadium boards
    const bz = f.width / 2 + f.boardMargin;
    W.box('wall', bx + 1, 6, 0.5, 0, 6, -bz - 0.5);
    W.box('wall', bx + 1, 6, 0.5, 0, 6, bz + 0.5);
    W.box('wall', 0.5, 6, bz + 1, -bx - 0.5, 6, 0);
    W.box('wall', 0.5, 6, bz + 1, bx + 0.5, 6, 0);
    // goal frames and soft nets
    for (const dir of [-1, 1]) {
      const x0 = (dir * f.length) / 2;
      const r = 0.07;
      W.cylinder('post', r, f.goalH / 2, x0, f.goalH / 2, -f.goalHalfW);
      W.cylinder('post', r, f.goalH / 2, x0, f.goalH / 2, f.goalHalfW);
      W.cylinder('post', r, f.goalHalfW, x0, f.goalH, 0, true);
      // net panels sit a little behind the cloth so the ball visibly bulges it
      const d = f.goalDepthBottom + 0.35;
      W.box('net', 0.1, f.goalH / 2 + 0.3, f.goalHalfW + 0.3, x0 + dir * (d + 0.1), f.goalH / 2, 0); // back
      W.box('net', d / 2, f.goalH / 2, 0.1, x0 + dir * (d / 2), f.goalH / 2, -(f.goalHalfW + 0.35)); // sides
      W.box('net', d / 2, f.goalH / 2, 0.1, x0 + dir * (d / 2), f.goalH / 2, f.goalHalfW + 0.35);
      W.box('net', d / 2, 0.1, f.goalHalfW + 0.3, x0 + dir * (d / 2), f.goalH + 0.35, 0); // roof
    }
    // ball
    this.ball = W.ball(BALL_P.radius, BALL_P.mass, 0.077, 0.3);
    this.ball.setTranslation({ x: 0, y: BALL_P.radius, z: 0 });
    W.onBallHit = (tag: Tag, sp: number) => {
      if (tag === 'net' && sp > 3 && this.netCd <= 0) {
        this.netCd = 0.4;
        this.emit({ type: 'net', pos: this.ballPos(), strength: sp });
      }
      if (tag === 'post' && sp > 3 && this.postCd <= 0) {
        this.postCd = 0.4;
        this.emit({ type: 'post', pos: this.ballPos(), strength: sp });
      }
    };
    // bros: GK + field players per team
    let id = 0;
    const models = [...CHARACTER_MODELS.keys()].sort(() => this.rng.next() - 0.5);
    for (const t of this.teams) {
      for (let i = 0; i < this.opts.perTeam; i++) {
        const role = i === 0 ? 'GK' : 'FIELD';
        const b = new Bro(W, id, t.index, role, models[id % models.length], `${t.info.short} ${i + 1}`, 0, 0);
        this.bros.push(b);
        id++;
      }
    }
    this.startKickoff(this.rng.chance(0.5) ? 0 : 1);
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
  ballSpin(out = new Vector3()) {
    const w = this.ball.angvel();
    return out.set(w.x, w.y, w.z);
  }
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

  startKickoff(team: number) {
    this.kickoffTeam = team;
    this.phase = 'kickoff';
    this.phaseT = 0;
    this.ball.setTranslation({ x: 0, y: BALL_P.radius + 0.02, z: 0 }, true);
    this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const t of this.teams) {
      const bros = this.teamBros(t.index);
      const n = bros.length - 1;
      bros.forEach((b, i) => {
        const back = -t.dir;
        if (b.role === 'GK') b.teleport(back * (ARENA.length / 2 - 1.2), 0, t.dir);
        else {
          const k = i - 1;
          const z = n > 1 ? (k / (n - 1) - 0.5) * ARENA.width * 0.55 : 0;
          const x = back * (t.index === team && k === 0 ? 1.2 : ARENA.length * 0.18 + (k % 2) * 3);
          b.teleport(x, t.index === team && k === 0 ? 0 : z, t.dir);
        }
      });
    }
    if (this.humanTeam >= 0) this.controlled = this.teamBros(this.humanTeam).find((b) => b.role === 'FIELD') ?? null;
  }

  // ---------------- main step ----------------
  step(dt: number, input: PartyInput = NO_INPUT) {
    this.time += dt;
    this.phaseT += dt;
    if (this.phase === 'play') this.clock += dt;
    if (this.phase === 'kickoff' && this.phaseT > 1.2) {
      this.phase = 'play';
      this.emit({ type: 'whistle', strength: 2 });
    }
    if (this.phase === 'goal' && this.phaseT > 3.2) {
      if (this.clock >= this.opts.matchLength) {
        this.phase = 'over';
        this.emit({ type: 'whistle', strength: 3 });
      } else this.startKickoff(1 - this.lastGoalTeam);
    }
    if (this.phase === 'play' && this.clock >= this.opts.matchLength) {
      this.phase = 'over';
      this.phaseT = 0;
      this.emit({ type: 'whistle', strength: 3 });
    }

    // brains
    for (const b of this.bros) {
      if (b === this.controlled && this.phase !== 'goal') this.human(b, input, dt);
      else think(this, b, dt);
    }
    this.prevInput = { ...input };

    // physics
    for (const b of this.bros) b.step(dt, this.world);
    this.ballForces(dt);
    this.dribbleAssist(dt);
    this.world.step(dt);
    this.bodyCollisions();
    this.ballEvents();
    if (this.phase === 'play') this.checkGoal();
  }

  // ---------------- ball ----------------
  private ballForces(dt: number) {
    const v = this.ball.linvel();
    const w = this.ball.angvel();
    const sp = Math.hypot(v.x, v.y, v.z);
    const m = this.ball.mass();
    const air = this.ball.translation().y > BALL_P.radius + 0.05;
    // quadratic drag + Magnus (spin x velocity) — the curl
    let fx = -BALL_P.dragK * sp * v.x;
    let fy = -BALL_P.dragK * sp * v.y;
    let fz = -BALL_P.dragK * sp * v.z;
    if (air) {
      fx += BALL_P.magnusK * (w.y * v.z - w.z * v.y);
      fy += BALL_P.magnusK * (w.z * v.x - w.x * v.z);
      fz += BALL_P.magnusK * (w.x * v.y - w.y * v.x);
    }
    this.ball.applyImpulse({ x: fx * m * dt, y: fy * m * dt, z: fz * m * dt }, true);
  }

  /** A gentle "magnet": a bro running with the ball in front keeps it close (clumsily). */
  private dribbleAssist(dt: number) {
    if (this.phase !== 'play') return;
    const bp = this.ballPos();
    if (bp.y > 0.8) return;
    const bv = this.ballVel();
    let best: Bro | null = null;
    let bd = 1.1;
    for (const b of this.bros) {
      if (!b.canAct || b.kickT >= 0) continue;
      const p = b.position();
      const dx = bp.x - p.x, dz = bp.z - p.z;
      const d = Math.hypot(dx, dz);
      const front = (dx * b.face.x + dz * b.face.z) / (d || 1);
      if (d < bd && front > 0.3) {
        bd = d;
        best = b;
      }
    }
    if (!best) return;
    const p = best.position();
    const v = best.velocity();
    const tx = p.x + best.face.x * 0.75, tz = p.z + best.face.z * 0.75;
    const k = 4.5 * (best.team === this.humanTeam ? 1.25 : 1);
    const wantX = v.x + (tx - bp.x) * k, wantZ = v.z + (tz - bp.z) * k;
    const m = this.ball.mass();
    const blend = Math.min(1, dt * 7);
    this.ball.applyImpulse({ x: (wantX - bv.x) * m * blend, y: 0, z: (wantZ - bv.z) * m * blend }, true);
    this.lastTouch = best;
  }

  private ballEvents() {
    const v = this.ball.linvel();
    const y = this.ball.translation().y;
    if (this.lastBallVy < -2.2 && v.y > 0.5 && y < BALL_P.radius + 0.2) this.emit({ type: 'bounce', pos: this.ballPos(), strength: -this.lastBallVy });
    this.lastBallVy = v.y;
    this.netCd -= PARTY_DT;
    this.postCd -= PARTY_DT;
  }
  private netCd = 0;
  private postCd = 0;

  private checkGoal() {
    const p = this.ballPos();
    const f = ARENA;
    if (Math.abs(p.x) > f.length / 2 + BALL_P.radius && Math.abs(p.z) < f.goalHalfW && p.y < f.goalH) {
      const side = Math.sign(p.x);
      const scorer = this.teams.find((t) => t.dir === side)!;
      scorer.score++;
      this.lastGoalTeam = scorer.index;
      this.lastScorer = this.lastTouch;
      this.phase = 'goal';
      this.phaseT = 0;
      this.emit({ type: 'goal', team: scorer.index, pos: p.clone() });
    }
  }

  // ---------------- bros vs bros ----------------
  private bodyCollisions() {
    const bs = this.bros;
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        const pa = a.position(), pb = b.position();
        const d = pa.distanceTo(pb);
        if (d > BRO.radius * 2 + 0.08) continue;
        const n = pb.clone().sub(pa).setY(0).normalize();
        const rel = a.velocity().sub(b.velocity()).dot(n); // closing speed
        if (rel < 4.2) continue;
        // the slower / less upright one goes down; a big hit floors both
        const ia = a.speed, ib = b.speed;
        if (rel > 8.5) {
          a.knockDown(1.3);
          b.knockDown(1.3);
        } else if (ia > ib) b.knockDown(1.1, n.clone().multiplyScalar(rel * 25).setY(80));
        else a.knockDown(1.1, n.clone().multiplyScalar(-rel * 25).setY(80));
        this.emit({ type: 'bonk', pos: pa.clone().lerp(pb, 0.5), strength: rel });
      }
  }

  // ---------------- actions ----------------
  /** Strike the ball if it is near the foot. Aim assist steers towards a target. */
  kick(b: Bro, power: number, target: Vector3 | null, lift = 0.25, curl = 0) {
    if (!b.canAct) return false;
    b.kickT = 0;
    const p = b.position();
    const bp = this.ballPos();
    const foot = p.clone().addScaledVector(b.face, 0.45);
    foot.y = 0.25;
    if (foot.distanceTo(bp) > BRO.kickReach + BALL_P.radius) return false; // whiff
    const dir = target ? target.clone().sub(bp).setY(0).normalize() : b.face.clone();
    // a little clumsiness: direction error grows with power and when not facing the target
    const facing = dir.dot(b.face);
    const err = this.rng.gauss() * (0.04 + power * 0.06 + (1 - facing) * 0.12);
    dir.applyAxisAngle(new Vector3(0, 1, 0), err);
    const speed = 7 + power * 19;
    const up = lift * (0.5 + power) * speed * 0.6;
    const m = this.ball.mass();
    this.ball.setLinvel({ x: dir.x * speed, y: up, z: dir.z * speed }, true);
    // topspin + optional side spin (curl)
    this.ball.setAngvel({ x: dir.z * 8, y: curl * (25 + 20 * power), z: -dir.x * 8 }, true);
    void m;
    this.lastTouch = b;
    this.emit({ type: 'kick', pos: bp, strength: speed, team: b.team });
    return true;
  }

  shove(b: Bro) {
    if (!b.canAct || b.shoveCd > 0) return;
    b.shoveCd = 0.8;
    b.shoveT = 0;
    const p = b.position();
    let hit: Bro | null = null;
    let hd = 1.5;
    for (const o of this.bros) {
      if (o === b) continue;
      const op = o.position();
      const d = op.distanceTo(p);
      const front = op.clone().sub(p).setY(0).normalize().dot(b.face);
      if (d < hd && front > 0.4) {
        hd = d;
        hit = o;
      }
    }
    // lunge a bit forward either way
    const m = b.body.mass();
    b.body.applyImpulse({ x: b.face.x * m * 2.5, y: 0, z: b.face.z * m * 2.5 }, true);
    if (hit) {
      const push = b.face.clone().multiplyScalar(hit.body.mass() * 6).setY(hit.body.mass() * 1.5);
      if (hit.state === 'up' && this.rng.chance(0.55)) hit.knockDown(1.2, push);
      else hit.body.applyImpulse({ x: push.x, y: push.y, z: push.z }, true);
      this.emit({ type: 'shove', pos: hit.position(), strength: 6 });
    }
  }

  // ---------------- human ----------------
  private pressed(input: PartyInput, k: keyof PartyInput) {
    return !!input[k] && !this.prevInput[k];
  }

  private human(b: Bro, input: PartyInput, dt: number) {
    // stick: right = +x, up = -z (camera looks towards -z)
    const l = Math.hypot(input.mx, input.my);
    b.intent.moveX = l > 0.1 ? input.mx : 0;
    b.intent.moveZ = l > 0.1 ? -input.my : 0;
    b.intent.sprint = input.sprint;
    b.intent.jump = this.pressed(input, 'jump');
    b.intent.dive = this.pressed(input, 'dive');
    if (this.phase !== 'play') {
      b.intent.moveX = b.intent.moveZ = 0;
      return;
    }
    if (this.pressed(input, 'switch')) {
      const bp = this.ballPos();
      const next = this.teamBros(b.team)
        .filter((x) => x !== b && x.role === 'FIELD')
        .sort((x, y) => x.position().distanceTo(bp) - y.position().distanceTo(bp))[0];
      if (next) this.controlled = next;
      return;
    }
    if (this.pressed(input, 'shove')) this.shove(b);
    // charge kick / pass while held, strike on release
    for (const k of ['kick', 'pass'] as const) {
      if (this.pressed(input, k) && !b.charging) {
        b.charging = k;
        b.kickCharge = 0;
      }
    }
    if (b.charging) {
      if (input[b.charging]) b.kickCharge += dt;
      else {
        const power = Math.min(1, b.kickCharge / 0.8);
        if (b.charging === 'kick') this.humanShot(b, power, input);
        else this.humanPass(b, power);
        b.charging = null;
        b.kickCharge = 0;
      }
    }
  }

  private humanShot(b: Bro, power: number, input: PartyInput) {
    const gx = this.goalX(b.team);
    const p = b.position();
    // assisted only when roughly facing the goal and in range
    const toGoal = new Vector3(gx - p.x, 0, -p.z);
    const dist = toGoal.length();
    const facingGoal = toGoal.normalize().dot(b.face) > 0.35;
    if (facingGoal && dist < 26) {
      const side = Math.abs(input.my) > 0.3 ? -Math.sign(input.my) : -Math.sign(p.z || 1);
      const target = new Vector3(gx, 0, side * (ARENA.goalHalfW - 0.8));
      // curl back towards the middle of the goal when shooting across
      const curl = Math.abs(p.z) > 4 ? Math.sign(p.z) * this.teams[b.team].dir * -0.6 : 0;
      this.kick(b, Math.max(0.35, power), target, 0.18, curl);
    } else this.kick(b, Math.max(0.3, power), null, 0.25);
  }

  private humanPass(b: Bro, power: number) {
    const p = b.position();
    const mates = this.teamBros(b.team).filter((x) => x !== b && x.state !== 'down');
    let best: Bro | null = null;
    let bs = -1e9;
    for (const q of mates) {
      const d = q.position().sub(p).setY(0);
      const dist = d.length();
      const cos = d.normalize().dot(b.face);
      const s = cos * 3 - Math.abs(dist - (6 + power * 18)) * 0.08 - (q.role === 'GK' ? 1.5 : 0);
      if (cos > 0 && s > bs) {
        bs = s;
        best = q;
      }
    }
    if (best) {
      const target = best.position().addScaledVector(best.velocity(), 0.5);
      const dist = target.distanceTo(p);
      const pw = Math.min(1, Math.max(0.15, (dist - 4) / 22 + power * 0.25));
      this.kick(b, pw, target, 0.05 + (dist > 18 ? 0.25 : 0));
      if (b.team === this.humanTeam && best.role === 'FIELD') this.controlled = best;
    } else this.kick(b, Math.max(0.25, power), null, 0.08);
  }
}
