import { Vector3 } from 'three';
import { Ball } from './ball';
import { BALL, DIFFICULTY, Difficulty, FieldDims, PLAYER, TeamSize, fieldFor } from './config';
import { solveGroundPass, solveLob, solveShot, predictPath } from './kick';
import { KickKind, KickOrder, Player } from './player';
import { Rng } from './rng';
import { Team, TeamInfo, buildTeam } from './team';
import { aiTeam, gkThink, formationTarget } from './ai';
import { humanControl } from './human';

export interface MatchOptions {
  teamSize: TeamSize;
  /** real seconds per half */
  halfLength: number;
  difficulty: Difficulty;
  /** team controlled by the human (0/1) or -1 for AI vs AI */
  humanTeam: number;
  teams: [TeamInfo, TeamInfo];
  seed?: number;
}

export interface InputState {
  /** screen-space stick: x right, y up, magnitude <= 1 */
  mx: number;
  my: number;
  sprint: boolean;
  shoot: boolean;
  finesse: boolean;
  pass: boolean;
  through: boolean;
  lob: boolean;
  switch: boolean;
}

export const EMPTY_INPUT: InputState = { mx: 0, my: 0, sprint: false, shoot: false, finesse: false, pass: false, through: false, lob: false, switch: false };

export type GameEventType =
  | 'kick' | 'bounce' | 'post' | 'net' | 'whistle' | 'goal' | 'save' | 'catch' | 'tackle' | 'foul'
  | 'out' | 'halftime' | 'fulltime' | 'kickoff' | 'setpiece';

export interface GameEvent {
  type: GameEventType;
  pos?: Vector3;
  strength?: number;
  team?: number;
  text?: string;
  kind?: KickKind;
}

export type Phase = 'kickoff' | 'play' | 'goal' | 'setpiece' | 'halftime' | 'fulltime';
export type SetPieceKind = 'kickoff' | 'throwin' | 'corner' | 'goalkick' | 'freekick' | 'penalty';

export interface SetPiece {
  kind: SetPieceKind;
  team: number;
  pos: Vector3;
  taker: Player;
  ready: boolean;
  readyT: number;
}

export interface ShotInfo {
  team: number;
  /** goal x the shot is heading to */
  goalX: number;
  path: { t: number; p: Vector3 }[];
  t0: number;
  onTarget: boolean;
  crossT: number;
  cross: Vector3 | null;
  handled: boolean;
}

const _v = new Vector3();

export class Match {
  field: FieldDims;
  ball: Ball;
  teams: Team[];
  players: Player[] = [];
  rng: Rng;
  phase: Phase = 'kickoff';
  phaseT = 0;
  /** playing time elapsed in the current half (real seconds) */
  clock = 0;
  half = 1;
  time = 0;
  setPiece: SetPiece | null = null;
  owner: Player | null = null;
  ownerT = 0;
  events: GameEvent[] = [];
  humanTeam: number;
  controlled: Player | null = null;
  shot: ShotInfo | null = null;
  lastGoal: { team: number; scorer: Player | null; ownGoal: boolean; minute: number } | null = null;
  goals: { team: number; scorer: string; minute: number }[] = [];
  firstKickoffTeam = 0;
  /** per-player cooldown before he can touch the ball again */
  touchCooldown = new Map<number, number>();
  prevInput: InputState = { ...EMPTY_INPUT };
  diff: (typeof DIFFICULTY)[Difficulty];
  /** last pass: who it is meant for and where */
  pass: { from: Player; to: Player; target: Vector3; t: number } | null = null;

  constructor(public opts: MatchOptions) {
    this.field = fieldFor(opts.teamSize);
    this.ball = new Ball(this.field);
    this.rng = new Rng(opts.seed ?? (Date.now() & 0xffff));
    this.diff = DIFFICULTY[opts.difficulty];
    this.humanTeam = opts.humanTeam;
    const skills = [0, 1].map((i) => (i === opts.humanTeam ? 0.78 : opts.humanTeam < 0 ? 0.8 : this.diff.aiSkill));
    this.teams = [0, 1].map((i) => buildTeam(i, opts.teams[i], opts.teamSize, skills[i], i * 20, this.rng));
    this.teams[0].attackDir = 1;
    this.teams[1].attackDir = -1;
    for (const t of this.teams) this.players.push(...t.players);
    this.firstKickoffTeam = this.rng.chance(0.5) ? 0 : 1;
    this.startKickoff(this.firstKickoffTeam, true);
  }

  // ---------- helpers ----------
  teamOf(p: Player) {
    return this.teams[p.team];
  }
  opp(team: number) {
    return this.teams[1 - team];
  }
  attackGoalX(team: number) {
    return (this.teams[team].attackDir * this.field.length) / 2;
  }
  ownGoalX(team: number) {
    return (-this.teams[team].attackDir * this.field.length) / 2;
  }
  /** team in (or last in) possession */
  get possessionTeam() {
    if (this.owner) return this.owner.team;
    if (this.setPiece) return this.setPiece.team;
    return this.ball.lastTouchTeam;
  }
  get minute() {
    const m = (this.clock / this.opts.halfLength) * 45;
    return Math.floor(Math.min(45, m) + (this.half - 1) * 45);
  }
  isHuman(p: Player) {
    return this.controlled === p;
  }
  footPos(p: Player, out = _v) {
    return out.copy(p.pos).addScaledVector(p.face, 0.45);
  }
  emit(e: GameEvent) {
    this.events.push(e);
  }
  inBox(team: number, pos: Vector3, margin = 0) {
    // inside the penalty box that `team` defends
    const gx = this.ownGoalX(team);
    const f = this.field;
    return Math.abs(pos.x - gx) < f.boxDepth + margin && Math.abs(pos.z) < f.boxHalfW + margin;
  }

