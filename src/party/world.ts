import { PBody, PWorld, Tag } from './phys';
import { Vector3 } from 'three';
import { BALL as CLASSIC_BALL, FieldDims, TeamSize, fieldFor } from '../sim/config';
import { groundPassSpeed } from '../sim/kick';
import { Rng } from '../sim/rng';
import { TEAM_PRESETS, TeamInfo, CHARACTER_MODELS, FORMATIONS } from '../sim/team';
import { Bro, BRO } from './bro';
import { think, formationSpot } from './brain';

/**
 * footballbro match world: wobbly physics bros (cannon-es) playing real football rules on a
 * real-size pitch — kick-offs, two halves, throw-ins, corners, goal kicks, fouls → free kicks
 * and penalties. Pure logic (no rendering), runs headless in tests.
 */

export const PARTY_DT = 1 / 120;

export const BALL_P = {
  radius: 0.15,
  mass: 0.43,
  /** a bit less air drag than the classic game: shots and long balls keep their pace */
  dragK: 0.009,
  magnusK: CLASSIC_BALL.magnusK,
  rollC: CLASSIC_BALL.rollC,
  rollLin: CLASSIC_BALL.rollLin,
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
  type: 'kick' | 'bounce' | 'post' | 'net' | 'goal' | 'bonk' | 'shove' | 'whistle' | 'save' | 'foul' | 'setpiece' | 'halftime' | 'fulltime';
  pos?: Vector3;
  strength?: number;
  team?: number;
  text?: string;
}

export interface Team {
  index: number;
  info: TeamInfo;
  score: number;
  /** +1 attacks the goal at +x (flips at half time) */
  dir: number;
}

export type Phase = 'kickoff' | 'play' | 'setpiece' | 'goal' | 'halftime' | 'over';
export type SetKind = 'kickoff' | 'throwin' | 'corner' | 'goalkick' | 'freekick' | 'penalty';

export interface SetPiece {
  kind: SetKind;
  team: number;
  pos: Vector3;
  taker: Bro;
  /** seconds since the set piece started */
  t: number;
}

export interface WorldOpts {
  humanTeam: number;
  size: TeamSize;
  /** seconds per half */
  halfLength: number;
  seed?: number;
  teams?: [TeamInfo, TeamInfo];
}

export class PartyWorld {
  world!: PWorld;
  ball!: PBody;
  bros: Bro[] = [];
  teams: Team[];
  field: FieldDims;
  rng: Rng;
  time = 0;
  /** playing time in the current half */
  clock = 0;
  half = 1;
  phase: Phase = 'kickoff';
  phaseT = 0;
  setPiece: SetPiece | null = null;
  events: PartyEvent[] = [];
  controlled: Bro | null = null;
  humanTeam: number;
  lastTouch: Bro | null = null;
  lastScorer: Bro | null = null;
  lastGoalTeam = -1;
  prevInput: PartyInput = { ...NO_INPUT };
  firstKickoff = 0;
  /** the pass the human just played: control follows the ball to the receiver */
  passTo: Bro | null = null;
  /** bro the ball is "glued" to while dribbling (sticky, with hysteresis) */
  holder: Bro | null = null;
  private lastBallVy = 0;
  private netCd = 0;
  private postCd = 0;
  private autoSwitchCd = 0;
  private bodyMap = new Map<unknown, Bro>();

