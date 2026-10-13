import { Vector3 } from 'three';
import type { Bro } from './bro';
import type { PartyEvent, PartyWorld } from './world';

/**
 * Interactive tutorial: six short drills on the real pitch — run to the ball, pass to a team-mate,
 * shoot, win the ball back, a skill move and the ОГОНЬ fire shot. Each drill sets the players and the
 * ball up itself (no countdown), checks the world's events and resets if it goes wrong.
 */

type Action = 'pass' | 'kick' | 'skill' | 'tackle' | 'up' | 'left' | 'down' | 'right';
export interface TutorialUI {
  show(step: number, total: number, title: string, text: string): void;
  praise(text: string): void;
  finish(): void;
}

interface Drill {
  title: string;
  text: () => string;
  setup: () => void;
  /** true = done */
  check: (ev: PartyEvent[]) => boolean;
  /** true = it went wrong: set up again */
  failed?: () => boolean;
  praise: string;
}

export class Tutorial {
  private i = -1;
  private t = 0;
  private doneT = -1;
  private drills: Drill[];
  private me: Bro;
  private mate: Bro;
  private gk: Bro;
  private opp: Bro;
  private opp2: Bro;
  private myGk: Bro;
  finished = false;

  constructor(private w: PartyWorld, private ui: TutorialUI, key: (a: Action) => string) {
    const [m0, m1, m2] = w.teamBros(0);
    const [o0, o1, o2] = w.teamBros(1);
    this.myGk = m0;
    this.me = m1;
    this.mate = m2;
    this.gk = o0;
    this.opp = o1;
    this.opp2 = o2;
    const b = (s: string) => `<b>${s}</b>`;
    const move = () => (key('up') === 'W' ? 'WASD' : 'стрелках');
    this.drills = [
      {
        title: 'Беги к мячу',
        text: () => `Бегай на ${b(move())}. Подбеги к мячу — он сам прилипнет к ногам. Ты — тот, у кого жёлтое кольцо и надпись «ТЫ».`,
        setup: () => {
          this.place(this.me, -10, 3);
          this.w.placeBall(-3, -2);
        },
        check: () => !!this.w.holder && this.w.holder === this.w.controlled && this.t > 0.3,
        praise: 'Отлично! Мяч твой',
      },
      {
        title: 'Пас партнёру',
        text: () => `Нажми ${b(key('pass'))} — пас уйдёт партнёру под белым кольцом. Мяч дошёл — и ты сразу играешь за него.`,
        setup: () => {
          this.place(this.me, -6, 2);
          this.place(this.mate, 3, -5);
          this.w.placeBall(-5.3, 2);
        },
        check: (ev) => ev.some((e) => e.type === 'combo' && e.team === 0),
        failed: () => this.stopped(5),
        praise: 'Есть пас!',
      },
      {
        title: 'Удар по воротам',
        text: () => `Нажми ${b(key('kick'))} — удар. Держи кнопку дольше — сильнее. Мяч сам летит в угол ворот, подальше от вратаря.`,
        setup: () => {
          this.place(this.mate, 12, -2);
          this.w.placeBall(12.75, -2);
          this.control(this.mate);
        },
        check: (ev) => ev.some((e) => e.type === 'goal' && e.team === 0),
        failed: () => this.w.gkHold !== null || this.stopped(4),
        praise: 'ГОЛ! Красота!',
      },
      {
        title: 'Отбери мяч',
        text: () => `Соперник ведёт мяч к твоим воротам. Подбеги и нажми ${b(key('kick'))} — подкат (или ${b(key('tackle'))}).`,
        setup: () => {
          this.place(this.opp, 9, 0, -1);
          this.w.placeBall(8.3, 0);
          this.place(this.me, -5, 2);
          this.control(this.me);
          this.w.scripted.set(this.opp, (o) => {
            const p = o.position();
            o.intent = { moveX: p.x > -16 ? -0.5 : 0, moveZ: -p.z * 0.1, sprint: false, jump: false, dive: false };
          });
        },
        check: () => !!this.w.holder && this.w.holder.team === 0 && this.t > 0.5,
        failed: () => this.opp.position().x < -16 || this.stopped(6),
        praise: 'Отобрал! Шмяк!',
      },
      {
        title: 'Финт',
        text: () => `Защитник прямо перед тобой. Нажми ${b(key('skill'))} — финт! Со стрелкой вбок — уход в сторону, без неё — радуга через голову.`,
        setup: () => {
          this.place(this.me, 0, 0);
          this.w.placeBall(0.75, 0);
          this.place(this.opp, 4.2, 0, -1);
          this.control(this.me);
        },
        check: (ev) => ev.some((e) => e.type === 'skill' && e.team === 0),
        failed: () => this.stopped(8),
        praise: 'Вот это финт!',
      },
      {
        title: 'ОГОНЬ!',
        text: () =>
          `Пасы, финты и отборы заполняют шкалу ${b('ОГОНЬ')} (вверху). Сейчас она полная: следующий удар — огненный. Он сносит всех на пути, даже вратаря! Бей ${b(key('kick'))}!`,
        setup: () => {
          this.place(this.me, 6, -3);
          this.w.placeBall(6.75, -3);
          this.place(this.opp, 17, -1.5, -1);
          this.control(this.me);
          this.w.teams[0].fire = 1;
          this.w.scripted.delete(this.gk); // a real keeper this time
        },
        check: (ev) => ev.some((e) => e.type === 'goal' && e.team === 0),
        failed: () => this.w.gkHold !== null || (this.w.teams[0].fire < 1 && !this.w.fireBall && this.stopped(3)),
        praise: 'ОГОНЬ!!! Вратарь в сетке!',
      },
    ];
    // everyone not in a drill stands still
    for (const x of w.bros) w.scripted.set(x, (q) => this.idle(q));
    w.scripted.set(this.gk, (q) => this.idle(q));
    w.controlled = this.me;
    this.next();
  }