  // ---------- main step ----------
  step(dt: number, input: InputState = EMPTY_INPUT) {
    this.time += dt;
    this.phaseT += dt;
    for (const [id, t] of this.touchCooldown) {
      if (t - dt <= 0) this.touchCooldown.delete(id);
      else this.touchCooldown.set(id, t - dt);
    }

    if (this.phase === 'play') {
      this.clock += dt;
      if (this.clock >= this.opts.halfLength && !this.shotInFlight()) {
        this.endHalf();
        return;
      }
      if (this.owner) this.teams[this.owner.team].possessionT += dt;
    }
    if (this.phase === 'goal') this.goalPhase();
    if (this.phase === 'halftime' && this.phaseT > 3) {
      this.half = 2;
      this.clock = 0;
      for (const t of this.teams) t.attackDir *= -1;
      this.startKickoff(1 - this.firstKickoffTeam, true);
    }
    if (this.phase === 'fulltime') {
      for (const p of this.players) {
        p.desired.set(0, 0, 0);
        p.move(dt, false);
      }
      return;
    }

    // brains
    if (this.humanTeam >= 0 && this.phase !== 'goal') humanControl(this, input, dt);
    this.prevInput = { ...input };
    for (const t of this.teams) aiTeam(this, t, dt);
    for (const t of this.teams) gkThink(this, t.players[0], dt);

    // bodies
    for (const p of this.players) this.updatePlayer(p, dt);
    this.separatePlayers();

    // ball
    this.updateOwnerBall(dt);
    this.ball.step(dt);
    for (const e of this.ball.events) this.emit({ type: e.type, pos: e.pos, strength: e.strength });
    this.ball.events.length = 0;
    if (this.phase === 'play' || this.phase === 'goal') this.looseBallContacts();

    if (this.phase === 'play') this.checkRules();
    if (this.phase === 'setpiece' || this.phase === 'kickoff') this.setPieceTick(dt);
  }

  private shotInFlight() {
    return !!this.shot && this.time - this.shot.t0 < 2.5 && !this.owner;
  }

  // ---------- player update ----------
  private updatePlayer(p: Player, dt: number) {
    const withBall = this.owner === p;
    if (p.action !== 'none') {
      p.actionT += dt;
      switch (p.action) {
        case 'kick':
        case 'throw': {
          const windup = p.kick?.kind === 'shot' || p.kick?.kind === 'finesse' ? 0.16 : p.action === 'throw' ? 0.3 : 0.11;
          if (!p.kickFired && p.actionT >= windup) {
            p.kickFired = true;
            this.fireKick(p);
          }
          break;
        }
        case 'tackle':
          if (!p.kickFired && p.actionT > 0.12) {
            p.kickFired = true;
            this.resolveTackle(p);
          }
          break;
        case 'slide':
          this.slideTick(p, dt);
          break;
        case 'dive':
          this.diveTick(p, dt);
          break;
      }
      if (p.actionT >= p.actionDur && p.action !== 'celebrate') {
        if (p.action === 'slide') {
          p.setAction('fallen', 0.35);
        } else p.action = 'none';
        p.kick = null;
      }
    }
    p.move(dt, withBall);
    // facing
    if (p.action === 'none' || p.action === 'celebrate') {
      if (p.speed > 0.6) p.turnTowards(p.vel.x, p.vel.z, dt, withBall ? 9 : 14);
      else if (!p.holding) p.turnTowards(this.ball.pos.x - p.pos.x, this.ball.pos.z - p.pos.z, dt, 6);
    }
    // keep inside the stadium
    const f = this.field;
    p.pos.x = Math.max(-f.length / 2 - 4, Math.min(f.length / 2 + 4, p.pos.x));
    p.pos.z = Math.max(-f.width / 2 - 3.5, Math.min(f.width / 2 + 3.5, p.pos.z));
  }