  constructor(public opts: WorldOpts) {
    this.rng = new Rng(opts.seed ?? (Date.now() & 0xffff));
    this.humanTeam = opts.humanTeam;
    this.field = fieldFor(opts.size);
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
    const f = this.field;
    this.world = new PWorld(-11.5);
    const W = this.world;
    W.ground();
    // advertising boards (the ball stays in the stadium after going out)
    const bx = f.length / 2 + f.boardMargin + 1.5;
    const bz = f.width / 2 + f.boardMargin;
    W.box('wall', bx + 1, 1.5, 0.5, 0, 1.5, -bz - 0.5);
    W.box('wall', bx + 1, 1.5, 0.5, 0, 1.5, bz + 0.5);
    W.box('wall', 0.5, 1.5, bz + 1, -bx - 0.5, 1.5, 0);
    W.box('wall', 0.5, 1.5, bz + 1, bx + 0.5, 1.5, 0);
    // goal frames and soft nets
    for (const dir of [-1, 1]) {
      const x0 = (dir * f.length) / 2;
      const r = 0.06;
      W.cylinder('post', r, f.goalH / 2, x0, f.goalH / 2, -f.goalHalfW);
      W.cylinder('post', r, f.goalH / 2, x0, f.goalH / 2, f.goalHalfW);
      W.cylinder('post', r, f.goalHalfW, x0, f.goalH, 0, true);
      // net panels sit a little behind the cloth so the ball visibly bulges it
      const d = f.goalDepthBottom + 0.3;
      W.box('net', 0.1, f.goalH / 2 + 0.3, f.goalHalfW + 0.3, x0 + dir * (d + 0.1), f.goalH / 2, 0);
      W.box('net', d / 2, f.goalH / 2, 0.1, x0 + dir * (d / 2), f.goalH / 2, -(f.goalHalfW + 0.3));
      W.box('net', d / 2, f.goalH / 2, 0.1, x0 + dir * (d / 2), f.goalH / 2, f.goalHalfW + 0.3);
      W.box('net', d / 2, 0.1, f.goalHalfW + 0.3, x0 + dir * (d / 2), f.goalH + 0.3, 0);
    }
    this.ball = W.ball(BALL_P.radius, BALL_P.mass, 0.0, 0.03);
    this.ball.setTranslation({ x: 0, y: BALL_P.radius, z: 0 });
    W.onBallHit = (tag: Tag, sp: number, other) => {
      if (tag === 'net' && sp > 3 && this.netCd <= 0) {
        this.netCd = 0.4;
        this.emit({ type: 'net', pos: this.ballPos(), strength: sp });
      }
      if (tag === 'post' && sp > 3 && this.postCd <= 0) {
        this.postCd = 0.4;
        this.emit({ type: 'post', pos: this.ballPos(), strength: sp });
      }
      if (tag === 'bro') {
        const b = this.bodyMap.get(other);
        if (b) this.lastTouch = b;
      }
    };
    // squads from the classic formations
    let id = 0;
    const models = [...CHARACTER_MODELS.keys()].sort(() => this.rng.next() - 0.5);
    const numbers: Record<string, number[]> = { GK: [1], DEF: [2, 3, 4, 5, 6], MID: [8, 6, 10, 7, 14], FWD: [9, 11, 19] };
    for (const t of this.teams) {
      const used: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
      for (const slot of FORMATIONS[this.opts.size]) {
        const role = slot.role === 'GK' ? 'GK' : 'FIELD';
        const b = new Bro(W, id, t.index, role, models[id % models.length], '', 0, 0);
        b.home = { x: slot.x, z: slot.z };
        b.number = numbers[slot.role][used[slot.role]++] ?? 12 + id;
        b.name = `#${b.number}`;
        this.bodyMap.set(b.body.b, b);
        this.bros.push(b);
        id++;
      }
    }
    this.firstKickoff = this.rng.chance(0.5) ? 0 : 1;
    this.startKickoff(this.firstKickoff);
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
  goalX(team: number) {
    return (this.teams[team].dir * this.field.length) / 2;
  }
  ownGoalX(team: number) {
    return (-this.teams[team].dir * this.field.length) / 2;
  }
  teamBros(team: number) {
    return this.bros.filter((b) => b.team === team);
  }
  emit(e: PartyEvent) {
    this.events.push(e);
  }
  /** inside the penalty area that `team` defends */
  inBox(team: number, p: Vector3, margin = 0) {
    const gx = this.ownGoalX(team);
    return Math.abs(p.x - gx) < this.field.boxDepth + margin && Math.abs(p.z) < this.field.boxHalfW + margin;
  }
  get possessionTeam() {
    return this.setPiece ? this.setPiece.team : this.lastTouch?.team ?? -1;
  }
  /** "M:SS" clock of the half in football minutes (45 per half) */
  get minute() {
    return Math.min(45, Math.floor((this.clock / this.opts.halfLength) * 45)) + (this.half - 1) * 45;
  }
  private placeBall(p: Vector3) {
    this.ball.setTranslation({ x: p.x, y: BALL_P.radius + 0.01, z: p.z });
    this.ball.setLinvel({ x: 0, y: 0, z: 0 });
    this.ball.setAngvel({ x: 0, y: 0, z: 0 });
  }

  // ---------------- dead balls ----------------
  startKickoff(team: number) {
    this.phase = 'kickoff';
    this.phaseT = 0;
    this.placeBall(new Vector3());
    const f = this.field;
    for (const t of this.teams) {
      for (const b of this.teamBros(t.index)) {
        const xn = Math.min(b.home.x, 0.44);
        let x = t.dir * (xn - 0.5) * f.length;
        let z = b.home.z * t.dir * (f.width / 2) * 0.85;
        const r = f.centerRadius + 0.8;
        if (Math.hypot(x, z) < r) {
          const k = r / (Math.hypot(x, z) || 1);
          x *= k;
          z *= k;
        }
        b.teleport(x, z, t.dir);
        b.spot = null;
      }
    }
    const kt = this.teams[team];
    const field = this.teamBros(team).filter((b) => b.role === 'FIELD');
    const taker = field.sort((a, b) => b.home.x - a.home.x)[0];
    taker.teleport(-kt.dir * 0.7, 0.2, kt.dir);
    this.setPiece = { kind: 'kickoff', team, pos: new Vector3(), taker, t: 0 };
    this.lastTouch = null;
    if (this.humanTeam >= 0) this.controlled = team === this.humanTeam ? taker : this.nearestField(this.humanTeam, new Vector3());
    this.emit({ type: 'setpiece', text: 'kickoff', team });
  }

  private startSetPiece(kind: SetKind, team: number, pos: Vector3) {
    const f = this.field;
    this.phase = 'setpiece';
    this.phaseT = 0;
    this.passTo = null;
    pos.y = 0;
    this.placeBall(pos);
    let taker: Bro;
    if (kind === 'goalkick') taker = this.teamBros(team).find((b) => b.role === 'GK')!;
    else if (kind === 'penalty') taker = this.teamBros(team).filter((b) => b.role === 'FIELD').sort((a, b) => b.home.x - a.home.x)[0];
    else taker = this.nearestField(team, pos);
    this.setPiece = { kind, team, pos: pos.clone(), taker, t: 0 };
    const gx = this.goalX(team);
    // taker stands behind the ball facing the play
    const aim = kind === 'throwin' ? new Vector3(pos.x + this.teams[team].dir * 8, 0, 0) : kind === 'goalkick' ? new Vector3(0, 0, 0) : new Vector3(gx, 0, 0);
    const back = pos.clone().sub(aim).setY(0).normalize();
    const tp = pos.clone().addScaledVector(back, kind === 'throwin' ? 0.3 : 0.85);
    taker.teleport(tp.x, tp.z, 1);
    taker.face.copy(back).multiplyScalar(-1);
    this.layout(kind, team, pos);
    if (this.humanTeam >= 0) {
      if (team === this.humanTeam && taker.role === 'FIELD') this.controlled = taker;
      else if (!this.controlled || this.controlled.role === 'GK') this.controlled = this.nearestField(this.humanTeam, pos);
    }
    const names: Record<SetKind, string> = { kickoff: '', throwin: 'АУТ', corner: 'УГЛОВОЙ', goalkick: 'ОТ ВОРОТ', freekick: 'ШТРАФНОЙ', penalty: 'ПЕНАЛЬТИ!' };
    this.emit({ type: 'setpiece', text: names[kind], team });
    if (kind !== 'throwin') this.emit({ type: 'whistle', strength: 1 });
    void f;
  }

  /** spots for everyone but the taker */
  private layout(kind: SetKind, team: number, pos: Vector3) {
    const f = this.field;
    const taker = this.setPiece!.taker;
    const gx = this.goalX(team);
    const inDir = -Math.sign(gx);
    const att = this.teamBros(team).filter((b) => b !== taker);
    const def = this.teamBros(1 - team);
    const spot = (x: number, z: number) => new Vector3(x, 0, z);
    for (const b of this.bros) b.spot = null;
    if (kind === 'penalty') {
      att.forEach((b, i) => (b.spot = b.role === 'GK' ? spot(-gx * 0.85, 0) : spot(gx + inDir * (f.boxDepth + 2), (i - att.length / 2) * 2.5)));
      def.forEach((b, i) => (b.spot = b.role === 'GK' ? spot(gx + inDir * 0.3, 0) : spot(gx + inDir * (f.boxDepth + 2.5), (i - def.length / 2) * 2.5 + 1.2)));
      return;
    }
    if (kind === 'corner') {
      const n = Math.min(att.length - 1, 4);
      att.forEach((b, i) => {
        if (b.role === 'GK') return;
        b.spot = i <= n ? spot(gx + inDir * this.rng.range(3, f.penaltySpot + 2), this.rng.range(-f.goalHalfW - 3, f.goalHalfW + 3)) : formationSpot(this, b);
      });
      def.forEach((b, i) => {
        if (b.role === 'GK') b.spot = spot(gx + inDir * 0.6, 0);
        else b.spot = i <= n + 1 ? spot(gx + inDir * this.rng.range(1.5, f.penaltySpot), this.rng.range(-f.goalHalfW - 2, f.goalHalfW + 2)) : formationSpot(this, b);
      });
      return;
    }
    // generic: formation, opponents keep their distance
    const minD = kind === 'throwin' ? 2.5 : f.centerRadius;
    const toGoal = new Vector3(gx - pos.x, 0, -pos.z);
    const nearGoal = kind === 'freekick' && toGoal.length() < 28;
    toGoal.normalize();
    const side = new Vector3(-toGoal.z, 0, toGoal.x);
    let wall = 0;
    for (const b of this.bros) {
      if (b === taker) continue;
      if (b.role === 'GK') continue;
      let s = formationSpot(this, b);
      if (b.team !== team) {
        if (nearGoal && wall < 3) {
          s = pos.clone().addScaledVector(toGoal, f.centerRadius).addScaledVector(side, (wall - 1) * 0.8);
          wall++;
        } else if (kind === 'goalkick' && this.inBox(team, s, 1)) {
          const og = this.ownGoalX(team);
          s.x = og - Math.sign(og) * (f.boxDepth + 2); // wait outside the area
        }
        const d = Math.hypot(s.x - pos.x, s.z - pos.z);
        if (d < minD) {
          const k = minD / (d || 1);
          s.x = pos.x + (s.x - pos.x) * k;
          s.z = pos.z + (s.z - pos.z) * k;
        }
      }
      b.spot = s;
    }
  }

  private foul(by: Bro, victim: Bro) {
    if (this.phase !== 'play') return;
    this.emit({ type: 'foul', pos: victim.position(), team: by.team });
    this.emit({ type: 'whistle', strength: 1 });
    const f = this.field;
    const p = victim.position();
    p.x = Math.max(-f.length / 2 + 1, Math.min(f.length / 2 - 1, p.x));
    p.z = Math.max(-f.width / 2 + 1, Math.min(f.width / 2 - 1, p.z));
    if (this.inBox(by.team, p)) {
      const gx = this.ownGoalX(by.team);
      this.startSetPiece('penalty', victim.team, new Vector3(gx - Math.sign(gx) * f.penaltySpot, 0, 0));
    } else this.startSetPiece('freekick', victim.team, p);
  }

  private checkBall() {
    const b = this.ballPos();
    const f = this.field;
    const R = BALL_P.radius;
    // goal
    if (Math.abs(b.x) > f.length / 2 + R && Math.abs(b.z) < f.goalHalfW && b.y < f.goalH) {
      const side = Math.sign(b.x);
      const scorer = this.teams.find((t) => t.dir === side)!;
      scorer.score++;
      this.lastGoalTeam = scorer.index;
      this.lastScorer = this.lastTouch;
      this.phase = 'goal';
      this.phaseT = 0;
      this.setPiece = null;
      this.emit({ type: 'goal', team: scorer.index, pos: b.clone() });
      return;
    }
    const lastTeam = this.lastTouch?.team ?? 0;
    // touch line -> throw-in
    if (Math.abs(b.z) > f.width / 2 + R) {
      const pos = new Vector3(Math.max(-f.length / 2 + 1, Math.min(f.length / 2 - 1, b.x)), 0, Math.sign(b.z) * (f.width / 2 + 0.25));
      this.startSetPiece('throwin', 1 - lastTeam, pos);
      return;
    }
    // goal line -> corner / goal kick
    if (Math.abs(b.x) > f.length / 2 + R) {
      const side = Math.sign(b.x);
      const defending = this.teams.find((t) => t.dir === -side)!.index;
      if (lastTeam === defending) {
        this.startSetPiece('corner', 1 - defending, new Vector3(side * (f.length / 2 - 0.5), 0, Math.sign(b.z || 1) * (f.width / 2 - 0.5)));
      } else {
        this.startSetPiece('goalkick', defending, new Vector3(side * (f.length / 2 - f.smallBoxDepth), 0, Math.sign(b.z || 1) * f.smallBoxHalfW * 0.6));
      }
    }
  }

  // ---------------- main step ----------------
  step(dt: number, input: PartyInput = NO_INPUT) {
    this.time += dt;
    this.phaseT += dt;
    this.netCd -= dt;
    this.postCd -= dt;
    this.autoSwitchCd -= dt;
    if (this.phase === 'play') this.clock += dt;
    if (this.setPiece) this.setPiece.t += dt;

    if (this.phase === 'goal' && this.phaseT > 3.5) {
      if (this.clock >= this.opts.halfLength) this.endHalf();
      else this.startKickoff(1 - this.lastGoalTeam);
    }
    if (this.phase === 'halftime' && this.phaseT > 3) {
      this.half = 2;
      this.clock = 0;
      for (const t of this.teams) t.dir *= -1;
      this.startKickoff(1 - this.firstKickoff);
    }
    if (this.phase === 'play' && this.clock >= this.opts.halfLength) this.endHalf();

    // brains: the human first (once!), then the AI for everybody else
    const human = this.controlled;
    if (human && this.humanTeam >= 0 && this.phase !== 'goal' && this.phase !== 'halftime' && this.phase !== 'over') this.human(human, input, dt);
    for (const b of this.bros) if (b !== human || this.humanTeam < 0) think(this, b, dt);
    this.prevInput = { ...input };

    // dead ball stays put until the taker plays it
    if (this.setPiece && (this.phase === 'setpiece' || this.phase === 'kickoff')) this.placeBall(this.setPiece.pos);

    for (const b of this.bros) b.step(dt, this.world);
    this.ballForces(dt);
    if (this.phase === 'play') this.dribbleAssist(dt);
    this.world.step(dt);
    if (this.phase === 'play') this.bodyCollisions();
    this.ballEvents();
    if (this.phase === 'play') this.checkBall();
  }

  private endHalf() {
    this.setPiece = null;
    this.phaseT = 0;
    this.emit({ type: 'whistle', strength: 3 });
    if (this.half === 1) {
      this.phase = 'halftime';
      this.emit({ type: 'halftime' });
    } else {
      this.phase = 'over';
      this.emit({ type: 'fulltime' });
    }
  }

  /** a dead ball was played: back to open play */
  private restart() {
    if (this.phase === 'setpiece' || this.phase === 'kickoff') {
      this.phase = 'play';
      this.phaseT = 0;
      if (this.setPiece?.kind === 'kickoff') this.emit({ type: 'whistle', strength: 2 });
      this.setPiece = null;
      for (const b of this.bros) b.spot = null;
    }
  }

  // ---------------- ball ----------------
  private ballForces(dt: number) {
    const v = this.ball.linvel();
    const w = this.ball.angvel();
    const sp = Math.hypot(v.x, v.y, v.z);
    const m = this.ball.mass();
    const y = this.ball.translation().y;
    const air = y > BALL_P.radius + 0.03;
    // quadratic drag + Magnus (spin x velocity) — the curl
    let fx = -BALL_P.dragK * sp * v.x;
    let fy = -BALL_P.dragK * sp * v.y;
    let fz = -BALL_P.dragK * sp * v.z;
    if (air) {
      fx += BALL_P.magnusK * (w.y * v.z - w.z * v.y);
      fy += BALL_P.magnusK * (w.z * v.x - w.x * v.z);
      fz += BALL_P.magnusK * (w.x * v.y - w.y * v.x);
    } else {
      // rolling resistance on grass (same model as the classic game, so pass solvers match)
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0.01) {
        const a = BALL_P.rollC + BALL_P.rollLin * hs;
        const k = Math.min(hs, a * dt) / hs;
        this.ball.applyImpulse({ x: -v.x * k * m, y: 0, z: -v.z * k * m }, true);
        // keep the spin consistent with rolling, or ground friction would undo the slowdown
        const rx = v.x * (1 - k), rz = v.z * (1 - k);
        this.ball.setAngvel({ x: rz / BALL_P.radius, y: w.y * 0.98, z: -rx / BALL_P.radius }, true);
      }
    }
    this.ball.applyImpulse({ x: fx * m * dt, y: fy * m * dt, z: fz * m * dt }, true);
  }

