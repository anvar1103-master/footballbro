import { Vector3 } from 'three';
import { PLAYER } from './config';

export type Role = 'GK' | 'DEF' | 'MID' | 'FWD';

export type Action =
  | 'none'
  | 'kick' // wind-up then ball strike
  | 'tackle' // standing tackle poke
  | 'slide' // slide tackle lunge
  | 'fallen' // knocked down
  | 'dive' // goalkeeper dive
  | 'throw' // throw-in / GK throw
  | 'header' // jumping header
  | 'skill' // feint / sidestep with the ball
  | 'celebrate';

export type KickKind = 'shot' | 'finesse' | 'pass' | 'through' | 'lob' | 'cross' | 'clear' | 'throwin' | 'punt' | 'header' | 'chip';

export interface KickOrder {
  kind: KickKind;
  /** world target (goal-plane point for shots, ground point for passes) */
  target: Vector3;
  power: number;
  receiverId: number;
  /** sideSpin sign for finesse */
  curl: number;
}

export interface PlayerStats {
  pace: number;
  shot: number;
  pass: number;
  dribble: number;
  tackle: number;
  gk: number;
}

export class Player {
  pos = new Vector3();
  vel = new Vector3();
  face = new Vector3(1, 0, 0);
  /** velocity the brain (AI / human) wants */
  desired = new Vector3();
  sprint = false;
  action: Action = 'none';
  actionT = 0;
  actionDur = 0;
  /** dive / slide direction & GK dive target */
  actionDir = new Vector3();
  actionTarget = new Vector3();
  kick: KickOrder | null = null;
  kickFired = false;
  /** GK dive: will this dive save? */
  diveSaves = false;
  diveHeight = 0;
  /** has ball in hands (GK / throw-in taker) */
  holding = false;
  holdT = 0;
  /** human charge timer (shot / pass power) */
  charge = 0;
  /** which button is being charged */
  chargeKind: 'shot' | 'finesse' | 'chip' | 'pass' | 'through' | 'lob' | null = null;
  /** 0..1, drains while sprinting */
  stamina = 1;
  /** containing (jockeying) the ball carrier: faces him, side-steps */
  jockey = false;
  // AI scratch
  thinkT = 0;
  receiving = false;
  runTarget: Vector3 | null = null;
  lastTackleT = -10;
  /** set-piece target spot */
  spot: Vector3 | null = null;
  /** celebration run target */
  celebrateTarget: Vector3 | null = null;

  constructor(
    public id: number,
    public team: number,
    public idx: number,
    public role: Role,
    public number: number,
    public name: string,
    /** base formation position: x in [0,1] own goal -> opponent goal, z in [-1,1] */
    public home: { x: number; z: number },
    public stats: PlayerStats,
    /** character model index for the renderer */
    public model: number,
  ) {}

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  get busy() {
    return this.action !== 'none' && this.action !== 'celebrate';
  }

  maxSpeed(withBall: boolean) {
    const tired = 0.78 + 0.22 * Math.min(1, this.stamina * 1.6);
    const base = this.sprint ? PLAYER.jogSpeed + (PLAYER.sprintSpeed - PLAYER.jogSpeed) * tired : PLAYER.jogSpeed;
    const pace = 0.88 + 0.2 * this.stats.pace;
    return base * pace * (withBall ? PLAYER.dribbleSpeedMul : 1) * (this.jockey ? 0.7 : 1);
  }

  setAction(a: Action, dur: number) {
    this.action = a;
    this.actionT = 0;
    this.actionDur = dur;
    this.kickFired = false;
  }

  /** Steering locomotion towards `desired` with acceleration limits. */
  move(dt: number, withBall: boolean) {
    const d = this.desired;
    let max = this.maxSpeed(withBall);
    if (this.action === 'kick' || this.action === 'tackle' || this.action === 'throw') max *= 0.35;
    if (this.action === 'fallen' || this.holding) max = this.holding && this.role === 'GK' ? 2.5 : 0;
    const dl = Math.hypot(d.x, d.z);
    let tx = d.x, tz = d.z;
    if (dl > max) {
      tx = (d.x / dl) * max;
      tz = (d.z / dl) * max;
    }
    // stamina: sprinting drains, jogging/standing recovers
    const sp = this.speed;
    if (this.sprint && sp > PLAYER.jogSpeed * 0.9) this.stamina = Math.max(0, this.stamina - 0.055 * dt);
    else this.stamina = Math.min(1, this.stamina + (sp < 2 ? 0.05 : 0.025) * dt);
    if (this.action === 'slide' || this.action === 'dive' || this.action === 'skill') return; // driven by action
    const dvx = tx - this.vel.x;
    const dvz = tz - this.vel.z;
    const dvl = Math.hypot(dvx, dvz);
    const speeding = tx * this.vel.x + tz * this.vel.z > 0 && Math.hypot(tx, tz) > this.speed;
    const acc = (speeding ? PLAYER.accel : PLAYER.decel) * (withBall ? 0.85 : 1) * dt;
    if (dvl <= acc) {
      this.vel.x = tx;
      this.vel.z = tz;
    } else {
      this.vel.x += (dvx / dvl) * acc;
      this.vel.z += (dvz / dvl) * acc;
    }
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
  }

  /** Rotate facing towards a direction with limited turn rate. */
  turnTowards(dx: number, dz: number, dt: number, rate = PLAYER.turnRate) {
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) return;
    const cur = Math.atan2(this.face.z, this.face.x);
    const want = Math.atan2(dz, dx);
    let diff = want - cur;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const step = Math.max(-rate * dt, Math.min(rate * dt, diff));
    const a = cur + step;
    this.face.set(Math.cos(a), 0, Math.sin(a));
  }

  /** animation hint consumed by the renderer */
  get anim(): string {
    if (this.holding && this.action === 'none') return 'hold';
    if (this.action === 'skill') return 'run';
    if (this.action !== 'none') return this.action;
    const s = this.speed;
    if (s < 0.4) return 'idle';
    if (s < 3.8) return 'walk';
    return 'run';
  }
}
