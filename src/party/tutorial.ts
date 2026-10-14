import { Vector3 } from 'three';
import type { Bro } from './bro';
import { think } from './brain';
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
  /** the drill needs the team-mate / the opponent where its setup puts them; a full ОГОНЬ meter + a real keeper */
  usesMate?: boolean;
  usesOpp?: boolean;
  fire?: boolean;
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

  private coach: boolean;
  constructor(private w: PartyWorld, private ui: TutorialUI, key: (a: Action) => string, mode: 'player' | 'captain' | 'coach' = 'player') {
    const mouseOnly = mode === 'captain';
    this.coach = mode === 'coach';
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
        text: () => mouseOnly ? `Веди ${b('мышку')} — твой игрок бежит к курсору (чем дальше курсор, тем быстрее). Подведи его к мячу — мяч прилипнет к ногам.` : `Бегай на ${b(move())}. Подбеги к мячу — он сам прилипнет к ногам. Ты — тот, у кого жёлтое кольцо и надпись «ТЫ».`,
        setup: () => {
          this.place(this.me, -10, 3);
          this.w.placeBall(-3, -2);
        },
        check: () => !!this.w.holder && this.w.holder === this.w.controlled && this.t > 0.3,
        praise: 'Отлично! Мяч твой',
      },
      {
        title: 'Пас партнёру',
        text: () => mouseOnly ? `Наведи курсор на партнёра и нажми ${b('ЛКМ')} — пас уйдёт туда, куда кликнул. Мяч дошёл — и ты играешь за него.` : `Нажми ${b(key('pass'))} — пас уйдёт партнёру под белым кольцом. Мяч дошёл — и ты сразу играешь за него.`,
        setup: () => {
          this.place(this.me, -6, 2);
          this.place(this.mate, 3, -5);
          this.w.placeBall(-5.3, 2);
        },
        check: (ev) => ev.some((e) => e.type === 'combo' && e.team === 0),
        failed: () => this.stopped(5),
        usesMate: true,
        praise: 'Есть пас!',
      },
      {
        title: 'Удар по воротам',
        text: () => mouseOnly ? `Наведи курсор в угол ворот и нажми ${b('ПКМ')} — удар туда. Держи кнопку дольше — сильнее.` : `Нажми ${b(key('kick'))} — удар. Держи кнопку дольше — сильнее. Мяч сам летит в угол ворот, подальше от вратаря.`,
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
        text: () => mouseOnly ? `Соперник ведёт мяч. Наведи курсор на него — игрок побежит следом (${b('ЛКМ')} — рывок). Рядом с ним жми ${b('ПКМ')} — подкат!` : `Соперник ведёт мяч к твоим воротам. Подбеги и нажми ${b(key('kick'))} — подкат (или ${b(key('tackle'))}).`,
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
        usesOpp: true,
        praise: 'Отобрал! Шмяк!',
      },
      {
        title: 'Финт',
        text: () => mouseOnly ? `Защитник прямо перед тобой. Нажми ${b('Пробел')} или крутани ${b('колёсико')} — финт! Курсор вбок — уход в сторону, вперёд — радуга через голову.` : `Защитник прямо перед тобой. Нажми ${b(key('skill'))} — финт! Со стрелкой вбок — уход в сторону, без неё — радуга через голову.`,
        setup: () => {
          this.place(this.me, 0, 0);
          this.w.placeBall(0.75, 0);
          this.place(this.opp, 4.2, 0, -1);
          this.control(this.me);
        },
        check: (ev) => ev.some((e) => e.type === 'skill' && e.team === 0),
        failed: () => this.stopped(8),
        usesOpp: true,
        praise: 'Вот это финт!',
      },
      {
        title: 'ОГОНЬ!',
        text: () =>
          `Пасы, финты и отборы заполняют шкалу ${b('ОГОНЬ')} (вверху). Сейчас она полная: следующий удар — огненный. Он сносит всех на пути, даже вратаря! Бей ${b(mouseOnly ? 'ПКМ' : key('kick'))}!`,
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
        usesOpp: true,
        fire: true,
        praise: 'ОГОНЬ!!! Вратарь в сетке!',
      },
    ];
    if (this.coach) this.drills = this.coachDrills(b);
    // everyone not in a drill stands still
    for (const x of w.bros) w.scripted.set(x, (q) => this.idle(q));
    w.scripted.set(this.gk, (q) => this.idle(q));
    w.controlled = this.me;
    this.next();
  }

  /** coach mode: no running yourself — click where the ball goes */
  private coachDrills(b: (s: string) => string): Drill[] {
    const goal = (ev: PartyEvent[]) => ev.some((e) => e.type === 'goal' && e.team === 0);
    return [
      {
        title: 'Пас в точку',
        text: () => `Твои игроки бегают сами, а тот, у кого мяч, ждёт команды. Кликни ${b('ЛКМ')} по партнёру под белым кольцом — пас ему. Можно кликнуть и в пустое место — пас на ход.`,
        setup: () => {
          this.place(this.me, -6, 2);
          this.place(this.mate, 3, -5);
          this.w.placeBall(-5.3, 2);
        },
        check: (ev) => ev.some((e) => e.type === 'combo' && e.team === 0),
        failed: () => this.stopped(5),
        usesMate: true,
        praise: 'Есть пас!',
      },
      {
        title: 'Удар в точку',
        text: () => `Наведи курсор в угол ворот и нажми ${b('ПКМ')}. Держи дольше — удар сильнее. Пока кнопка зажата, время замедляется — целься спокойно.`,
        setup: () => {
          this.place(this.me, 13, -2);
          this.w.placeBall(13.75, -2);
        },
        check: goal,
        failed: () => this.w.gkHold !== null || this.stopped(4),
        praise: 'ГОЛ! Красота!',
      },
      {
        title: 'Навес',
        text: () => `Партнёр ждёт в штрафной. Наведи курсор на него и нажми ${b('Пробел')} — мяч полетит верхом прямо к нему.`,
        setup: () => {
          this.place(this.me, 12, 11);
          this.w.placeBall(12.75, 11);
          this.place(this.mate, 20, -1, -1);
        },
        // a good cross: the ball drops right onto the team-mate
        check: (ev) => goal(ev) || ev.some((e) => (e.type === 'combo' || e.type === 'header') && e.team === 0) || (this.t > 0.5 && this.w.ballPos().distanceTo(this.mate.position()) < 1.8 && this.w.ballVel().length() > 2),
        failed: () => this.stopped(5),
        usesMate: true,
        praise: 'Навес что надо!',
      },
      {
        title: 'Прессинг',
        text: () => `Мяч у соперника. Наведи курсор на него и нажми ${b('ПКМ')} — твой ближний игрок побежит отбирать. А ${b('Shift + ЛКМ')} отправит партнёра в рывок в любую точку.`,
        setup: () => {
          this.place(this.opp, 9, 0, -1);
          this.w.placeBall(8.3, 0);
          this.place(this.me, -5, 2);
          this.w.scripted.set(this.opp, (o) => {
            const p = o.position();
            o.intent = { moveX: p.x > -16 ? -0.5 : 0, moveZ: -p.z * 0.1, sprint: false, jump: false, dive: false };
          });
        },
        check: () => !!this.w.holder && this.w.holder.team === 0 && this.t > 0.5,
        failed: () => this.opp.position().x < -16 || this.stopped(7),
        usesOpp: true,
        praise: 'Отобрали!',
      },
      {
        title: 'ОГОНЬ!',
        text: () =>
          `Пасы, финты и отборы заполняют шкалу ${b('ОГОНЬ')}. Сейчас она полная: следующий удар — огненный и сносит всех на пути. Кликни ${b('ПКМ')} в ворота! А тактику (схему, стиль, прессинг) меняй в меню и на паузе (${b('Esc')}).`,
        setup: () => {
          this.place(this.me, 6, -3);
          this.w.placeBall(6.75, -3);
          this.place(this.opp, 17, -1.5, -1);
        },
        check: goal,
        failed: () => this.w.gkHold !== null || (this.w.teams[0].fire < 1 && !this.w.fireBall && this.stopped(3)),
        usesOpp: true,
        fire: true,
        praise: 'ОГОНЬ!!! Вратарь в сетке!',
      },
    ];
  }

  /** our players in coach mode: stand still unless the coach sent them somewhere */
  private ours(q: Bro, dt: number) {
    if (this.w.runOrders.has(q)) think(this.w, q, dt);
    else this.idle(q);
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
    if (this.coach && b.team === 0) this.w.scripted.set(b, (q, dt) => this.ours(q, dt));
    else if (b !== this.me && b !== this.mate) this.w.scripted.set(b, (q) => this.idle(q));
  }
  private control(b: Bro) {
    this.w.controlled = b;
    if (this.coach) return;
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
    const d = this.drills[this.i];
    if (!d.usesOpp) this.place(this.opp, 6, 12, -1);
    if (!d.usesMate) this.place(this.mate, -8, -11);
    this.w.scripted.set(this.mate, this.coach ? (q, dt) => this.ours(q, dt) : (q) => this.idle(q));
    this.control(this.me);
    // control only jumps by itself in the passing drill
    w.opts.autoSwitch = !this.coach && !!d.usesMate;
    w.runOrders.clear();
    w.order = null;
    d.setup();
    if (d.fire) {
      this.place(this.opp2, 21, 1.5, -1); // a defender on the line too: the fire shot goes through him
    }
    w.skipCountdown();
    w.teams[0].fire = d.fire ? 1 : 0;
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
    if (this.drills[this.i]?.fire) w.scripted.delete(this.gk);
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