  /**
   * Dribbling: the ball sticks in front of the bro who has it. The holder keeps it while
   * turning (wider cone + reach); others must get properly close in front to take it over.
   */
  private dribbleAssist(dt: number) {
    const bp = this.ballPos();
    if (bp.y > 0.7) {
      this.holder = null;
      return;
    }
    const bv = this.ballVel();
    let best: Bro | null = null;
    let bd = 1e9;
    for (const b of this.bros) {
      if (!b.canAct || b.kickT >= 0) continue;
      const p = b.position();
      const dx = bp.x - p.x, dz = bp.z - p.z;
      const d = Math.hypot(dx, dz);
      const front = (dx * b.face.x + dz * b.face.z) / (d || 1);
      const mine = b === this.holder;
      if (d < (mine ? 1.8 : 1.2) && front > (mine ? -0.6 : 0.15)) {
        const score = d - (mine ? 0.5 : 0);
        if (score < bd) {
          bd = score;
          best = b;
        }
      }
    }
    this.holder = best;
    if (!best) return;
    const p = best.position();
    const v = best.velocity();
    const human = best.team === this.humanTeam;
    // a touch further ahead when sprinting, like a real dribble
    const off = BRO.radius + BALL_P.radius + 0.3 + Math.min(0.35, best.speed * 0.035);
    const tx = p.x + best.face.x * off, tz = p.z + best.face.z * off;
    const k = human ? 9 : 7;
    const wantX = v.x + (tx - bp.x) * k, wantZ = v.z + (tz - bp.z) * k;
    const m = this.ball.mass();
    const blend = Math.min(1, dt * (human ? 20 : 13));
    this.ball.applyImpulse({ x: (wantX - bv.x) * m * blend, y: 0, z: (wantZ - bv.z) * m * blend }, true);
    // roll, don't slide
    const nv = this.ballVel();
    this.ball.setAngvel({ x: nv.z / BALL_P.radius, y: 0, z: -nv.x / BALL_P.radius }, true);
    this.lastTouch = best;
    if (this.passTo && best !== this.passTo && best.team === this.humanTeam) this.passTo = null;
  }