  /** a player stands where he was put, facing the ball */
  private spots = new Map<Bro, Vector3>();
  private idle(b: Bro) {
    const s = this.spots.get(b);
    const p = b.position();
    let mx = 0, mz = 0;
    if (s && Math.hypot(s.x - p.x, s.z - p.z) > 0.4) {
      mx = (s.x - p.x) * 0.5;
      mz = (s.z - p.z) * 0.5;
      const l = Math.hypot(mx, mz);
      if (l > 1) {
        mx /= l;
        mz /= l;
      }
    }
    b.intent = { moveX: mx, moveZ: mz, sprint: false, jump: false, dive: false };
    const bp = this.w.ballPos();
    if (Math.hypot(mx, mz) < 0.15) b.face.set(bp.x - p.x, 0, bp.z - p.z).normalize();
  }

  private place(b: Bro, x: number, z: number, face = 1) {
    b.teleport(x, z, face);
    this.spots.set(b, new Vector3(x, 0, z));
    if (b !== this.me && b !== this.mate) this.w.scripted.set(b, (q) => this.idle(q));
  }
  private control(b: Bro) {
    this.w.controlled = b;
    this.w.scripted.delete(b);
    for (const o of [this.me, this.mate]) if (o !== b) this.w.scripted.set(o, (q) => this.idle(q));
  }
  /** the ball has been dead for a while (or `max` seconds passed with it far away) */
  private stopped(max: number) {
    return this.t > max && this.w.ballVel().length() < 1.5 && this.w.holder === null;
  }

  private setupAll() {
    const w = this.w;
    // park the extras out of the way
    this.place(this.myGk, -24, 0);
    this.place(this.gk, 24, 0, -1);
    this.place(this.opp2, 0, 13, -1);
    if (this.i < 3) this.place(this.opp, 6, 12, -1);
    if (this.i !== 1) this.place(this.mate, -8, -11);
    this.w.scripted.set(this.mate, (q) => this.idle(q));
    this.control(this.me);
    // control only jumps by itself in the passing drill
    w.opts.autoSwitch = this.i === 1;
    this.drills[this.i].setup();
    if (this.i === 5) {
      this.place(this.opp2, 21, 1.5, -1); // a defender on the line too: the fire shot goes through him
    }
    w.skipCountdown();
    w.teams[0].fire = this.i === 5 ? 1 : 0;
    w.teams[1].fire = 0;
    this.t = 0;
  }

  private next() {
    this.i++;
    this.doneT = -1;
    if (this.i >= this.drills.length) {
      this.finished = true;
      this.ui.finish();
      return;
    }
    const d = this.drills[this.i];
    this.ui.show(this.i + 1, this.drills.length, d.title, d.text());
    this.setupAll();
  }

  /** before every world step */
  preStep(dt: number) {
    const w = this.w;
    if (this.finished) return;
    if (w.phase === 'countdown') this.setupAll();
    // no long celebrations: straight on
    if (w.phase === 'goal' && w.phaseT > 1.6) {
      w.slowmo = 0;
      for (const b of w.bros) b.celebrate = false;
      w.startCountdown();
      this.setupAll();
    }
    this.t += dt;
    if (this.doneT >= 0) {
      this.doneT += dt;
      if (this.doneT > 1.4 && w.phase === 'play') this.next();
      return;
    }
    if (w.phase === 'play' && this.drills[this.i].failed?.()) this.setupAll();
    // the keeper only plays for real in the fire drill
    if (this.i === 5) w.scripted.delete(this.gk);
  }

  /** world events of the last step */
  onEvents(ev: PartyEvent[]) {
    if (this.finished || this.doneT >= 0 || this.i < 0) return;
    if (this.drills[this.i].check(ev)) {
      this.doneT = 0;
      this.ui.praise(this.drills[this.i].praise);
    }
  }

  update(_dt: number) {
    /* per-frame hook (nothing yet) */
  }
}