  private separatePlayers() {
    const ps = this.players;
    const min = PLAYER.bodyRadius * 2;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (min - d) / 2;
          const nx = dx / d, nz = dz / d;
          // the ball carrier is a bit stronger
          const wa = this.owner === a ? 0.3 : this.owner === b ? 0.7 : 0.5;
          a.pos.x -= nx * push * 2 * wa;
          a.pos.z -= nz * push * 2 * wa;
          b.pos.x += nx * push * 2 * (1 - wa);
          b.pos.z += nz * push * 2 * (1 - wa);
        }
      }
    }
  }

  // ---------- ball control ----------
  setOwner(p: Player | null) {
    if (this.owner === p) return;
    this.owner = p;
    this.ownerT = 0;
    if (p) {
      this.ball.lastTouchTeam = p.team;
      this.ball.lastTouchPlayer = p.id;
      p.receiving = false;
      if (this.pass && this.pass.to !== p) this.pass = null;
      if (this.pass?.to === p) this.pass = null;
      for (const q of this.players) q.receiving = false;
      this.shot = null;
    }
  }

  private updateOwnerBall(dt: number) {
    const o = this.owner;
    const b = this.ball;
    if (!o) {
      b.held = false;
      return;
    }
    this.ownerT += dt;
    if (o.holding) {
      b.held = true;
      const hands = o.action === 'throw' ? 2.1 : 1.05;
      b.pos.set(o.pos.x + o.face.x * 0.35, hands, o.pos.z + o.face.z * 0.35);
      b.vel.set(0, 0, 0);
      b.spin.set(0, 0, 0);
      return;
    }
    b.held = false;
    if (o.action === 'fallen' || o.action === 'slide' || o.action === 'dive') {
      this.setOwner(null);
      return;
    }
    const hx = b.pos.x - o.pos.x, hz = b.pos.z - o.pos.z;
    if (Math.hypot(hx, hz) > 2.0 || b.pos.y > 1.8) {
      this.setOwner(null);
      return;
    }
    if (o.action === 'kick' && o.kickFired) return;
    // dribble: keep the ball just ahead of the feet, with a little touch rhythm
    const sp = o.speed;
    const rhythm = sp > 2 ? Math.sin(this.time * (5 + sp)) * 0.12 * Math.min(1, sp / 6) : 0;
    const off = 0.5 + sp * 0.05 + rhythm;
    const tx = o.pos.x + o.face.x * off;
    const tz = o.pos.z + o.face.z * off;
    const k = 12;
    b.vel.x = o.vel.x + (tx - b.pos.x) * k;
    b.vel.z = o.vel.z + (tz - b.pos.z) * k;
    // cushion: a controlled ball never keeps rising
    if (b.pos.y < BALL.radius + 0.05) b.vel.y = 0;
    else b.vel.y = Math.min(b.vel.y, 0);
  }

  /** Loose ball: who can control / block it this tick. */
  private looseBallContacts() {
    if (this.owner) return;
    const b = this.ball;
    if (b.held) return;
    let best: Player | null = null;
    let bestD = 1e9;
    for (const p of this.players) {
      if (p.action === 'fallen' || p.action === 'slide' || p.action === 'celebrate') continue;
      if (p.action === 'dive') continue;
      if (this.touchCooldown.has(p.id)) continue;
      if (b.kickerId === p.id && this.time - b.kickTime < 0.35) continue;
      const isGK = p.role === 'GK' && this.inBox(p.team, p.pos, 0.5);
      const r = isGK ? PLAYER.gkControlRadius : PLAYER.controlRadius;
      const hmax = isGK ? 2.5 : 1.15;
      if (b.pos.y > hmax) continue;
      const d = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
      if (d < r && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (!best) return;
    const p = best;
    const isGK = p.role === 'GK' && this.inBox(p.team, p.pos, 0.5);
    const rel = Math.hypot(b.vel.x - p.vel.x, b.vel.y, b.vel.z - p.vel.z);
    const skill = isGK ? p.stats.gk : p.stats.dribble;
    const limit = isGK ? 34 : 15 + skill * 6;
    if (rel < limit) {
      // first touch quality
      const pFail = isGK ? Math.max(0, (rel - 16) / 40) * (1.2 - skill) : Math.max(0, (rel - 8) / 22) * (1.1 - skill);
      if (this.rng.chance(pFail)) {
        this.deflect(p, 0.45);
        return;
      }
      if (isGK && b.lastTouchTeam !== p.team && b.pos.y > 0.3) {
        this.gkCatch(p);
        return;
      }
      if (isGK && b.lastTouchTeam !== p.team) {
        this.gkCatch(p);
        return;
      }
      this.setOwner(p);
      if (!this.controlled || p.team !== this.humanTeam) return;
      if (p.role !== 'GK') this.controlled = p;
    } else {
      // too hot to handle: block / deflect
      this.deflect(p, isGK ? 0.35 : 0.3);
      if (isGK) this.emit({ type: 'save', pos: b.pos.clone(), team: p.team });
    }
  }

  deflect(p: Player, keep: number) {
    const b = this.ball;
    const nx = b.pos.x - p.pos.x, nz = b.pos.z - p.pos.z;
    const nl = Math.hypot(nx, nz) || 1;
    const sp = b.vel.length();
    b.vel.set((nx / nl) * sp * keep + this.rng.range(-2, 2), Math.abs(b.vel.y) * 0.3 + this.rng.range(0.5, 3), (nz / nl) * sp * keep + this.rng.range(-2, 2));
    b.spin.multiplyScalar(0.3);
    b.lastTouchTeam = p.team;
    b.lastTouchPlayer = p.id;
    b.kickerId = p.id;
    b.kickTime = this.time;
    this.touchCooldown.set(p.id, 0.4);
    this.shot = null;
    this.emit({ type: 'kick', pos: b.pos.clone(), strength: sp * keep, team: p.team });
  }

  gkCatch(p: Player) {
    this.setOwner(p);
    p.holding = true;
    p.holdT = 0;
    this.ball.held = true;
    this.shot = null;
    this.emit({ type: 'catch', pos: this.ball.pos.clone(), team: p.team });
  }

  // ---------- kicks ----------
  /** Start a kick (wind-up animation); the ball is struck a few frames later. */
  orderKick(p: Player, kind: KickKind, target: Vector3, power: number, receiver: Player | null = null, curl = 0) {
    if (p.busy) return false;
    const order: KickOrder = { kind, target: target.clone(), power, receiverId: receiver ? receiver.id : -1, curl };
    p.kick = order;
    const throwing = kind === 'throwin' || (kind === 'punt' && false);
    p.setAction(throwing ? 'throw' : 'kick', throwing ? 0.6 : 0.42);
    // face the target
    p.face.set(target.x - p.pos.x, 0, target.z - p.pos.z).normalize();
    if (p.face.lengthSq() < 0.5) p.face.set(this.teams[p.team].attackDir, 0, 0);
    return true;
  }

  private fireKick(p: Player) {
    const o = p.kick;
    if (!o) return;
    const b = this.ball;
    const foot = this.footPos(p, new Vector3());
    const hands = p.holding;
    const d = Math.hypot(b.pos.x - foot.x, b.pos.z - foot.z);
    if (!hands && (d > PLAYER.kickReach || b.pos.y > 1.4)) return; // whiff
    if (hands) {
      p.holding = false;
      b.held = false;
      if (o.kind === 'punt') b.pos.set(foot.x, 0.6, foot.z);
    }
    if (!hands && this.owner && this.owner !== p) return;
    const from = b.pos.clone();
    let sol;
    const f = this.field;
    switch (o.kind) {
      case 'shot': {
        const speed = 19 + 13 * o.power;
        sol = solveShot(f, from, o.target, speed, this.rng.range(-6, 6), 8 + 10 * o.power);
        break;
      }
      case 'finesse': {
        const speed = 17 + 8 * o.power;
        sol = solveShot(f, from, o.target, speed, o.curl * (48 + 20 * o.power), 6);
        break;
      }
      case 'pass': {
        const dist = Math.hypot(o.target.x - from.x, o.target.z - from.z);
        sol = solveGroundPass(from, o.target, Math.min(9, 4 + dist * 0.12));
        break;
      }
      case 'through':
        sol = solveGroundPass(from, o.target, 3.2);
        break;
      case 'lob':
        sol = solveLob(f, from, o.target, 0.62, 22);
        break;
      case 'cross':
        sol = solveLob(f, from, o.target, 0.42, 18);
        break;
      case 'clear':
      case 'punt':
        sol = solveLob(f, from, o.target, o.kind === 'punt' ? 0.62 : 0.5, 10);
        break;
      case 'throwin':
        sol = solveLob(f, from, o.target, 0.35, 0);
        break;
    }
    b.vel.copy(sol.vel);
    b.spin.copy(sol.spin);
    b.lastTouchTeam = p.team;
    b.lastTouchPlayer = p.id;
    b.kickerId = p.id;
    b.kickTime = this.time;
    this.setOwner(null);
    this.ball.lastTouchTeam = p.team;
    this.ball.lastTouchPlayer = p.id;
    this.emit({ type: 'kick', pos: from, strength: sol.vel.length(), team: p.team, kind: o.kind });
    if (this.phase === 'setpiece' || this.phase === 'kickoff') {
      this.phase = 'play';
      this.setPiece = null;
      for (const q of this.players) q.spot = null;
    }
    const receiver = this.players.find((q) => q.id === o.receiverId) ?? null;
    if (receiver) {
      receiver.receiving = true;
      this.pass = { from: p, to: receiver, target: o.target.clone(), t: this.time };
      if (this.controlled && receiver.team === this.humanTeam && this.controlled.team === receiver.team) this.controlled = receiver;
    } else this.pass = null;

    if (o.kind === 'shot' || o.kind === 'finesse' || (o.kind === 'clear' && false)) {
      this.teams[p.team].shots++;
      this.registerShot(p.team);
    }
  }

  /** Predict shot path so the keeper can react. */
  registerShot(team: number) {
    const goalX = this.attackGoalX(team);
    const path = predictPath(this.ball, 2.2, 0.02);
    let cross: Vector3 | null = null;
    let crossT = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1].p, c = path[i].p;
      if ((a.x - goalX) * (c.x - goalX) <= 0) {
        const k = (goalX - a.x) / (c.x - a.x || 1e-6);
        cross = a.clone().lerp(c, k);
        crossT = path[i - 1].t + (path[i].t - path[i - 1].t) * k;
        break;
      }
    }
    const f = this.field;
    const onTarget = !!cross && Math.abs(cross.z) < f.goalHalfW + 0.05 && cross.y < f.goalH + 0.05;
    if (onTarget) this.teams[team].shotsOnTarget++;
    this.shot = { team, goalX, path, t0: this.time, onTarget, crossT, cross, handled: false };
  }

  // ---------- tackles ----------
  startTackle(p: Player) {
    if (p.busy) return;
    p.setAction('tackle', 0.4);
    p.lastTackleT = this.time;
  }

  startSlide(p: Player, dir: Vector3) {
    if (p.busy) return;
    p.setAction('slide', 0.8);
    p.actionDir.copy(dir).setY(0).normalize();
    p.face.copy(p.actionDir);
    p.vel.copy(p.actionDir).multiplyScalar(Math.max(8.5, p.speed + 2));
    p.lastTackleT = this.time;
    p.kickFired = false; // reused as "touched ball"
  }

  private resolveTackle(p: Player) {
    const o = this.owner;
    if (!o || o.team === p.team) return;
    const d = Math.hypot(this.ball.pos.x - p.pos.x, this.ball.pos.z - p.pos.z);
    if (d > 1.7) return;
    // angle: tackling from the front is easier
    const tox = p.pos.x - o.pos.x, toz = p.pos.z - o.pos.z;
    const tl = Math.hypot(tox, toz) || 1;
    const front = (tox * o.face.x + toz * o.face.z) / tl;
    let chance = 0.3 + 0.4 * p.stats.tackle - 0.35 * o.stats.dribble + front * 0.12;
    if (p.team !== this.humanTeam && this.humanTeam >= 0) chance *= 0.75 + 0.35 * this.diff.aiSkill;
    if (o.holding) chance = 0;
    if (this.rng.chance(Math.max(0.12, Math.min(0.85, chance)))) {
      this.setOwner(null);
      const b = this.ball;
      const ax = b.pos.x - o.pos.x + this.rng.range(-0.5, 0.5);
      const az = b.pos.z - o.pos.z + this.rng.range(-0.5, 0.5);
      const al = Math.hypot(ax, az) || 1;
      b.vel.set((-o.face.x * 0.5 + ax / al) * 3.5, 0.5, (-o.face.z * 0.5 + az / al) * 3.5);
      b.lastTouchTeam = p.team;
      b.lastTouchPlayer = p.id;
      this.touchCooldown.set(o.id, 0.6);
      this.emit({ type: 'tackle', pos: b.pos.clone(), team: p.team });
    } else if (front < -0.3 && this.rng.chance(0.18)) {
      this.foul(p, o);
    } else {
      p.actionDur = 0.7; // stumble
    }
  }

  private slideTick(p: Player, dt: number) {
    const t = p.actionT;
    const sp = Math.max(0, 9 - t * 9);
    p.vel.copy(p.actionDir).multiplyScalar(sp);
    p.pos.addScaledVector(p.vel, dt);
    if (t > 0.6) return;
    const b = this.ball;
    const fx = p.pos.x + p.actionDir.x * 0.7, fz = p.pos.z + p.actionDir.z * 0.7;
    if (!p.kickFired && b.pos.y < 0.6 && Math.hypot(b.pos.x - fx, b.pos.z - fz) < 0.85 && !b.held) {
      p.kickFired = true;
      if (this.owner && this.owner !== p) this.touchCooldown.set(this.owner.id, 0.6);
      this.setOwner(null);
      b.vel.set(p.actionDir.x * 7 + this.rng.range(-3, 3), 1, p.actionDir.z * 7 + this.rng.range(-3, 3));
      b.lastTouchTeam = p.team;
      b.lastTouchPlayer = p.id;
      b.kickerId = p.id;
      b.kickTime = this.time;
      this.emit({ type: 'tackle', pos: b.pos.clone(), team: p.team });
    }
    for (const q of this.players) {
      if (q.team === p.team || q.action === 'fallen' || q.role === 'GK') continue;
      if (Math.hypot(q.pos.x - fx, q.pos.z - fz) < 0.75) {
        if (!p.kickFired && (this.owner === q || Math.hypot(b.pos.x - q.pos.x, b.pos.z - q.pos.z) < 2.5)) {
          this.foul(p, q);
          return;
        }
        q.setAction('fallen', 1.1);
        if (this.owner === q) this.setOwner(null);
      }
    }
  }

  private foul(by: Player, victim: Player) {
    victim.setAction('fallen', 1.3);
    if (this.owner === victim) this.setOwner(null);
    this.emit({ type: 'foul', pos: victim.pos.clone(), team: by.team });
    this.emit({ type: 'whistle', strength: 1 });
    const pos = victim.pos.clone().setY(BALL.radius);
    const f = this.field;
    pos.x = Math.max(-f.length / 2 + 1, Math.min(f.length / 2 - 1, pos.x));
    pos.z = Math.max(-f.width / 2 + 1, Math.min(f.width / 2 - 1, pos.z));
    if (this.inBox(by.team, pos)) {
      const gx = this.ownGoalX(by.team);
      pos.set(gx - Math.sign(gx) * f.penaltySpot, BALL.radius, 0);
      this.startSetPiece('penalty', victim.team, pos);
    } else this.startSetPiece('freekick', victim.team, pos);
  }

  // ---------- goalkeeper dive ----------
  startDive(gk: Player, target: Vector3, duration: number, saves: boolean) {
    gk.setAction('dive', Math.max(0.55, duration + 0.45));
    gk.actionTarget.copy(target);
    gk.actionDir.set(gk.pos.x, 0, gk.pos.z); // start pos
    gk.diveSaves = saves;
    gk.diveHeight = target.y;
    gk.kickFired = false;
    gk.vel.set(0, 0, 0);
  }

  private diveTick(gk: Player, dt: number) {
    const reachT = Math.max(0.15, gk.actionDur - 0.45);
    const k = Math.min(1, gk.actionT / reachT);
    const ease = 1 - (1 - k) * (1 - k);
    const sx = gk.actionDir.x, sz = gk.actionDir.z;
    const nx = sx + (gk.actionTarget.x - sx) * ease;
    const nz = sz + (gk.actionTarget.z - sz) * ease;
    gk.vel.set((nx - gk.pos.x) / dt, 0, (nz - gk.pos.z) / dt);
    gk.pos.x = nx;
    gk.pos.z = nz;
    if (gk.kickFired || !gk.diveSaves) return;
    const b = this.ball;
    const hy = Math.min(2.6, 0.4 + gk.diveHeight * ease);
    const d = Math.hypot(b.pos.x - gk.pos.x, b.pos.y - hy, b.pos.z - gk.pos.z);
    if (d < 0.95) {
      gk.kickFired = true;
      const sp = b.vel.length();
      if (sp < 19 && Math.abs(b.pos.y - 1.1) < 0.9 && this.rng.chance(0.55 + 0.4 * gk.stats.gk)) {
        this.gkCatch(gk);
      } else {
        // parry away from goal, out wide
        const away = -Math.sign(this.ownGoalX(gk.team));
        const side = Math.sign(b.pos.z - gk.pos.x * 0 - 0) || (this.rng.chance(0.5) ? 1 : -1);
        b.vel.set(away * sp * this.rng.range(0.15, 0.35), this.rng.range(2, 6), side * this.rng.range(3, 8));
        b.spin.set(0, 0, 0);
        b.lastTouchTeam = gk.team;
        b.lastTouchPlayer = gk.id;
        b.kickerId = gk.id;
        b.kickTime = this.time;
        this.touchCooldown.set(gk.id, 0.8);
        this.shot = null;
      }
      this.emit({ type: 'save', pos: b.pos.clone(), team: gk.team });
    }
  }

  // ---------- rules ----------
  private checkRules() {
    const b = this.ball;
    const f = this.field;
    const R = BALL.radius;
    // goal
    if (b.inGoal !== 0 && (b.pos.x * b.inGoal) - f.length / 2 > R) {
      const scoringTeam = this.teams.find((t) => t.attackDir === b.inGoal)!.index;
      this.goalScored(scoringTeam);
      return;
    }
    if (b.held) return;
    // touchline
    if (Math.abs(b.pos.z) > f.width / 2 + R) {
      const team = 1 - Math.max(0, b.lastTouchTeam);
      const pos = new Vector3(Math.max(-f.length / 2 + 0.5, Math.min(f.length / 2 - 0.5, b.pos.x)), R, Math.sign(b.pos.z) * (f.width / 2 + 0.2));
      this.emit({ type: 'out', pos: b.pos.clone() });
      this.startSetPiece('throwin', team, pos);
      return;
    }
    // goal line (not a goal)
    if (Math.abs(b.pos.x) > f.length / 2 + R && b.inGoal === 0) {
      const side = Math.sign(b.pos.x);
      const defending = this.teams.find((t) => t.attackDir === -side)!.index;
      this.emit({ type: 'out', pos: b.pos.clone() });
      if (b.lastTouchTeam === defending) {
        const pos = new Vector3(side * (f.length / 2 - 0.4), R, Math.sign(b.pos.z || 1) * (f.width / 2 - 0.4));
        this.startSetPiece('corner', 1 - defending, pos);
      } else {
        const pos = new Vector3(side * (f.length / 2 - f.smallBoxDepth), R, Math.sign(b.pos.z || 1) * f.smallBoxHalfW * 0.6);
        this.startSetPiece('goalkick', defending, pos);
      }
    }
  }

  private goalScored(team: number) {
    this.teams[team].score++;
    const scorer = this.players.find((p) => p.id === this.ball.lastTouchPlayer) ?? null;
    const ownGoal = !!scorer && scorer.team !== team;
    this.lastGoal = { team, scorer, ownGoal, minute: this.minute + 1 };
    this.goals.push({ team, scorer: scorer ? scorer.name + (ownGoal ? ' (og)' : '') : '?', minute: this.minute + 1 });
    this.phase = 'goal';
    this.phaseT = 0;
    this.setOwner(null);
    this.shot = null;
    this.emit({ type: 'goal', team, pos: this.ball.pos.clone(), text: scorer?.name });
    // celebration targets: run to the nearest corner flag
    const f = this.field;
    const cx = this.attackGoalX(team) * 0.85;
    const cz = Math.sign(this.ball.pos.z || 1) * f.width * 0.42;
    for (const p of this.teams[team].players) {
      if (p.role === 'GK') continue;
      p.celebrateTarget = new Vector3(cx + this.rng.range(-3, 3), 0, cz + this.rng.range(-3, 3));
    }
    if (scorer && !ownGoal) scorer.celebrateTarget = new Vector3(cx, 0, cz);
  }

  private goalPhase() {
    for (const p of this.players) {
      if (p.celebrateTarget) {
        const dx = p.celebrateTarget.x - p.pos.x, dz = p.celebrateTarget.z - p.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.5 && p.action !== 'celebrate') p.setAction('celebrate', 99);
      }
    }
    if (this.phaseT > 6) {
      const conceding = 1 - (this.lastGoal?.team ?? 0);
      for (const p of this.players) {
        p.celebrateTarget = null;
        if (p.action === 'celebrate') p.action = 'none';
      }
      this.startKickoff(conceding, true);
    }
  }

  private endHalf() {
    this.emit({ type: 'whistle', strength: 3 });
    this.setOwner(null);
    this.shot = null;
    if (this.half === 1) {
      this.phase = 'halftime';
      this.emit({ type: 'halftime' });
    } else {
      this.phase = 'fulltime';
      this.emit({ type: 'fulltime' });
    }
    this.phaseT = 0;
  }

  // ---------- set pieces ----------
  startKickoff(team: number, teleport: boolean) {
    const f = this.field;
    this.phase = 'kickoff';
    this.phaseT = 0;
    this.setOwner(null);
    this.shot = null;
    this.pass = null;
    this.ball.place(0, 0);
    this.ball.lastTouchTeam = team;
    for (const p of this.players) {
      p.action = 'none';
      p.holding = false;
      p.kick = null;
      p.receiving = false;
      const t = this.teams[p.team];
      let xn = Math.min(p.home.x, 0.44);
      let zn = p.home.z;
      let x = t.attackDir * (xn - 0.5) * f.length;
      let z = zn * t.attackDir * (f.width / 2) * 0.85;
      // outside the centre circle
      if (Math.hypot(x, z) < f.centerRadius + 0.8) {
        const k = (f.centerRadius + 0.8) / (Math.hypot(x, z) || 1);
        x *= k;
        z *= k;
        if (Math.abs(x) < 0.5) x = -t.attackDir * (f.centerRadius + 0.8);
      }
      p.spot = new Vector3(x, 0, z);
      if (teleport) {
        p.pos.copy(p.spot);
        p.vel.set(0, 0, 0);
      }
      p.face.set(t.attackDir, 0, 0);
    }
    const taker = this.teams[team].players.find((p) => p.role === 'FWD') ?? this.teams[team].players[this.teams[team].players.length - 1];
    const dir = this.teams[team].attackDir;
    taker.spot = new Vector3(-dir * 0.6, 0, 0.15);
    if (teleport) taker.pos.copy(taker.spot);
    const mate = this.teams[team].players.find((p) => p !== taker && p.role !== 'GK' && p.role !== 'DEF' && p.home.x > 0.3);
    if (mate) {
      mate.spot = new Vector3(-dir * 1.2, 0, -4);
      if (teleport) mate.pos.copy(mate.spot);
    }
    this.setPiece = { kind: 'kickoff', team, pos: new Vector3(0, BALL.radius, 0), taker, ready: false, readyT: 0 };
    if (this.humanTeam === team) this.controlled = taker;
    else if (this.humanTeam >= 0) this.controlled = this.nearestOutfield(this.humanTeam, this.ball.pos);
    this.emit({ type: 'kickoff', team });
  }

  startSetPiece(kind: SetPieceKind, team: number, pos: Vector3) {
    this.phase = 'setpiece';
    this.phaseT = 0;
    this.setOwner(null);
    this.shot = null;
    this.pass = null;
    this.ball.place(pos.x, pos.z);
    this.ball.lastTouchTeam = team;
    for (const p of this.players) {
      p.receiving = false;
      p.spot = null;
      if (p.action === 'dive' || p.action === 'kick' || p.action === 'tackle') p.action = 'none';
      p.holding = false;
    }
    const t = this.teams[team];
    let taker: Player;
    if (kind === 'goalkick') taker = t.players[0];
    else if (kind === 'penalty' || (kind === 'freekick' && this.distToGoal(team, pos) < 32)) {
      taker = [...t.players].filter((p) => p.role !== 'GK').sort((a, b) => b.stats.shot - a.stats.shot)[0];
    } else taker = this.nearestOutfield(team, pos);
    this.setPiece = { kind, team, pos: pos.clone(), taker, ready: false, readyT: 0 };
    // taker stands behind the ball, facing the field / goal
    const gx = this.attackGoalX(team);
    const aim = kind === 'throwin' ? new Vector3(pos.x + t.attackDir * 6, 0, 0) : new Vector3(gx, 0, 0);
    const back = new Vector3(pos.x - aim.x, 0, pos.z - aim.z).normalize();
    taker.spot = pos.clone().setY(0).addScaledVector(back, kind === 'throwin' ? 0.2 : 0.7);
    this.layoutSetPiece(kind, team, pos);
    if (kind === 'penalty' || kind === 'corner' || kind === 'goalkick') {
      for (const p of this.players) if (p.spot) p.pos.copy(p.spot);
    }
    if (kind === 'throwin') {
      // short walk only
      taker.pos.copy(taker.spot);
    }
    if (this.humanTeam === team && taker.role !== 'GK') this.controlled = taker;
    else if (this.humanTeam >= 0 && (!this.controlled || this.controlled.role === 'GK')) this.controlled = this.nearestOutfield(this.humanTeam, pos);
    this.emit({ type: 'setpiece', team, text: kind });
    if (kind !== 'throwin') this.emit({ type: 'whistle', strength: 1 });
  }

  distToGoal(team: number, pos: Vector3) {
    return Math.hypot(pos.x - this.attackGoalX(team), pos.z);
  }

  /** Assign target spots to everybody for a dead-ball situation. */
  private layoutSetPiece(kind: SetPieceKind, team: number, pos: Vector3) {
    const f = this.field;
    const att = this.teams[team];
    const def = this.teams[1 - team];
    const gx = this.attackGoalX(team);
    const dirIn = -Math.sign(gx); // from goal towards the field
    const taker = this.setPiece!.taker;
    const box = (dx: number, dz: number) => new Vector3(gx + dirIn * dx, 0, dz);
    if (kind === 'corner' || kind === 'penalty' || (kind === 'freekick' && this.distToGoal(team, pos) < 30)) {
      const attackers = att.players.filter((p) => p !== taker && p.role !== 'GK');
      const defenders = def.players.filter((p) => p.role !== 'GK');
      if (kind === 'penalty') {
        attackers.forEach((p, i) => (p.spot = box(f.boxDepth + 1.5 + (i % 3), (i - attackers.length / 2) * 2.2)));
        defenders.forEach((p, i) => (p.spot = box(f.boxDepth + 1.5 + (i % 2), (i - defenders.length / 2) * 2.2 + 1)));
        def.players[0].spot = new Vector3(gx + dirIn * 0.3, 0, 0);
        taker.spot = pos.clone().setY(0).add(new Vector3(-dirIn * -1.2, 0, 0.2));
        att.players[0].spot = new Vector3(-gx * 0.7, 0, 0);
        return;
      }
      if (kind === 'corner') {
        const nAtt = Math.min(attackers.length, 5);
        attackers.forEach((p, i) => {
          if (i < nAtt) p.spot = box(this.rng.range(4, f.penaltySpot + 3), this.rng.range(-f.goalHalfW - 4, f.goalHalfW + 4));
          else p.spot = box(f.length * 0.3 + i, (i % 2 ? 1 : -1) * 8);
        });
        defenders.forEach((p, i) => {
          if (i < nAtt + 1) p.spot = box(this.rng.range(1.5, f.penaltySpot), this.rng.range(-f.goalHalfW - 2, f.goalHalfW + 2));
          else p.spot = box(f.boxDepth + 6, (i % 2 ? 1 : -1) * 6);
        });
        def.players[0].spot = new Vector3(gx + dirIn * 0.5, 0, 0);
        return;
      }
      // direct free kick near goal: wall
      const toGoal = new Vector3(gx - pos.x, 0, -pos.z).normalize();
      const side = new Vector3(-toGoal.z, 0, toGoal.x);
      const wallN = Math.min(4, Math.max(2, defenders.length - 3));
      for (let i = 0; i < defenders.length; i++) {
        if (i < wallN) defenders[i].spot = pos.clone().setY(0).addScaledVector(toGoal, 9.15).addScaledVector(side, (i - (wallN - 1) / 2) * 0.75);
        else defenders[i].spot = formationTarget(this, defenders[i]);
      }
      attackers.forEach((p) => (p.spot = formationTarget(this, p)));
      return;
    }
    // generic: formation + keep 9m from the ball
    for (const p of this.players) {
      if (p === taker) continue;
      const s = formationTarget(this, p);
      if (p.team !== team) {
        const d = Math.hypot(s.x - pos.x, s.z - pos.z);
        if (d < 9.2) {
          const k = 9.2 / (d || 1);
          s.x = pos.x + (s.x - pos.x) * k;
          s.z = pos.z + (s.z - pos.z) * k;
        }
      }
      p.spot = s;
    }
  }

  private setPieceTick(dt: number) {
    const sp = this.setPiece;
    if (!sp) return;
    const t = sp.taker;
    const b = this.ball;
    if (!sp.ready) {
      b.place(sp.pos.x, sp.pos.z);
      const d = t.spot ? Math.hypot(t.spot.x - t.pos.x, t.spot.z - t.pos.z) : 0;
      if (this.phaseT > (sp.kind === 'kickoff' ? 0.8 : 1.4) && (d < 0.6 || this.phaseT > 5)) {
        if (d >= 0.6 && t.spot) t.pos.copy(t.spot);
        sp.ready = true;
        sp.readyT = 0;
        if (sp.kind === 'throwin') {
          this.setOwner(t);
          t.holding = true;
          b.held = true;
        } else if (sp.kind === 'goalkick' || sp.kind === 'kickoff' || sp.kind === 'freekick' || sp.kind === 'corner' || sp.kind === 'penalty') {
          this.setOwner(t);
        }
        if (sp.kind !== 'throwin' || this.phaseT > 0) this.emit({ type: 'whistle', strength: sp.kind === 'kickoff' ? 2 : 1 });
      }
    } else {
      sp.readyT += dt;
      // keep the ball dead until struck
      if (!t.holding && this.owner === t && t.action !== 'kick') {
        b.place(sp.pos.x, sp.pos.z);
      }
      if (this.owner !== t && !t.busy && sp.kind !== 'throwin') this.setOwner(t);
    }
  }

  nearestOutfield(team: number, pos: Vector3, exclude: Player | null = null) {
    let best: Player | null = null;
    let bd = 1e9;
    for (const p of this.teams[team].players) {
      if (p.role === 'GK' || p === exclude) continue;
      const d = Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best!;
  }
}