  /** the bro currently "on the ball" (ball close in front of him), if any */
  carrier(): Bro | null {
    const bp = this.ballPos();
    if (bp.y > 0.8) return null;
    let best: Bro | null = null;
    let bd = 1.4;
    for (const b of this.bros) {
      if (!b.canAct) continue;
      const d = b.position().setY(0).distanceTo(bp.clone().setY(0));
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  private ballEvents() {
    const v = this.ball.linvel();
    const y = this.ball.translation().y;
    if (this.lastBallVy < -2.2 && v.y > 0.5 && y < BALL_P.radius + 0.2) this.emit({ type: 'bounce', pos: this.ballPos(), strength: -this.lastBallVy });
    this.lastBallVy = v.y;
  }

  // ---------------- bros vs bros ----------------
  private bodyCollisions() {
    const bs = this.bros;
    const bp = this.ballPos();
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        const pa = a.position(), pb = b.position();
        const d = pa.distanceTo(pb);
        if (d > BRO.radius * 2 + 0.1) continue;
        const n = pb.clone().sub(pa).setY(0).normalize();
        const rel = a.velocity().sub(b.velocity()).dot(n); // closing speed
        // flying into an opponent instead of the ball = foul
        if (a.team !== b.team) {
          for (const [diver, victim] of [[a, b], [b, a]] as const) {
            if (diver.state === 'dive' && victim.state !== 'down' && diver.position().distanceTo(bp) > 1.6 && rel > 2) {
              victim.knockDown(1.2, n.clone().multiplyScalar((diver === a ? 1 : -1) * 120).setY(60));
              this.emit({ type: 'bonk', pos: pa.clone().lerp(pb, 0.5), strength: 8 });
              this.foul(diver, victim);
              return;
            }
          }
        }
        if (rel < 4.2) continue;
        const ia = a.speed, ib = b.speed;
        if (rel > 8.5) {
          a.knockDown(1.3);
          b.knockDown(1.3);
        } else if (ia > ib) b.knockDown(1.1, n.clone().multiplyScalar(rel * 25).setY(80));
        else a.knockDown(1.1, n.clone().multiplyScalar(-rel * 25).setY(80));
        this.emit({ type: 'bonk', pos: pa.clone().lerp(pb, 0.5), strength: rel });
      }
  }

  nearestField(team: number, p: Vector3, exclude: Bro | null = null) {
    let best: Bro | null = null;
    let bd = 1e9;
    for (const b of this.teamBros(team)) {
      if (b.role === 'GK' || b === exclude) continue;
      const d = b.position().setY(0).distanceTo(p.clone().setY(0));
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best!;
  }

  // ---------------- actions ----------------
  /**
   * Strike the ball if it is near the foot. `target` gets aim assist; ground passes use the
   * classic rolling model to arrive at a sensible speed.
   */
  kick(b: Bro, power: number, target: Vector3 | null, lift = 0.25, curl = 0, ground = false) {
    if (!b.canAct) return false;
    b.kickT = 0;
    const bp = this.ballPos();
    // dead ball: the taker shuffles round to strike it towards the target
    if (this.setPiece && this.setPiece.taker === b) {
      const d = target ? target.clone().sub(bp).setY(0) : b.face.clone();
      if (d.lengthSq() > 1e-4) {
        d.normalize();
        b.face.copy(d);
        b.teleport(bp.x - d.x * 0.75, bp.z - d.z * 0.75, 1, true);
      }
    }
    const p = b.position();
    const foot = p.clone().addScaledVector(b.face, BRO.radius + 0.1);
    foot.y = BALL_P.radius;
    if (foot.distanceTo(bp) > BRO.kickReach) return false; // whiff
    const dir = target ? target.clone().sub(bp).setY(0).normalize() : b.face.clone();
    const dist = target ? Math.hypot(target.x - bp.x, target.z - bp.z) : 20;
    // clumsiness: error grows with power and when not facing the target
    const facing = dir.dot(b.face);
    const err = this.rng.gauss() * (0.03 + power * 0.05 + (1 - facing) * 0.1);
    dir.applyAxisAngle(new Vector3(0, 1, 0), err);
    let speed: number;
    let up: number;
    if (ground) {
      // arrives at the mate's feet with a firm pace (ball already rolling, so the model is exact)
      speed = Math.min(30, groundPassSpeed(dist, 5.5 + power * 5));
      up = 0;
    } else {
      speed = 12 + power * 22;
      up = lift * speed;
    }
    this.holder = null;
    this.ball.setLinvel({ x: dir.x * speed, y: up, z: dir.z * speed }, true);
    // ground balls start rolling (no sliding loss); lofted ones get a little backspin + curl
    const roll = ground ? speed / BALL_P.radius : 6;
    this.ball.setAngvel({ x: dir.z * roll, y: curl * (25 + 25 * power), z: -dir.x * roll }, true);
    this.lastTouch = b;
    this.emit({ type: 'kick', pos: bp, strength: speed, team: b.team });
    this.restart();
    return true;
  }

  /** throw-in: from the hands, lofted towards `target` */
  throwBall(b: Bro, target: Vector3) {
    b.kickT = 0;
    const p = b.position();
    const from = p.clone().addScaledVector(b.face, 0.3).setY(1.7);
    this.ball.setTranslation({ x: from.x, y: from.y, z: from.z });
    const dx = target.x - from.x, dz = target.z - from.z;
    const dist = Math.max(3, Math.min(25, Math.hypot(dx, dz)));
    const t = 0.45 + dist * 0.035;
    const vy = (BALL_P.radius - from.y + 0.5 * 11.5 * t * t) / t;
    this.ball.setLinvel({ x: (dx / Math.hypot(dx, dz)) * (dist / t), y: vy, z: (dz / Math.hypot(dx, dz)) * (dist / t) });
    this.ball.setAngvel({ x: 0, y: 0, z: 0 });
    this.lastTouch = b;
    this.emit({ type: 'kick', pos: from, strength: 8, team: b.team });
    this.restart();
  }

  shove(b: Bro) {
    if (!b.canAct || b.shoveCd > 0) return;
    b.shoveCd = 0.8;
    b.shoveT = 0;
    const p = b.position();
    let hit: Bro | null = null;
    let hd = 1.6;
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
    const m = b.body.mass();
    b.body.applyImpulse({ x: b.face.x * m * 2.5, y: 0, z: b.face.z * m * 2.5 }, true);
    if (!hit) return;
    const push = b.face.clone().multiplyScalar(hit.body.mass() * 6).setY(hit.body.mass() * 1.5);
    const falls = hit.state === 'up' && this.rng.chance(0.55);
    if (falls) hit.knockDown(1.2, push);
    else hit.body.applyImpulse({ x: push.x, y: push.y, z: push.z }, true);
    this.emit({ type: 'shove', pos: hit.position(), strength: 6 });
    // shoulder-to-shoulder near the ball is fine; in the back or far from the ball is a foul
    if (hit.team !== b.team && this.phase === 'play') {
      const fromBehind = hit.face.dot(b.face) > 0.5;
      const offBall = hit.position().distanceTo(this.ballPos()) > 3;
      if ((fromBehind || offBall) && (falls || this.rng.chance(0.4)) && this.rng.chance(0.8)) this.foul(b, hit);
    }
  }

  // ---------------- human ----------------
  private pressed(input: PartyInput, k: keyof PartyInput) {
    return !!input[k] && !this.prevInput[k];
  }

  private switchTo(b: Bro) {
    if (this.controlled) {
      this.controlled.charging = null;
      this.controlled.kickCharge = 0;
    }
    this.controlled = b;
  }

  private human(b: Bro, input: PartyInput, dt: number) {
    // stick: right = +x, up = -z (camera looks towards -z)
    const l = Math.hypot(input.mx, input.my);
    const sx = l > 0.1 ? input.mx : 0;
    const sz = l > 0.1 ? -input.my : 0;
    b.intent.moveX = sx;
    b.intent.moveZ = sz;
    b.intent.sprint = input.sprint;
    b.intent.jump = this.pressed(input, 'jump');
    b.intent.dive = this.pressed(input, 'dive');
    const sp = this.setPiece;

    // ---- dead ball: the human takes it ----
    if (sp && sp.taker === b) {
      b.intent.moveX = b.intent.moveZ = 0;
      b.intent.jump = b.intent.dive = false;
      if (l > 0.1) b.face.set(sx, 0, sz).normalize();
      if (this.phase === 'kickoff' && this.phaseT < 0.6) return;
      this.chargeAndFire(b, input, dt, sp.kind);
      return;
    }
    if (this.phase !== 'play' && this.phase !== 'setpiece' && this.phase !== 'kickoff') return;

    // ---- switching ----
    if (this.pressed(input, 'switch')) {
      const bp = this.ballPos().addScaledVector(this.ballVel(), 0.3);
      const next = this.teamBros(b.team)
        .filter((x) => x !== b && x.role === 'FIELD')
        .sort((x, y) => x.position().distanceTo(bp) - y.position().distanceTo(bp))[0];
      if (next) this.switchTo(next);
      return;
    }
    if (this.phase !== 'play') return;
    // follow our own pass; otherwise auto-switch when someone else is much closer to a loose ball
    if (this.passTo && this.passTo !== b) {
      const pb = this.passTo.position().distanceTo(this.ballPos());
      if (pb < 4) {
        this.switchTo(this.passTo);
        this.passTo = null;
        return;
      }
    }
    if (this.autoSwitchCd <= 0 && !b.charging) {
      this.autoSwitchCd = 0.8;
      const bp = this.ballPos();
      const me = b.position().distanceTo(bp);
      const near = this.nearestField(b.team, bp);
      if (near !== b && me > 12 && near.position().distanceTo(bp) < me - 8 && l < 0.1) this.switchTo(near);
    }
    if (this.pressed(input, 'shove')) this.shove(b);
    this.chargeAndFire(b, input, dt, null);
  }

  /** charge kick / pass while held, strike on release */
  private chargeAndFire(b: Bro, input: PartyInput, dt: number, kind: SetKind | null) {
    for (const k of ['kick', 'pass'] as const) {
      if (this.pressed(input, k) && !b.charging) {
        b.charging = k;
        b.kickCharge = 0;
      }
    }
    if (!b.charging) return;
    if (input[b.charging]) {
      b.kickCharge += dt;
      return;
    }
    const power = Math.min(1, b.kickCharge / 0.8);
    const what = b.charging;
    b.charging = null;
    b.kickCharge = 0;
    if (kind === 'throwin') {
      const q = this.bestMate(b, power);
      this.throwBall(b, q ? q.position() : b.position().addScaledVector(b.face, 6 + power * 14));
      if (q) this.passTo = q;
      return;
    }
    if (what === 'kick') this.humanShot(b, power);
    else this.humanPass(b, power);
  }

  private humanShot(b: Bro, power: number) {
    const gx = this.goalX(b.team);
    const p = b.position();
    const f = this.field;
    const toGoal = new Vector3(gx - p.x, 0, -p.z);
    const dist = toGoal.length();
    const facingGoal = toGoal.normalize().dot(b.face) > 0.3;
    if (facingGoal && dist < 32) {
      // aim: the corner the stick points at, else the far post
      const lateral = b.face.z;
      const side = Math.abs(lateral) > 0.25 ? Math.sign(lateral) : -Math.sign(p.z || 1);
      const target = new Vector3(gx, 0, side * (f.goalHalfW - 0.7));
      const curl = Math.abs(p.z) > 5 ? Math.sign(p.z) * this.teams[b.team].dir * -0.6 : 0;
      const lift = 0.06 + 0.12 * power + (dist > 18 ? 0.04 : 0);
      this.kick(b, Math.max(0.35, power), target, lift, curl);
    } else this.kick(b, Math.max(0.3, power), null, 0.22);
  }

  /** teammate the human means: in the facing cone, distance chosen by pass power */
  private bestMate(b: Bro, power: number) {
    const p = b.position();
    let best: Bro | null = null;
    let bs = -1e9;
    for (const q of this.teamBros(b.team)) {
      if (q === b || q.state === 'down') continue;
      const d = q.position().sub(p).setY(0);
      const dist = d.length();
      const cos = d.normalize().dot(b.face);
      const s = cos * 3 - Math.abs(dist - (8 + power * 30)) * 0.06 - (q.role === 'GK' ? 1.5 : 0);
      if (cos > 0.2 && s > bs) {
        bs = s;
        best = q;
      }
    }
    return best;
  }

  private humanPass(b: Bro, power: number) {
    const best = this.bestMate(b, power);
    if (best) {
      const target = best.position().addScaledVector(best.velocity(), 0.6);
      const dist = target.distanceTo(b.position());
      if (dist > 28) this.kick(b, Math.min(1, dist / 45), target, 0.35); // long ball in the air
      else this.kick(b, power, target, 0, 0, true);
      if (best.team === this.humanTeam && best.role === 'FIELD') this.passTo = best;
    } else this.kick(b, Math.max(0.25, power), b.position().addScaledVector(b.face, 10 + power * 20), 0, 0, true);
  }
}
