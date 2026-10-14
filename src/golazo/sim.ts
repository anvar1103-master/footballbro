import { Vector2, Vector3 } from 'three';
import { Ball } from '../sim/ball';
import { BALL, fieldFor, SIM_DT } from '../sim/config';
import { Rng } from '../sim/rng';
import { groundSpeed, Kick, rollTime, solveGround, solveLofted, solveThrough } from './solve';
import type { LevelDef } from './levels';

/**
 * Golazo moment simulation (pure logic, deterministic, runs in node).
 *
 * A level is a frozen moment of a match. While frozen ('aim') the player draws where the ball goes;
 * the kick is solved exactly onto the drawn target (curl from the drawn bend). Then time runs
 * ('fly'): team-mates make their runs, defenders try to cut the ball out, the keeper reads the
 * shot (from its initial direction — a curler fools him) and dives. A team-mate who reaches the
 * ball freezes the moment again (controlled at his feet, or in the air for a volley / header).
 * A goal ends the level with points and stars; an interception, save or miss fails it.
 */

export const FIELD = fieldFor(11);
export const GOAL_X = FIELD.length / 2;
export const HW = FIELD.goalHalfW;
export const GH = FIELD.goalH;

export type Role = 'mate' | 'def' | 'gk' | 'wall';
export type ActionType = 'shot' | 'pass' | 'lob';
export type Touch = 'feet' | 'volley' | 'header';

export interface Action {
  type: ActionType;
  /** world target: shots — a point on the goal-line plane; passes — a point on the ground */
  target: Vector3;
  /** -1..1, from the bend of the drawn line (+ = the ball bends to the right of its travel) */
  curl: number;
}

export interface Actor {
  id: number;
  team: 0 | 1;
  role: Role;
  name: string;
  number: number;
  pos: Vector3;
  vel: Vector3;
  face: Vector3;
  start: Vector3;
  /** run paths per kick index (mates) */
  runs: Vector3[][];
  runDelay: number[];
  path: Vector3[] | null;
  pathDelay: number;
  goal: Vector3 | null;
  speed: number;
  reach: number;
  zone: number;
  react: number;
  // animation hints for the renderer
  kickT: number;
  kickKind: 'shot' | 'pass' | 'lob' | 'volley' | 'header';
  jump: number;
  jumpV: number;
  dive: number; // -1..1 lateral dive progress (keeper), 0 = standing
  diveUp: number;
  celebrate: boolean;
  sad: boolean;
  beaten: boolean;
}

export interface SimEvent {
  type: 'kick' | 'receive' | 'freeze' | 'intercept' | 'save' | 'block' | 'post' | 'bounce' | 'net' | 'goal' | 'miss' | 'lost' | 'jump' | 'dive' | 'catch';
  pos?: Vector3;
  strength?: number;
  actor?: number;
  text?: string;
}

export interface Bonus {
  label: string;
  pts: number;
}

export interface Result {
  ok: boolean;
  reason: string;
  points: number;
  bonuses: Bonus[];
  stars: number;
}

interface KeeperPlan {
  t0: number;
  /** time the ball crosses the keeper plane (from the read) */
  cross: number;
  z: number;
  y: number;
  dived: boolean;
}

const tmp = new Vector3();
const tmp2 = new Vector3();

export const W = (d: number, z: number, y = 0) => new Vector3(GOAL_X - d, y, z);

export class Moment {
  ball = new Ball(FIELD);
  actors: Actor[] = [];
  phase: 'aim' | 'windup' | 'fly' | 'over' = 'aim';
  holder: Actor | null = null;
  touch: Touch = 'feet';
  receiver: Actor | null = null;
  result: Result | null = null;
  events: SimEvent[] = [];
  kicks = 0;
  t = 0;
  flyT = 0;
  overT = 0;
  private windT = 0;
  private pending: { action: Action; kick: Kick } | null = null;
  lastAction: Action | null = null;
  lastKickFrom = new Vector3();
  lastKickTouch: Touch = 'feet';
  lastKickSpeed = 0;
  private kicker: Actor | null = null;
  private rng: Rng;
  private keeper: Actor | null = null;
  private kplan: KeeperPlan | null = null;
  private kErr = 0;
  /** penalty keeper's guess: -1 / +1 side, 0 = stays */
  private guess = 0;
  private guessPt = new Vector2();
  /** shoot-out: the player is the keeper (team 1); userGuess = (z, y) of his dive, null = stay */
  userKeeper = false;
  userGuess: Vector2 | null = null;
  private path: { t: number; p: Vector3 }[] = [];
  private passes = 0;
  private oneTouchPasses = 0;
  private hitPost = false;
  private crossZ = 0;
  private crossY = 0;
  private deflected = false;
  /** set when the result is decided but the ball keeps flying for the camera */
  private decided = false;

  constructor(public level: LevelDef, seed = 1) {
    this.rng = new Rng(seed * 7919 + level.id * 31);
    let id = 0;
    const mk = (team: 0 | 1, role: Role, at: Vector3, name: string, number: number): Actor => ({
      id: id++, team, role, name, number, pos: at.clone(), vel: new Vector3(), face: new Vector3(1, 0, 0), start: at.clone(),
      runs: [], runDelay: [], path: null, pathDelay: 0, goal: null, speed: 7.2, reach: 0.85, zone: 7, react: 0.28,
      kickT: -1, kickKind: 'shot', jump: 0, jumpV: 0, dive: 0, diveUp: 0, celebrate: false, sad: false, beaten: false,
    });
    level.mates.forEach((m, i) => {
      const a = mk(0, 'mate', W(m.at[0], m.at[1]), m.name ?? MATE_NAMES[i % MATE_NAMES.length], m.n ?? [10, 9, 7, 11, 8, 6][i % 6]);
      a.runs = (m.runs ?? (m.run ? [m.run] : [])).map((r) => r.map(([d, z]) => W(d, z)));
      a.runDelay = m.delay ?? [];
      a.speed = m.speed ?? 7.6;
      this.actors.push(a);
    });
    this.holder = this.actors[0];
    const bpos = level.ball ? W(level.ball[0], level.ball[1]) : this.holder.pos.clone();
    this.ball.place(bpos.x, bpos.z);
    // the holder stands just behind the ball, facing the goal
    this.standBehind(this.holder, this.goalCentre());

    for (const [i, o] of level.opps.entries()) {
      const a = mk(1, 'def', W(o.at[0], o.at[1]), OPP_NAMES[i % OPP_NAMES.length], [4, 5, 3, 2, 6, 8][i % 6]);
      a.speed = o.speed ?? 5.9;
      a.reach = o.reach ?? 0.8;
      a.zone = o.zone ?? 6;
      a.react = o.react ?? 0.36;
      this.actors.push(a);
    }
    if (level.wall) {
      // free-kick wall 9.15 m from the ball, covering the near-post side
      const b = this.ball.pos;
      const near = new Vector3(GOAL_X, 0, Math.sign(b.z || 1) * (HW - 0.6));
      const dir = tmp.copy(near).sub(b).setY(0).normalize();
      const side = new Vector3(-dir.z, 0, dir.x);
      const n = level.wall;
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 0.62 - Math.sign(b.z || 1) * 0.35 * side.z * 0;
        const p = b.clone().addScaledVector(dir, 9.15).addScaledVector(side, off);
        p.y = 0;
        const a = mk(1, 'wall', p, OPP_NAMES[(i + 3) % OPP_NAMES.length], [4, 5, 3, 2, 6][i % 5]);
        a.face.copy(dir).negate();
        this.actors.push(a);
      }
    }
    const gk = mk(1, 'gk', new Vector3(GOAL_X - 0.6, 0, 0), 'Кипер', 1);
    gk.face.set(-1, 0, 0);
    this.actors.push(gk);
    this.keeper = gk;
    this.placeKeeper();
    for (const a of this.actors) if (a.team === 1 && a.role === 'def') a.face.copy(tmp.copy(this.ball.pos).sub(a.pos).setY(0).normalize());
  }

  /** Deep copy (for the pass-danger preview: play the pass out on a copy). */
  clone(): Moment {
    const c = Object.create(Moment.prototype) as Moment;
    Object.assign(c, this);
    c.ball = new Ball(FIELD);
    c.ball.copyFrom(this.ball);
    c.ball.held = this.ball.held;
    c.ball.inGoal = this.ball.inGoal;
    const map = new Map<Actor, Actor>();
    c.actors = this.actors.map((a) => {
      const b: Actor = { ...a, pos: a.pos.clone(), vel: a.vel.clone(), face: a.face.clone(), start: a.start.clone(), path: a.path ? a.path.map((p) => p.clone()) : null, goal: a.goal ? a.goal.clone() : null };
      map.set(a, b);
      return b;
    });
    const re = (a: Actor | null) => (a ? map.get(a) ?? null : null);
    c.holder = re(this.holder);
    c.receiver = re(this.receiver);
    c.kicker = re(this.kicker);
    c.keeper = re(this.keeper);
    c.rng = Object.assign(Object.create(Object.getPrototypeOf(this.rng)), this.rng);
    c.events = [];
    c.path = this.path.slice();
    c.kplan = this.kplan ? { ...this.kplan } : null;
    c.guessPt = this.guessPt.clone();
    c.lastKickFrom = this.lastKickFrom.clone();
    c.result = this.result;
    return c;
  }

  goalCentre() {
    return new Vector3(GOAL_X, 0, 0);
  }

  get gkSkill() {
    return this.level.gk ?? 0.5;
  }

  private standBehind(a: Actor, toward: Vector3) {
    const b = this.ball.pos;
    const dir = tmp.copy(toward).sub(b).setY(0);
    if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
    dir.normalize();
    a.face.copy(dir);
    a.pos.set(b.x - dir.x * 0.55, 0, b.z - dir.z * 0.55);
    a.vel.set(0, 0, 0);
  }

  /** keeper narrows the angle on the line ball → goal centre */
  private placeKeeper() {
    const k = this.keeper!;
    const b = this.ball.pos;
    const dx = GOAL_X - b.x;
    const dist = Math.hypot(dx, b.z);
    const out = this.level.kind === 'penalty' ? 0.05 : Math.max(0.4, Math.min(1.8, dist * 0.06));
    const zAim = Math.max(-2, Math.min(2, b.z * (dist < 16 ? 0.3 : 0.1)));
    const dirx = -dx, dirz = b.z - zAim;
    const l = Math.hypot(dirx, dirz) || 1;
    k.pos.set(GOAL_X + (dirx / l) * out, 0, zAim + (dirz / l) * out);
    k.face.set(dirx / l, 0, dirz / l);
    k.start.copy(k.pos);
  }

  // ------------------------------------------------------------------ actions

  /** Is the drawn ground target a pass that should go in the air (lane blocked or long)? */
  autoLob(target: Vector3) {
    const from = this.ball.pos;
    const d = Math.hypot(target.x - from.x, target.z - from.z);
    if (d > 34) return true;
    for (const a of this.actors) {
      if (a.team !== 1 || a.role === 'gk') continue;
      const s = segDist(a.pos, from, target);
      if (s.d < 1.15 && s.u > 0.06 && s.u < 0.98) return true;
    }
    return false;
  }

  /** The kick this action makes (no state change). */
  plan(action: Action): Kick {
    const from = this.ball.pos.clone();
    const tgt = action.target.clone();
    const touch = this.touch;
    if (action.type === 'shot') {
      const dist = Math.hypot(tgt.x - from.x, tgt.z - from.z);
      let speed = Math.min(31, 22.5 + dist * 0.2);
      let curl = action.curl;
      if (touch === 'header') {
        speed = Math.min(19, 13 + dist * 0.35);
        curl *= 0.25;
      } else if (touch === 'volley') {
        speed = Math.min(30, 24 + dist * 0.15);
        curl *= 0.6;
      }
      // a curler is struck a bit softer (wraps the foot round it)
      speed *= 1 - Math.abs(curl) * 0.1;
      // spin.y < 0 bends the ball to the right of its travel (curl > 0)
      const side = -curl * 42;
      const top = tgt.y > 1.7 ? 6 : 0;
      tgt.y = Math.max(BALL.radius, tgt.y);
      return solveThrough(FIELD, from, tgt, speed, side, top, { x: 1, z: 0 });
    }
    // the team-mate who will run onto it, and when he can be there (weights the pass for him)
    const d = Math.hypot(tgt.x - from.x, tgt.z - from.z);
    const rcv = this.pickReceiver(tgt, action.type === 'lob');
    const eta = rcv ? Math.hypot(tgt.x - rcv.pos.x, tgt.z - rcv.pos.z) / rcv.speed + 0.3 : 0;
    if (action.type === 'lob') {
      // into the box at a team-mate: aim at his head / chest for a first-time finish
      const inBox = GOAL_X - tgt.x < 14 && Math.abs(tgt.z) < 13;
      tgt.y = rcv && inBox ? 1.45 : BALL.radius;
      const side = -action.curl * 22;
      // the flatter the quicker; loft it more when the runner needs time
      // the flattest lob that clears the defenders on the way and gives the runner time
      let best: Kick | null = null;
      for (const pitch of [0.42, 0.55, 0.7, 0.85, 1.0]) {
        if (d < 12 && pitch < 0.7) continue;
        const k = solveLofted(FIELD, from, tgt, pitch, side, 10);
        best = k;
        const vh = Math.hypot(k.vel.x, k.vel.z);
        const tFly = d / Math.max(1, vh * 0.85);
        if (tFly >= eta - 0.1 && this.clears(from, k, tgt)) break;
      }
      return best!;
    }
    // ground pass: firm — it still arrives with pace (a pass into feet, not a roll);
    // into space it is weighted so the runner gets there together with the ball
    let arrive = Math.min(13, 8 + d * 0.15);
    if (rcv && eta > 0) {
      while (arrive > 5.5 && rollTime(groundSpeed(d, arrive), d) < eta) arrive -= 0.5;
    }
    const k = solveGround(from, tgt, arrive);
    if (touch !== 'feet') k.vel.y = Math.max(k.vel.y, 0.5);
    return k;
  }

  /** does a lofted ball fly over every opponent between the kicker and the target? */
  private clears(from: Vector3, k: Kick, tgt: Vector3) {
    const b = new Ball(FIELD, true);
    b.place(from.x, from.z, from.y);
    b.vel.copy(k.vel);
    b.spin.copy(k.spin);
    const opps = this.actors.filter((a) => a.team === 1 && a.role !== 'gk');
    for (let t = 0; t < 4; t += SIM_DT * 2) {
      b.step(SIM_DT * 2);
      if (Math.hypot(b.pos.x - tgt.x, b.pos.z - tgt.z) < 1.5) return true;
      for (const o of opps) if (Math.hypot(b.pos.x - o.pos.x, b.pos.z - o.pos.z) < 1.1 && b.pos.y < 2.6) return false;
    }
    return true;
  }

  /** Sampled future ball path for the preview (no players), stops after the goal line. */
  preview(action: Action, dur = 3): Vector3[] {
    const k = this.plan(action);
    const b = new Ball(FIELD);
    b.place(this.ball.pos.x, this.ball.pos.z, this.ball.pos.y);
    b.vel.copy(k.vel);
    b.spin.copy(k.spin);
    const out: Vector3[] = [b.pos.clone()];
    let t = 0;
    let after = -1;
    while (t < dur) {
      for (let i = 0; i < 4; i++) b.step(SIM_DT);
      t += SIM_DT * 4;
      out.push(b.pos.clone());
      if (after < 0 && (b.inGoal || b.pos.x > GOAL_X + 0.2)) after = t;
      if (after >= 0 && t - after > 0.15) break;
      if (b.vel.lengthSq() < 0.5) break;
      if (action.type !== 'shot' && Math.hypot(b.pos.x - action.target.x, b.pos.z - action.target.z) < 0.4 && b.pos.y < 2) break;
    }
    return out;
  }

  /** Take the action (the kick happens after a short wind-up). */
  act(action: Action) {
    if (this.phase !== 'aim' || !this.holder) return;
    const kick = this.plan(action);
    this.pending = { action, kick };
    this.phase = 'windup';
    this.windT = this.touch === 'feet' ? 0.2 : 0.12;
    const h = this.holder;
    const dir = tmp.set(kick.vel.x, 0, kick.vel.z);
    if (this.touch === 'feet') {
      if (dir.lengthSq() > 1e-4) {
        dir.normalize();
        h.face.copy(dir);
        h.pos.set(this.ball.pos.x - dir.x * 0.55, 0, this.ball.pos.z - dir.z * 0.55);
      }
    } else if (dir.lengthSq() > 1e-4) h.face.copy(dir.normalize());
    h.kickT = 0;
    h.kickKind = this.touch === 'header' ? 'header' : this.touch === 'volley' ? 'volley' : action.type === 'shot' ? 'shot' : action.type === 'lob' ? 'lob' : 'pass';
    if (this.touch === 'header') {
      h.jumpV = 3.2;
      h.jump = 0.001;
    }
  }

  private launch() {
    const { action, kick } = this.pending!;
    this.pending = null;
    const h = this.holder!;
    this.ball.held = false;
    this.ball.vel.copy(kick.vel);
    this.ball.spin.copy(kick.spin);
    this.lastAction = action;
    this.lastKickFrom.copy(this.ball.pos);
    this.lastKickTouch = this.touch;
    this.lastKickSpeed = kick.vel.length();
    if (action.type !== 'shot' && this.touch !== 'feet') this.oneTouchPasses++;
    this.kicker = h;
    this.events.push({ type: 'kick', pos: this.ball.pos.clone(), strength: kick.vel.length(), actor: h.id, text: action.type });
    this.holder = null;
    this.phase = 'fly';
    this.flyT = 0;
    this.deflected = false;
    this.path = this.predict(3.5);
    // team-mates start this kick's runs
    for (const a of this.actors) {
      if (a.team !== 0) continue;
      const r = a.runs[this.kicks];
      if (r && r.length) {
        a.path = r.map((p) => p.clone());
        a.pathDelay = a.runDelay[this.kicks] ?? 0;
      } else a.path = null;
      a.goal = null;
    }
    this.receiver = action.type === 'shot' ? null : this.pickReceiver(action.target, action.type === 'lob');
    if (this.receiver) {
      this.receiver.path = null;
      this.receiver.goal = this.meetPoint(this.receiver);
    }
    // defenders and keeper react after their reaction time
    for (const a of this.actors) {
      if (a.team !== 1) continue;
      a.react = a.role === 'gk' ? 0.2 + (1 - this.gkSkill) * 0.2 + this.rng.range(0, 0.05) : (this.level.opps[a.id - this.level.mates.length]?.react ?? 0.36) + this.rng.range(0, 0.06);
      a.goal = null;
      if (a.role === 'wall' && action.type === 'shot') {
        a.jumpV = 4.2;
        a.jump = 0.001;
        this.events.push({ type: 'jump', actor: a.id });
      }
    }
    this.kplan = null;
    this.kErr = this.rng.gauss() * (1 - this.gkSkill) * 0.45;
    if (this.level.kind === 'penalty' && this.userKeeper) {
      // the player is the keeper: he dives where the player drew (or stays and reads it)
      const g = this.userGuess;
      this.guess = g ? Math.sign(g.x) || 1 : 0;
      if (g) this.guessPt.copy(g);
      // no dive drawn: he just stands there
      if (this.keeper) this.keeper.react = g ? 0.04 : 99;
    } else if (this.level.kind === 'penalty') {
      // reads the run-up: right side with a chance growing with skill
      const side = Math.sign(kick.vel.z) || 1;
      const r = this.rng.next();
      this.guess = r < 0.25 + this.gkSkill * 0.3 ? side : r < 0.85 ? -side : 0;
      if (this.guess !== 0 && this.keeper) this.keeper.react = 0.04;
      this.guessPt.set(this.guess * this.rng.range(1.5, 2.8), this.rng.range(0.4, 1.9));
    }
    this.kicks++;
  }

  /** Mate who will run onto the ball at `target`. */
  pickReceiver(target: Vector3, lofted: boolean): Actor | null {
    let best: Actor | null = null;
    let bestD = lofted ? 9 : 7;
    for (const a of this.actors) {
      if (a.team !== 0 || a === this.holder || a === this.kicker) continue;
      // where he will be by then (his run end if he has a run for the next kick)
      const run = a.runs[this.kicks];
      const ref = run && run.length ? run[run.length - 1] : a.pos;
      const d = Math.min(Math.hypot(a.pos.x - target.x, a.pos.z - target.z), Math.hypot(ref.x - target.x, ref.z - target.z));
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  /** Where on the predicted ball path the receiver should meet it: the drawn target if he can get there in time. */
  private meetPoint(a: Actor): Vector3 {
    const tgt = this.lastAction!.target;
    // time the ball needs to reach the target (closest approach on the path)
    let tBall = Infinity, best = Infinity;
    for (const s of this.path) {
      const d = Math.hypot(s.p.x - tgt.x, s.p.z - tgt.z);
      if (d < best) {
        best = d;
        tBall = s.t;
      }
    }
    const dRun = Math.hypot(tgt.x - a.pos.x, tgt.z - a.pos.z);
    if (best < 2 && dRun - 0.8 <= a.speed * (tBall - this.flyT + 0.15)) return new Vector3(tgt.x, 0, tgt.z);
    // otherwise the earliest point of the path he can still reach
    for (const s of this.path) {
      if (s.t < this.flyT + 0.15) continue;
      const d = Math.hypot(s.p.x - a.pos.x, s.p.z - a.pos.z);
      if (s.p.y < 2.3 && d - 0.6 <= a.speed * Math.max(0, s.t - this.flyT - 0.1)) return new Vector3(s.p.x, 0, s.p.z);
    }
    return new Vector3(tgt.x, 0, tgt.z);
  }

  private predict(dur: number) {
    const b = new Ball(FIELD);
    b.copyFrom(this.ball);
    b.held = false;
    const out: { t: number; p: Vector3 }[] = [];
    let t = 0;
    let next = 0;
    while (t <= dur) {
      if (t >= next) {
        out.push({ t: t + this.flyT, p: b.pos.clone() });
        next += 0.04;
      }
      b.step(SIM_DT);
      t += SIM_DT;
      if (b.inGoal) break;
    }
    return out;
  }

  // ------------------------------------------------------------------ stepping

  step(dt = SIM_DT) {
    this.t += dt;
    for (const a of this.actors) this.animate(a, dt);
    if (this.phase === 'aim') return;
    if (this.phase === 'windup') {
      this.windT -= dt;
      if (this.windT <= 0) this.launch();
      return;
    }
    if (this.phase === 'over') {
      this.overT += dt;
      this.ballStep(dt);
      for (const a of this.actors) this.moveActor(a, dt);
      if (this.keeper) this.keeperStep(this.keeper, dt);
      return;
    }
    // fly
    this.flyT += dt;
    this.ballStep(dt);
    for (const a of this.actors) {
      if (a.role === 'gk') this.keeperStep(a, dt);
      else if (a.team === 1) this.defenderStep(a, dt);
      else this.mateStep(a, dt);
      this.moveActor(a, dt);
    }
    if (this.phase !== 'fly') return;
    this.checkContacts();
    if (this.phase !== 'fly') return;
    this.checkOutcome();
  }

  private ballStep(dt: number) {
    if (this.ball.held) return;
    const wasIn = this.ball.inGoal;
    this.ball.step(dt);
    for (const e of this.ball.events) {
      if (e.type === 'post') {
        this.hitPost = true;
        this.events.push({ type: 'post', pos: e.pos, strength: e.strength });
      } else this.events.push({ type: e.type, pos: e.pos, strength: e.strength });
    }
    this.ball.events.length = 0;
    if (!wasIn && this.ball.inGoal === 1 && !this.decided && !this.deflected) {
      this.crossZ = this.ball.pos.z;
      this.crossY = this.ball.pos.y;
      this.finish(true, 'ГОЛ!');
      this.events.push({ type: 'goal', pos: this.ball.pos.clone() });
      for (const a of this.actors) {
        if (a.team === 0) a.celebrate = true;
        else a.sad = true;
      }
    }
  }

  private animate(a: Actor, dt: number) {
    if (a.kickT >= 0) {
      a.kickT += dt;
      if (a.kickT > 0.6) a.kickT = -1;
    }
    if (a.jump > 0 || a.jumpV > 0) {
      a.jump += a.jumpV * dt;
      a.jumpV -= 9.81 * dt;
      if (a.jump <= 0) {
        a.jump = 0;
        a.jumpV = 0;
      }
    }
  }

  private moveActor(a: Actor, dt: number) {
    if (a.role === 'gk') return;
    let goal: Vector3 | null = a.goal;
    if (!goal && a.path) {
      if (a.pathDelay > 0) a.pathDelay -= dt;
      else {
        while (a.path.length && Math.hypot(a.path[0].x - a.pos.x, a.path[0].z - a.pos.z) < 0.4) a.path.shift();
        goal = a.path[0] ?? null;
        if (!a.path.length) a.path = null;
      }
    }
    const want = tmp.set(0, 0, 0);
    if (goal) {
      want.set(goal.x - a.pos.x, 0, goal.z - a.pos.z);
      const d = want.length();
      if (d > 0.05) want.multiplyScalar(Math.min(a.speed, d * 4) / d);
      else want.set(0, 0, 0);
    }
    // accelerate towards the wanted velocity
    const acc = 14 * dt;
    tmp2.copy(want).sub(a.vel).setY(0);
    const dl = tmp2.length();
    if (dl > acc) tmp2.multiplyScalar(acc / dl);
    a.vel.add(tmp2);
    a.pos.addScaledVector(a.vel, dt);
    a.pos.y = a.jump;
    const sp = Math.hypot(a.vel.x, a.vel.z);
    if (sp > 0.8) a.face.lerp(tmp2.set(a.vel.x / sp, 0, a.vel.z / sp), Math.min(1, dt * 10)).normalize();
    else if (this.phase !== 'over') a.face.lerp(tmp2.copy(this.ball.pos).sub(a.pos).setY(0).normalize(), Math.min(1, dt * 5)).normalize();
    // keep everyone on the pitch (and out of the net)
    a.pos.x = Math.min(GOAL_X - 0.3, a.pos.x);
    a.pos.z = Math.max(-FIELD.width / 2, Math.min(FIELD.width / 2, a.pos.z));
  }

  private mateStep(a: Actor, _dt: number) {
    if (a === this.receiver && this.lastAction && this.lastAction.type !== 'shot') {
      // track the ball onto the meeting point; refine late in the flight
      if (this.flyT > 0.25 && Math.floor(this.flyT * 10) !== Math.floor((this.flyT - SIM_DT) * 10)) {
        this.path = this.predict(3);
        const m = this.meetPoint(a);
        a.goal = m;
      }
    }
  }

  private defenderStep(a: Actor, _dt: number) {
    if (a.role === 'wall') return;
    if (this.flyT < a.react) return;
    // replan a few times a second: earliest point on the ball path he can reach inside his zone
    if (!a.goal || Math.floor(this.flyT * 8) !== Math.floor((this.flyT - SIM_DT) * 8)) {
      const path = this.predict(2.5);
      let best: Vector3 | null = null;
      for (const s of path) {
        const rel = s.t - this.flyT;
        if (rel < 0.05) continue;
        if (s.p.y > 2.2) continue;
        const d = Math.hypot(s.p.x - a.pos.x, s.p.z - a.pos.z);
        const fromStart = Math.hypot(s.p.x - a.start.x, s.p.z - a.start.z);
        if (fromStart > a.zone) continue;
        if (d - a.reach <= a.speed * Math.max(0, rel - 0.12)) {
          best = s.p;
          break;
        }
      }
      if (best) a.goal = new Vector3(best.x, 0, best.z);
      else {
        // can't get there: close down the receiver / the ball's end, within the zone
        const end = this.receiver?.goal ?? path[path.length - 1].p;
        const v = tmp.set(end.x - a.start.x, 0, end.z - a.start.z);
        const l = v.length();
        if (l > a.zone) v.multiplyScalar(a.zone / l);
        // mark goal-side of it
        a.goal = new Vector3(a.start.x + v.x + 0.8, 0, a.start.z + v.z);
      }
    }
  }

  private keeperStep(k: Actor, dt: number) {
    const b = this.ball;
    if (this.phase === 'over') {
      // finish the dive, then lie there
      if (k.dive !== 0) {
        const s = Math.sign(k.dive);
        k.dive = s * Math.min(1, Math.abs(k.dive) + dt * 3);
      }
      return;
    }
    if (this.flyT < k.react) return;
    const toGoal = b.vel.x > 2 && b.pos.x < GOAL_X + 0.5 && (this.lastAction?.type === 'shot' || this.deflected);
    if (!toGoal) {
      this.claimStep(k, dt);
      return;
    }
    const xk = k.pos.x;
    // the keeper's read: early on he extrapolates the flight without spin (a curler fools him),
    // the closer the ball gets the more he sees where it really goes
    if (!this.kplan || Math.floor(this.flyT * 12) !== Math.floor((this.flyT - SIM_DT) * 12)) {
      const tc = (xk - b.pos.x) / Math.max(1, b.vel.x);
      if (tc > 0) {
        // naive: gravity + drag only
        const vx = b.vel.x, vy = b.vel.y, vz = b.vel.z;
        const sp = b.vel.length();
        const drag = 1 / (1 + BALL.dragK * sp * tc);
        let zN = b.pos.z + vz * tc * drag;
        let yN = b.pos.y + vy * tc * drag - 4.9 * tc * tc;
        void vx;
        // true crossing
        const path = this.predict(Math.min(2.5, tc + 0.3));
        let zT = zN, yT = yN;
        for (let i = 1; i < path.length; i++) {
          if (path[i].p.x >= xk) {
            zT = path[i].p.z;
            yT = path[i].p.y;
            break;
          }
        }
        const total = this.flyT + tc;
        // long flights give him time to read the curl too
        const seen = Math.min(1, Math.pow(this.flyT / Math.max(0.2, total), 1.3) * (0.8 + this.gkSkill * 0.6) + Math.max(0, total - 0.95) * 0.6);
        zN += (zT - zN) * seen;
        yN += (yT - yN) * seen;
        // a slightly imperfect read that sharpens as the ball comes
        const prev = this.kplan;
        if (prev?.dived) {
          // committed: the dive direction is locked, only the height adjusts a bit
          prev.y += (Math.max(0.2, yN) - prev.y) * 0.3;
        } else this.kplan = { t0: this.flyT, cross: total, z: zN + this.kErr * (1 - seen), y: Math.max(0.2, yN), dived: false };
      }
    }
    const p = this.kplan;
    if (!p) return;
    const left = p.cross - this.flyT;
    // penalties: he guesses a side at the kick (right or wrong) and goes early
    if (this.level.kind === 'penalty' && !p.dived && this.guess !== 0) {
      p.dived = true;
      p.z = this.guessPt.x;
      p.y = this.guessPt.y;
      this.events.push({ type: 'dive', actor: k.id });
    }
    const dz = p.z - k.pos.z;
    // ball heading wide: no need to dive (but watch it)
    if (Math.abs(p.z) > HW + 0.6 && !p.dived) {
      k.pos.z += Math.max(-dt * 2, Math.min(dt * 2, dz));
      return;
    }
    if (!p.dived && Math.abs(dz) > 0.45 && left < 0.5) {
      p.dived = true;
      this.events.push({ type: 'dive', actor: k.id });
    }
    // feet shuffle across; the dive itself is the stretch (see keeperSave)
    // the dive is the commitment: no more shuffling once he has left his feet
    if (!p.dived) {
      const step = (2.6 + this.gkSkill * 1.6) * dt;
      k.pos.z += Math.max(-step, Math.min(step, dz));
    }
    k.diveUp = Math.max(0, Math.min(1, (p.y - 0.6) / 1.4));
    if (p.dived) {
      const s = k.dive !== 0 ? Math.sign(k.dive) : Math.sign(dz || 1);
      k.dive = s * Math.min(1, Math.abs(k.dive) + dt * (2.2 + this.gkSkill * 1.2));
    } else if (left < 0.4 && k.diveUp > 0.6 && k.jump === 0 && k.jumpV === 0) {
      k.jumpV = 3.4;
      k.jump = 0.001;
    }
  }

  /** passes / crosses into his area: the keeper comes out and claims the ball if he gets there first */
  private claimStep(k: Actor, dt: number): boolean {
    if (!k.goal || Math.floor(this.flyT * 8) !== Math.floor((this.flyT - SIM_DT) * 8)) {
      k.goal = null;
      for (const s of this.predict(2.5)) {
        if (s.t - this.flyT < 0.1) continue;
        const inArea = GOAL_X - s.p.x < 5.8 && Math.abs(s.p.z) < FIELD.smallBoxHalfW + 1 && s.p.y < 2.6;
        if (!inArea) continue;
        const d = Math.hypot(s.p.x - k.pos.x, s.p.z - k.pos.z);
        if (d - 1 <= 6.2 * (s.t - Math.max(this.flyT, k.react))) {
          k.goal = new Vector3(s.p.x, 0, s.p.z);
          break;
        }
      }
    }
    if (!k.goal) {
      const tz = Math.max(-HW + 0.5, Math.min(HW - 0.5, this.ball.pos.z * 0.4));
      k.pos.z += Math.max(-dt * 3, Math.min(dt * 3, tz - k.pos.z));
      return true;
    }
    const v = tmp.set(k.goal.x - k.pos.x, 0, k.goal.z - k.pos.z);
    const l = v.length();
    if (l > 0.05) k.pos.addScaledVector(v, Math.min(l, 6.2 * dt) / l);
    k.face.set(-1, 0, 0);
    return true;
  }

  // ------------------------------------------------------------------ contacts / outcome

  private checkContacts() {
    const b = this.ball.pos;
    const bv = this.ball.vel;
    const speed = bv.length();
    for (const a of this.actors) {
      if (a === this.kicker && this.flyT < 0.35) continue;
      const dh = Math.hypot(b.x - a.pos.x, b.z - a.pos.z);
      if (a.team === 0) {
        if (this.flyT < 0.15 || this.deflected) continue;
        const shot = this.lastAction?.type === 'shot';
        // shots fly past team-mates unless it is the receiver of a pass
        if (shot && a !== this.receiver) continue;
        const reach = a === this.receiver ? 1.05 : 0.8;
        if (dh < reach && b.y < 2.35 + a.jump && speed < 34) {
          this.receive(a);
          return;
        }
        continue;
      }
      if (a.role === 'gk') {
        if (this.keeperSave(a)) return;
        continue;
      }
      // field opponents: body block (wall too), feet and head reach
      const top = 1.85 + a.jump;
      const body = dh < 0.32 + BALL.radius && b.y < top;
      const feet = a.role === 'def' && this.flyT > a.react && dh < a.reach && b.y < 0.95;
      const head = a.role === 'def' && this.flyT > a.react && dh < 0.55 && b.y >= 0.95 && b.y < top + 0.45;
      if (body || feet || head) {
        this.deflect(a, a.role === 'wall' ? 'block' : 'intercept');
        return;
      }
    }
  }

  private keeperSave(k: Actor): boolean {
    const b = this.ball.pos;
    if (b.x < k.pos.x - 0.6 || b.x > k.pos.x + 0.6) return false;
    if (this.flyT < 0.1) return false;
    // keeper body point: lifted and stretched sideways when diving
    const s = Math.sign(k.dive || 0);
    const ad = Math.abs(k.dive);
    let cz = k.pos.z + s * ad * 0.85;
    // standing he jumps / crouches to the read height, diving he flies up or down
    let cy = 1.0 + k.jump + (k.diveUp - 0.45) * Math.max(ad * 1.1, k.diveUp > 0.6 ? 0.9 : 0.5);
    let rz = 0.45 + ad * 0.55 + this.gkSkill * 0.15; // arms out
    let ry = 1.15;
    if (this.level.kind === 'penalty' && this.guess !== 0) {
      // penalty: he flies at the spot he guessed (side and height), not where the ball goes
      cz = this.guessPt.x * ad;
      cy = 1.0 + (this.guessPt.y - 1.0) * ad;
      rz = 0.55 + ad * 0.45 + this.gkSkill * 0.1;
      ry = 0.75 + this.gkSkill * 0.15;
    }
    const ez = (b.z - cz) / rz;
    const ey = (b.y - cy) / ry;
    if (ez * ez + ey * ey > 1) return false;
    if (Math.abs(b.x - k.pos.x) > 0.45) return false;
    const speed = this.ball.vel.length();
    // a soft ball at the body is caught, anything else parried
    if (speed < 15 && ad < 0.5) {
      this.ball.vel.set(0, 0, 0);
      this.ball.spin.set(0, 0, 0);
      this.ball.held = true;
      this.events.push({ type: 'catch', pos: b.clone(), actor: k.id });
      this.finish(false, 'Вратарь поймал!');
    } else {
      const v = this.ball.vel;
      v.x = -Math.abs(v.x) * 0.25 - 2;
      v.y = Math.abs(v.y) * 0.3 + 3;
      v.z = v.z * 0.3 + (b.z - cz >= 0 ? 1 : -1) * 4;
      this.ball.spin.multiplyScalar(0.2);
      this.events.push({ type: 'save', pos: b.clone(), actor: k.id, strength: speed });
      this.finish(false, 'Сейв!');
    }
    this.deflected = true;
    return true;
  }

  private deflect(a: Actor, kind: 'block' | 'intercept') {
    const v = this.ball.vel;
    const sp = v.length();
    const n = tmp.set(this.ball.pos.x - a.pos.x, 0, this.ball.pos.z - a.pos.z);
    if (n.lengthSq() < 1e-4) n.set(-1, 0, 0);
    n.normalize();
    v.set(n.x * (2 + sp * 0.3), 1.5 + sp * 0.12, n.z * (2 + sp * 0.3));
    v.x -= 3;
    this.ball.spin.set(0, 0, 0);
    this.deflected = true;
    a.kickT = 0;
    a.kickKind = this.ball.pos.y > 1.2 ? 'header' : 'pass';
    this.events.push({ type: kind, pos: this.ball.pos.clone(), actor: a.id, strength: sp });
    this.finish(false, kind === 'block' ? 'В стенку!' : 'Перехват!');
  }

  private receive(a: Actor) {
    const b = this.ball;
    const y = b.pos.y;
    this.passes += this.lastAction && this.lastAction.type !== 'shot' ? 1 : 0;
    this.holder = a;
    this.receiver = null;
    this.kicker = null;
    a.goal = null;
    a.path = null;
    a.vel.set(0, 0, 0);
    for (const o of this.actors) {
      // everyone else stops where they are (the moment freezes)
      o.vel.set(0, 0, 0);
      o.goal = null;
    }
    if (y < 0.7) {
      this.touch = 'feet';
      b.place(b.pos.x, b.pos.z);
      this.standBehind(a, this.goalCentre());
      this.events.push({ type: 'receive', pos: b.pos.clone(), actor: a.id });
    } else {
      this.touch = y > 1.35 ? 'header' : 'volley';
      b.vel.set(0, 0, 0);
      b.spin.set(0, 0, 0);
      b.held = true;
      // he is right under the ball
      const f = tmp.set(GOAL_X - b.pos.x, 0, -b.pos.z).normalize();
      a.face.copy(f);
      const off = this.touch === 'header' ? 0.15 : 0.45;
      a.pos.set(b.pos.x - f.x * off, 0, b.pos.z - f.z * off);
      this.events.push({ type: 'freeze', pos: b.pos.clone(), actor: a.id, text: this.touch });
    }
    this.phase = 'aim';
    this.placeKeeperFrom();
  }

  /** after a pass the keeper resets his position to the new ball */
  private placeKeeperFrom() {
    const k = this.keeper!;
    k.dive = 0;
    k.diveUp = 0;
    this.kplan = null;
    this.placeKeeper();
  }

  private checkOutcome() {
    const b = this.ball;
    if (this.decided) return;
    if (b.pos.x > GOAL_X + 0.3 && !b.inGoal) {
      this.finish(false, this.hitPost ? 'От штанги — мимо!' : this.lastAction?.type === 'shot' ? 'Мимо!' : 'Мяч ушёл за линию');
      this.events.push({ type: 'miss', pos: b.pos.clone() });
      return;
    }
    if (Math.abs(b.pos.z) > FIELD.width / 2 || b.pos.x < -GOAL_X) {
      this.finish(false, 'Аут!');
      this.events.push({ type: 'miss', pos: b.pos.clone() });
      return;
    }
    if (this.flyT > 0.4 && b.vel.lengthSq() < 0.8 && b.onGround) {
      this.finish(false, 'Мяч потерян');
      this.events.push({ type: 'lost', pos: b.pos.clone() });
      return;
    }
    if (this.flyT > 7) this.finish(false, 'Мяч потерян');
  }

  private finish(ok: boolean, reason: string) {
    if (this.decided) return;
    this.decided = true;
    this.phase = 'over';
    this.overT = 0;
    const bonuses: Bonus[] = [];
    let pts = 0;
    if (ok) {
      bonuses.push({ label: 'Гол', pts: 500 });
      const a = this.lastAction!;
      const from = this.lastKickFrom;
      const dist = Math.hypot(GOAL_X - from.x, from.z - this.crossZ);
      if (this.lastKickTouch === 'header') bonuses.push({ label: 'Головой', pts: 300 });
      else if (this.lastKickTouch === 'volley') bonuses.push({ label: 'С лёта', pts: 350 });
      if (Math.abs(a.curl) >= 0.4 && this.lastKickTouch !== 'header') bonuses.push({ label: 'Кручёный', pts: Math.round(150 + Math.abs(a.curl) * 150) });
      const corner = Math.abs(this.crossZ) > HW - 1.1;
      if (corner && this.crossY > 1.55) bonuses.push({ label: 'В девятку', pts: 300 });
      else if (corner) bonuses.push({ label: 'В угол', pts: 150 });
      if (dist > 28) bonuses.push({ label: 'Издалека!', pts: 400 });
      else if (dist > 20) bonuses.push({ label: 'Издали', pts: 200 });
      if (this.hitPost) bonuses.push({ label: 'От штанги', pts: 200 });
      if (this.passes > 0) bonuses.push({ label: `Пасы ×${this.passes}`, pts: this.passes * 100 });
      if (this.oneTouchPasses > 0) bonuses.push({ label: 'В одно касание', pts: this.oneTouchPasses * 150 });
      if (this.lastKickSpeed > 29 && this.lastKickTouch === 'feet') bonuses.push({ label: 'Пушка', pts: 100 });
      pts = bonuses.reduce((s, b) => s + b.pts, 0);
    }
    const [s2, s3] = this.level.stars;
    const stars = !ok ? 0 : pts >= s3 ? 3 : pts >= s2 ? 2 : 1;
    this.result = { ok, reason, points: pts, bonuses, stars };
  }

  /** bounds of the goal-plane target region the input may aim into (incl. a miss margin) */
  static goalRect() {
    return { zMin: -HW - 2.5, zMax: HW + 2.5, yMax: GH + 2 };
  }
}

function segDist(p: Vector3, a: Vector3, b: Vector3) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const l2 = abx * abx + abz * abz || 1;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2));
  const cx = a.x + abx * u, cz = a.z + abz * u;
  return { d: Math.hypot(p.x - cx, p.z - cz), u };
}

export const MATE_NAMES = ['Бролдо', 'Месси-бро', 'Пеле-бот', 'Зидан-2000', 'Креш', 'Тестов', 'Манекенко', 'Болтов'];
export const OPP_NAMES = ['Стенкин', 'Бетонов', 'Заборов', 'Шкафов', 'Кирпичёв', 'Танков', 'Дубов', 'Гвоздев'];
