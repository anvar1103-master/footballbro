import * as THREE from 'three';
import './golazo.css';
import { SIM_DT } from '../sim/config';
import { TEAM_PRESETS, TeamInfo } from '../sim/team';
import { Sound } from '../audio/sound';
import { CHAPTERS, LEVELS, LevelDef } from './levels';
import { Action, Actor, GH, GOAL_X, HW, Moment, SimEvent } from './sim';
import { ActorView, GolazoRenderer, Quality } from './render';

/**
 * Golazo — "draw your goal". A Score!-Hero-style football puzzle: every level is a frozen moment
 * of a match; draw the line the ball should take (to a team-mate = pass, into the goal = shot,
 * bend the line = curl). Team-mates make their runs, defenders try to cut the ball out, the
 * keeper dives. Score with style for three stars.
 */

const qs = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const el = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
};

// ------------------------------------------------------------------ progress

interface Progress {
  stars: Record<number, number>;
  best: Record<number, number>;
  soWins?: number[];
  fkBest?: number;
  muted?: boolean;
}
const SAVE_KEY = 'golazo.progress.v1';
function loadProgress(): Progress {
  try {
    const p = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '');
    if (p && typeof p === 'object' && p.stars) return p;
  } catch {
    /* empty */
  }
  return { stars: {}, best: {} };
}
function saveProgress(p: Progress) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}
const unlocked = (p: Progress, id: number) => id === 1 || (p.stars[id - 1] ?? 0) > 0 || qs.has('all');
const totalStars = (p: Progress) => Object.values(p.stars).reduce((s, v) => s + v, 0);

// ------------------------------------------------------------------ replay buffer

interface Frame {
  t: number;
  ball: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  actors: Map<number, ActorView>;
}
const snapActor = (a: Actor): ActorView => ({
  pos: a.pos.clone(), face: a.face.clone(), vel: a.vel.clone(), kickT: a.kickT, kickKind: a.kickKind, jump: a.jump, dive: a.dive, diveUp: a.diveUp, celebrate: a.celebrate,
});

// ------------------------------------------------------------------ app

type Screen = 'title' | 'map' | 'intro' | 'play' | 'result';

/** penalty shoot-out vs an AI team: you shoot, then you keep (draw where to dive) */
interface Shootout {
  diff: number;
  opp: TeamInfo;
  us: boolean[];
  them: boolean[];
  turn: 'us' | 'them';
  keeper: { t: number; ai: Action; guess: THREE.Vector2 | null; startX: number } | null;
  over: boolean;
}
const SO_DIFF = [
  { name: 'Лёгкая', gk: 0.35, aim: 0.55 },
  { name: 'Средняя', gk: 0.6, aim: 0.3 },
  { name: 'Трудная', gk: 0.85, aim: 0.12 },
];
const RUN_UP = 1.6;

/** endless free-kick challenge: 3 lives, the wall, distance and keeper grow with every goal */
interface FreeKicks {
  lives: number;
  score: number;
  goals: number;
  n: number;
  last: number;
}

class App {
  r: GolazoRenderer;
  sound = new Sound();
  progress = loadProgress();
  screen: Screen = 'title';
  ui = $('#ui');
  m: Moment | null = null;
  level: LevelDef = LEVELS[0];
  home: TeamInfo = TEAM_PRESETS[0];
  away: TeamInfo = TEAM_PRESETS[1];
  attempt = 0;
  /** failed tries on the current career level (a hint shows up after two) */
  fails = 0;
  private acc = 0;
  private last = performance.now();
  private timeScale = 1;
  // camera
  private camPos = new THREE.Vector3(10, 30, 40);
  private camLook = new THREE.Vector3(GOAL_X - 20, 0, 0);
  private camSnap = true;
  private yawOff = 0;
  private topView = false;
  private orbitT = 0;
  // input
  private stroke: { x: number; y: number }[] = [];
  private drawing = false;
  private forceLob = false;
  private pending: Action | null = null;
  private previewDirty = false;
  private canvas: HTMLCanvasElement;
  private g2: CanvasRenderingContext2D;
  // replay
  private frames: Frame[] = [];
  private replay: { i: number; t: number; side: number } | null = null;
  private resultShown = false;
  private overT = 0;
  private hud!: HTMLElement;
  private views = new Map<number, ActorView>();
  so: Shootout | null = null;
  fk: FreeKicks | null = null;

  constructor() {
    const quality = (qs.get('q') as Quality) || (matchMedia('(pointer: coarse)').matches ? 'medium' : 'high');
    this.r = new GolazoRenderer($('#game'), [this.home, this.away], quality);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gz-ink';
    $('#game').appendChild(this.canvas);
    this.g2 = this.canvas.getContext('2d')!;
    this.resizeInk();
    window.addEventListener('resize', () => this.resizeInk());
    this.sound.setMuted(!!this.progress.muted);
    this.bindInput();
    // a level in the background of the title screen
    this.loadLevel(LEVELS[0], false);
    if (qs.has('level')) {
      const L = LEVELS.find((l) => l.id === Number(qs.get('level')));
      if (L) this.startLevel(L);
      else this.showTitle();
    } else this.showTitle();
    requestAnimationFrame(() => this.frame());
  }

  // ---------------------------------------------------------------- screens

  private setUi(html: string) {
    this.ui.innerHTML = '';
    const node = el(html);
    this.ui.appendChild(node);
    return node;
  }

  showTitle() {
    this.screen = 'title';
    this.replay = null;
    const next = LEVELS.find((l) => !(this.progress.stars[l.id] > 0)) ?? LEVELS[LEVELS.length - 1];
    const node = this.setUi(`
      <div class="gz-screen gz-title">
        <div class="gz-logo">ГОЛ<span>А</span>ЗО!</div>
        <div class="gz-sub">Нарисуй свой лучший гол</div>
        <button class="gz-btn gz-big" data-go>${totalStars(this.progress) ? 'ПРОДОЛЖИТЬ' : 'ИГРАТЬ'}</button>
        <button class="gz-btn gz-ghost" data-map>Уровни · ★ ${totalStars(this.progress)}/${LEVELS.length * 3}</button>
        <button class="gz-btn gz-ghost" data-fk>Штрафные: на выживание${this.progress.fkBest ? ` · рекорд ${this.progress.fkBest}` : ''}</button>
        <div class="gz-so-pick"><span>Серия пенальти</span>${SO_DIFF.map((d, i) => `<button class="gz-btn gz-ghost" data-so="${i}">${d.name}${this.progress.soWins?.[i] ? ` · 🏆${this.progress.soWins[i]}` : ''}</button>`).join('')}</div>
        <div class="gz-how">
          <div><b>1</b>Проведи линию от мяча</div>
          <div><b>2</b>К партнёру — пас, в ворота — удар</div>
          <div><b>3</b>Изогни линию — мяч закрутится</div>
        </div>
      </div>`);
    $('[data-go]', node).onclick = () => {
      this.sound.start();
      this.startLevel(next);
    };
    $('[data-map]', node).onclick = () => {
      this.sound.start();
      this.showMap();
    };
    $('[data-fk]', node).onclick = () => {
      this.sound.start();
      this.startFreeKicks();
    };
    node.querySelectorAll<HTMLButtonElement>('[data-so]').forEach((b) => {
      b.onclick = () => {
        this.sound.start();
        this.startShootout(Number(b.dataset.so));
      };
    });
  }

  // ---------------------------------------------------------------- free-kick challenge

  startFreeKicks() {
    this.so = null;
    this.fk = { lives: 3, score: 0, goals: 0, n: 0, last: 0 };
    this.attempt = Math.floor(Math.random() * 1000);
    this.nextFreeKick();
  }

  private nextFreeKick() {
    const fk = this.fk!;
    const g = fk.goals;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const d = Math.min(33, rnd(17, 22) + g * 0.9);
    const z = (Math.random() < 0.5 ? -1 : 1) * rnd(0, Math.min(16, 4 + g * 1.2));
    const L: LevelDef = {
      id: 800 + fk.n, chapter: 0, kind: 'freekick', title: `Штрафной ${fk.n + 1}`, brief: '',
      mates: [{ at: [d, z], n: 10 }], opps: [],
      wall: Math.min(6, 3 + Math.floor(g / 2)),
      gk: Math.min(0.85, 0.35 + g * 0.05),
      stars: [900, 1200],
    };
    fk.n++;
    this.attempt++;
    this.loadLevel(L, false);
    // a bonus target in one of the top or bottom corners
    const m = this.m!;
    m.target = { z: (Math.random() < 0.5 ? -1 : 1) * rnd(2.3, 3.1), y: Math.random() < 0.6 ? rnd(1.6, 1.95) : rnd(0.45, 0.8), r: 0.55 };
    this.r.setTarget(m.target);
    this.camSnap = true;
    this.beginPlay();
  }

  private fkRecord() {
    const fk = this.fk!;
    const res = this.m!.result!;
    if (res.ok) {
      fk.goals++;
      fk.score += res.points;
      fk.last = res.points;
    } else fk.lives--;
    if (fk.lives <= 0) this.showFreeKickEnd();
    else this.nextFreeKick();
  }

  private fkHud() {
    const fk = this.fk!;
    return `<div class="gz-fk"><span class="lives">${'❤'.repeat(fk.lives)}<i>${'❤'.repeat(3 - fk.lives)}</i></span><b>${fk.score}</b><small>голов: ${fk.goals}</small></div>`;
  }

  private showFreeKickEnd() {
    const fk = this.fk!;
    this.screen = 'result';
    const best = this.progress.fkBest ?? 0;
    const record = fk.score > best;
    if (record) {
      this.progress.fkBest = fk.score;
      saveProgress(this.progress);
      this.sound.chime(4);
    }
    const node = this.setUi(`
      <div class="gz-screen gz-result ${record ? 'win' : 'lose'}">
        <div class="gz-card">
          <h1>${record ? 'НОВЫЙ РЕКОРД!' : 'КОНЕЦ СЕРИИ'}</h1>
          <div class="gz-points">${fk.score} <small>очков</small></div>
          <p class="why">Голов: ${fk.goals}. ${record ? '' : `Рекорд: ${best}.`} Бей в мишени — за них +500.</p>
          <div class="gz-row"><button class="gz-btn gz-big" data-again>↻ ЕЩЁ РАЗ</button></div>
          <button class="gz-link" data-menu>В меню</button>
        </div>
      </div>`);
    $('[data-again]', node).onclick = () => this.startFreeKicks();
    $('[data-menu]', node).onclick = () => {
      this.fk = null;
      this.showTitle();
    };
  }

  // ---------------------------------------------------------------- penalty shoot-out

  startShootout(diff: number) {
    this.fk = null;
    const opps = TEAM_PRESETS.filter((t) => t !== this.home && t.short !== 'SUN');
    this.so = { diff, opp: opps[Math.floor(Math.random() * opps.length)], us: [], them: [], turn: 'us', keeper: null, over: false };
    this.attempt = Math.floor(Math.random() * 1000);
    this.nextKick();
  }

  private soLevel(): LevelDef {
    const so = this.so!;
    const n = so.us.length + so.them.length;
    return {
      id: 900 + n, chapter: 0, kind: 'penalty', title: 'Серия пенальти', brief: '',
      mates: [{ at: [11, 0], n: [9, 10, 7, 11, 8, 4, 5, 6, 3, 2][Math.floor(n / 2) % 10] }],
      opps: [], gk: SO_DIFF[so.diff].gk, stars: [650, 800],
    };
  }

  /** who has won (or null while it is still open); 5 each, then sudden death */
  private soWinner(): 'us' | 'them' | null {
    const so = this.so!;
    const a = so.us.filter(Boolean).length, b = so.them.filter(Boolean).length;
    const na = so.us.length, nb = so.them.length;
    if (na <= 5 && nb <= 5) {
      if (a + (5 - na) < b) return 'them';
      if (b + (5 - nb) < a) return 'us';
      if (na === 5 && nb === 5 && a !== b) return a > b ? 'us' : 'them';
      return null;
    }
    if (na === nb && a !== b) return a > b ? 'us' : 'them';
    return null;
  }

  private nextKick() {
    const so = this.so!;
    const w = this.soWinner();
    if (w || so.us.length >= 15) {
      this.showShootoutEnd(w ?? 'them');
      return;
    }
    so.turn = so.us.length <= so.them.length ? 'us' : 'them';
    this.attempt++;
    this.loadLevel(this.soLevel(), false);
    const m = this.m!;
    if (so.turn === 'them') {
      // their kicker, our keeper
      m.userKeeper = true;
      this.r.setActors(m, so.opp, this.home);
      const d = SO_DIFF[so.diff];
      const side = Math.random() < 0.5 ? -1 : 1;
      const centre = Math.random() < 0.12;
      const z = centre ? (Math.random() - 0.5) * 1.6 : side * (1.5 + Math.random() * 2.1);
      const y = 0.25 + Math.random() * 2.0;
      const err = d.aim;
      const ai: Action = {
        type: 'shot',
        target: new THREE.Vector3(GOAL_X, Math.max(0.15, y + (Math.random() - 0.5) * err * 1.4), z + (Math.random() - 0.5) * err * 2),
        curl: (Math.random() - 0.5) * 0.5,
      };
      const h = m.holder!;
      so.keeper = { t: 0, ai, guess: null, startX: h.pos.x - 3.2 };
      h.pos.x = so.keeper.startX;
      this.r.showRuns(null);
    } else so.keeper = null;
    this.camSnap = true;
    this.beginPlay();
  }

  private soRecord() {
    const so = this.so!;
    const goal = !!this.m?.result?.ok;
    if (so.turn === 'us') so.us.push(goal);
    else so.them.push(goal);
    this.nextKick();
  }

  private soDots() {
    const so = this.so!;
    const row = (arr: boolean[], team: TeamInfo) => {
      const n = Math.max(5, arr.length);
      let h = `<i class="kit" style="background:${team.primary};color:${ink(team.primary)}">${team.short}</i>`;
      for (let k = 0; k < n; k++) h += `<b class="${k < arr.length ? (arr[k] ? 'g' : 'x') : ''}"></b>`;
      return `<div>${h}</div>`;
    };
    return `<div class="gz-so">${row(so.us, this.home)}${row(so.them, so.opp)}</div>`;
  }

  private showShootoutEnd(w: 'us' | 'them') {
    const so = this.so!;
    so.over = true;
    this.screen = 'result';
    if (w === 'us') {
      const wins = (this.progress.soWins ??= [0, 0, 0]);
      wins[so.diff] = (wins[so.diff] ?? 0) + 1;
      saveProgress(this.progress);
      this.sound.chime(4);
      this.sound.crowdReact('goal');
    } else this.sound.crowdReact('ooh');
    const a = so.us.filter(Boolean).length, b = so.them.filter(Boolean).length;
    const node = this.setUi(`
      <div class="gz-screen gz-result ${w === 'us' ? 'win' : 'lose'}">
        <div class="gz-card">
          <h1>${w === 'us' ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ'}</h1>
          <div class="gz-points">${a} : ${b}</div>
          ${this.soDots()}
          <p class="why">${w === 'us' ? `Кубок твой! Сложность: ${SO_DIFF[so.diff].name.toLowerCase()}.` : 'В следующий раз прыгай раньше — и бей в самые углы.'}</p>
          <div class="gz-row">
            <button class="gz-btn gz-big" data-again>↻ ЕЩЁ СЕРИЮ</button>
          </div>
          <button class="gz-link" data-menu>В меню</button>
        </div>
      </div>`);
    $('[data-again]', node).onclick = () => this.startShootout(so.diff);
    $('[data-menu]', node).onclick = () => {
      this.so = null;
      this.showTitle();
    };
  }

  showMap() {
    this.screen = 'map';
    this.so = null;
    this.fk = null;
    const p = this.progress;
    let html = `<div class="gz-screen gz-map"><div class="gz-maphead"><button class="gz-icon" data-back>‹</button><h1>Карьера</h1><div class="gz-total">★ ${totalStars(p)}/${LEVELS.length * 3}</div></div><div class="gz-chapters">`;
    CHAPTERS.forEach((name, ci) => {
      const ls = LEVELS.filter((l) => l.chapter === ci);
      if (!ls.length) return;
      html += `<div class="gz-chapter"><h2>${name}</h2><div class="gz-grid">`;
      for (const l of ls) {
        const st = p.stars[l.id] ?? 0;
        const open = unlocked(p, l.id);
        html += `<button class="gz-tile ${open ? '' : 'locked'} ${st ? 'done' : ''}" data-level="${l.id}" ${open ? '' : 'disabled'}>
          <span class="n">${open ? l.id : '🔒'}</span><span class="t">${l.title}</span>
          <span class="s">${[1, 2, 3].map((i) => `<i class="${i <= st ? 'on' : ''}">★</i>`).join('')}</span></button>`;
      }
      html += `</div></div>`;
    });
    html += `</div></div>`;
    const node = this.setUi(html);
    $('[data-back]', node).onclick = () => this.showTitle();
    node.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((b) => {
      b.onclick = () => this.startLevel(LEVELS.find((l) => l.id === Number(b.dataset.level))!);
    });
  }

  startLevel(L: LevelDef) {
    this.sound.start();
    if (L.id !== this.level.id) this.fails = 0;
    this.so = null;
    this.fk = null;
    this.attempt = 0;
    this.loadLevel(L, true);
    this.screen = 'intro';
    const sc = L.score ?? [0, 0];
    const kindLabel = { open: 'Атака', freekick: 'Штрафной', penalty: 'Пенальти', corner: 'Угловой' }[L.kind];
    const best = this.progress.best[L.id];
    const node = this.setUi(`
      <div class="gz-screen gz-intro">
        <div class="gz-card">
          <div class="gz-ctx"><span class="min">${L.minute ?? 90}'</span><span class="sc"><i style="--c:${this.home.primary};color:${ink(this.home.primary)}">${this.home.short}</i>${sc[0]} : ${sc[1]}<i style="--c:${this.away.primary};color:${ink(this.away.primary)}">${this.away.short}</i></span><span class="kind">${kindLabel}</span></div>
          <div class="gz-lvl">Уровень ${L.id}</div>
          <h1>${L.title}</h1>
          <p>${L.brief}</p>
          ${L.tip ? `<p class="tip">💡 ${L.tip}</p>` : ''}
          <div class="gz-goals"><span>★ гол</span><span>★★ ${L.stars[0]}</span><span>★★★ ${L.stars[1]}</span>${best ? `<span class="best">рекорд ${best}</span>` : ''}</div>
          <button class="gz-btn gz-big" data-go>ВПЕРЁД!</button>
        </div>
      </div>`);
    $('[data-go]', node).onclick = () => this.beginPlay();
  }

  private loadLevel(L: LevelDef, fresh: boolean) {
    this.level = L;
    this.away = this.so ? this.so.opp : TEAM_PRESETS[[1, 4, 6, 5, 7, 2][L.id % 6]];
    this.m = new Moment(L, 1 + this.attempt);
    this.r.setActors(this.m, this.home, this.away);
    this.r.showRuns(this.m);
    this.r.setPreview(null, null, null);
    this.r.setTarget(null);
    this.frames = [];
    this.replay = null;
    this.resultShown = false;
    this.replayDone = false;
    this.timeScale = 1;
    this.yawOff = 0;
    this.topView = false;
    if (fresh) this.camSnap = false;
    this.clearInk();
  }

  beginPlay() {
    this.screen = 'play';
    this.hud = this.setUi(`
      <div class="gz-hud">
        <div class="gz-top">
          ${this.so ? this.soDots() : this.fk ? this.fkHud() : `<div class="gz-badge"><b>${this.level.id}</b>${this.level.title}</div>`}
          <div class="gz-tools">
            <button class="gz-icon" data-restart title="Заново (R)">↻</button>
            <button class="gz-icon" data-mute title="Звук (M)">${this.sound.muted ? '🔇' : '🔊'}</button>
            <button class="gz-icon" data-menu title="Меню (Esc)">☰</button>
          </div>
        </div>
        <div class="gz-hint" data-hint></div>
        <div class="gz-cam">
          <button class="gz-icon" data-rotl>⟲</button>
          <button class="gz-icon" data-top title="Вид сверху (C)">◎</button>
          <button class="gz-icon" data-rotr>⟳</button>
        </div>
        <button class="gz-lob" data-lob title="Навес (Пробел)">⤴ НАВЕС</button>
        <button class="gz-hintbtn" data-hintbtn hidden>💡 Подсказка</button>
        <div class="gz-finger" data-finger hidden><i></i></div>
        <div class="gz-banner" data-banner></div>
        <div class="gz-toast" data-toast></div>
      </div>`);
    $('[data-restart]', this.hud).onclick = () => (this.so ? this.startShootout(this.so.diff) : this.fk ? this.startFreeKicks() : this.restart());
    $('[data-menu]', this.hud).onclick = () => (this.so || this.fk ? ((this.so = null), (this.fk = null), this.showTitle()) : this.showMap());
    if (this.so || this.fk) for (const sel of ['.gz-cam', '[data-lob]']) ($(sel, this.hud) as HTMLElement).style.display = 'none';
    $('[data-mute]', this.hud).onclick = (e) => {
      this.toggleMute();
      (e.currentTarget as HTMLElement).textContent = this.sound.muted ? '🔇' : '🔊';
    };
    const hold = (sel: string, d: number) => {
      const b = $(sel, this.hud);
      b.onpointerdown = (e) => {
        e.stopPropagation();
        this.yawOff += d;
      };
    };
    hold('[data-rotl]', 0.35);
    hold('[data-rotr]', -0.35);
    $('[data-top]', this.hud).onclick = () => (this.topView = !this.topView);
    $('[data-lob]', this.hud).onclick = () => this.setLob(!this.forceLob);
    this.setLob(false);
    this.updateHint();
    this.sound.whistle(1);
    // first levels: a finger shows the swipe from the ball
    this.demoT = (this.level.id === 1 || this.level.id === 3) && !this.so && !this.fk && !(this.progress.stars[this.level.id] > 0) ? 0 : -1;
    const hb = $('[data-hintbtn]', this.hud);
    hb.hidden = !(this.level.hint && this.fails >= 2 && !this.so && !this.fk);
    hb.onclick = () => {
      this.showHint();
      hb.hidden = true;
    };
    if (this.so) this.banner(this.so.turn === 'us' ? 'ТВОЙ УДАР' : 'ТЫ В ВОРОТАХ', '', this.so.turn === 'us' ? '#ffd23f' : '#6fe3ff');
  }

  /** ghost line of a first move that works (found offline by the solver bot) */
  private showHint() {
    const m = this.m;
    const h = this.level.hint;
    if (!m || !h || m.kicks > 0 || m.phase !== 'aim') return;
    const a: Action =
      h[0] === 'shot'
        ? { type: 'shot', target: new THREE.Vector3(GOAL_X, h[2], h[1]), curl: h[3] }
        : { type: h[0], target: new THREE.Vector3(GOAL_X - h[1], 0, h[2]), curl: 0 };
    this.r.setPreview(m.preview(a), a.type, a.type === 'shot' ? null : m.pickReceiver(a.target, a.type === 'lob'));
    this.toast('Вот так — попробуй!');
  }

  private setLob(v: boolean) {
    this.forceLob = v;
    this.hud?.querySelector('[data-lob]')?.classList.toggle('on', v);
    this.previewDirty = true;
  }

  restart() {
    if (!this.m) return;
    this.attempt++;
    this.loadLevel(this.level, false);
    this.camSnap = true;
    if (this.screen !== 'play') this.beginPlay();
    else this.updateHint();
  }

  private toggleMute() {
    this.sound.setMuted(!this.sound.muted);
    this.progress.muted = this.sound.muted;
    saveProgress(this.progress);
  }

  private updateHint() {
    const h = this.hud?.querySelector('[data-hint]') as HTMLElement | null;
    const m = this.m;
    if (!h || !m) return;
    let t = '';
    if (this.so?.turn === 'them') t = m.phase === 'aim' ? (this.so.keeper?.guess ? '<b>Прыжок выбран!</b>' : 'Проведи линию <b>туда, куда прыгнуть</b> — пока он разбегается!') : '';
    else if (m.phase === 'aim') {
      if (m.touch === 'header') t = 'Мяч летит на голову — <b>рисуй удар головой!</b>';
      else if (m.touch === 'volley') t = 'Мяч в воздухе — <b>бей с лёта!</b>';
      else if (m.kicks === 0) t = this.level.kind === 'open' || this.level.kind === 'corner' ? 'Проведи линию от мяча: <b>к партнёру — пас</b>, <b>в ворота — удар</b>' : 'Проведи линию от мяча <b>в ворота</b>. Изогни — закрутишь';
      else t = '<b>Твой ход!</b> Пас или удар';
    }
    h.innerHTML = t;
    h.style.opacity = t ? '1' : '0';
    const lob = this.hud?.querySelector('[data-lob]') as HTMLElement | null;
    if (lob) lob.style.display = !this.so && m.phase === 'aim' && (this.level.kind === 'open' || this.level.kind === 'corner') ? '' : 'none';
  }

  private banner(text: string, sub = '', color = '#ffd23f') {
    const b = this.hud?.querySelector('[data-banner]') as HTMLElement | null;
    if (!b) return;
    b.innerHTML = `<span style="--c:${color}">${text}</span>${sub ? `<small>${sub}</small>` : ''}`;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }

  private toast(text: string) {
    const b = this.hud?.querySelector('[data-toast]') as HTMLElement | null;
    if (!b) return;
    b.textContent = text;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout((b as unknown as { _t: number })._t);
    (b as unknown as { _t: number })._t = window.setTimeout(() => b.classList.remove('show'), 1100);
  }

  showResult() {
    const m = this.m!;
    const res = m.result!;
    this.resultShown = true;
    this.screen = 'result';
    const L = this.level;
    const prevStars = this.progress.stars[L.id] ?? 0;
    if (!res.ok) this.fails++;
    if (res.ok) {
      this.progress.stars[L.id] = Math.max(prevStars, res.stars);
      this.progress.best[L.id] = Math.max(this.progress.best[L.id] ?? 0, res.points);
      saveProgress(this.progress);
    }
    const next = LEVELS.find((l) => l.id === L.id + 1);
    const rows = res.bonuses.map((b, i) => `<div class="row" style="animation-delay:${0.25 + i * 0.18}s"><span>${b.label}</span><b>+${b.pts}</b></div>`).join('');
    const node = this.setUi(`
      <div class="gz-screen gz-result ${res.ok ? 'win' : 'lose'}">
        <div class="gz-card">
          <h1>${res.ok ? (res.stars === 3 ? 'ГОЛАЗО!' : 'ГОЛ!') : res.reason}</h1>
          ${res.ok ? `<div class="gz-stars">${[1, 2, 3].map((i) => `<i class="${i <= res.stars ? 'on' : ''}" style="animation-delay:${0.3 + i * 0.25}s">★</i>`).join('')}</div>
          <div class="gz-bonus">${rows}</div>
          <div class="gz-points">${res.points} <small>очков</small></div>
          ${res.stars < 3 ? `<div class="gz-need">★★★ — от ${L.stars[1]}</div>` : ''}` : `<p class="why">${failTip(res.reason)}</p>`}
          <div class="gz-row">
            <button class="gz-btn ${res.ok ? 'gz-ghost' : 'gz-big'}" data-retry>↻ ЕЩЁ РАЗ</button>
            ${res.ok && next ? `<button class="gz-btn gz-big" data-next>ДАЛЬШЕ ›</button>` : ''}
          </div>
          <button class="gz-link" data-map>Все уровни</button>
        </div>
      </div>`);
    $('[data-retry]', node).onclick = () => this.restart();
    $('[data-map]', node).onclick = () => this.showMap();
    const nb = node.querySelector('[data-next]') as HTMLElement | null;
    if (nb && next) nb.onclick = () => this.startLevel(next);
    if (res.ok) this.sound.chime(res.stars + 1);
  }

  // ---------------------------------------------------------------- input

  private resizeInk() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = innerWidth * dpr;
    this.canvas.height = innerHeight * dpr;
    this.g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private clearInk() {
    this.g2.clearRect(0, 0, innerWidth, innerHeight);
  }

  private bindInput() {
    const c = this.r.renderer.domElement;
    const canDraw = () => this.screen === 'play' && this.m?.phase === 'aim';
    c.addEventListener('pointerdown', (e) => {
      this.sound.start();
      if (this.replay) {
        this.replay = null;
        return;
      }
      if (!canDraw() || e.button === 2) return;
      c.setPointerCapture(e.pointerId);
      this.drawing = true;
      if (this.so?.turn === 'them') {
        if (this.so.keeper?.guess) {
          this.drawing = false;
          return;
        }
        this.stroke = [{ x: e.clientX, y: e.clientY }];
        this.previewDirty = true;
        return;
      }
      // the line always starts at the ball (a press near it starts right there)
      const b = this.r.project(this.m!.ball.pos);
      const d = Math.hypot(e.clientX - b.x, e.clientY - b.y);
      this.stroke = d < 70 ? [{ x: e.clientX, y: e.clientY }] : [{ x: b.x, y: b.y }, { x: e.clientX, y: e.clientY }];
      this.previewDirty = true;
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drawing) return;
      const lp = this.stroke[this.stroke.length - 1];
      if (Math.hypot(e.clientX - lp.x, e.clientY - lp.y) < 4) return;
      this.stroke.push({ x: e.clientX, y: e.clientY });
      this.previewDirty = true;
    });
    const end = () => {
      if (!this.drawing) return;
      this.drawing = false;
      this.computeAction();
      const a = this.pending;
      const len = this.strokeLen();
      this.pending = null;
      this.r.setPreview(null, null, null);
      const kp = this.so?.keeper;
      if (this.so?.turn === 'them' && kp) {
        // the keeper's dive: where the line ends on the goal
        if (a && a.type === 'shot' && len > 20) {
          kp.guess = new THREE.Vector2(Math.max(-HW - 0.2, Math.min(HW + 0.2, a.target.z)), Math.max(0.2, Math.min(GH + 0.1, a.target.y)));
          this.r.markGoal(new THREE.Vector3(GOAL_X, kp.guess.y, kp.guess.x));
          this.sound.whoosh();
          this.inkFade = 1;
          this.updateHint();
        } else this.clearInk();
        return;
      }
      if (a && len > 28 && canDraw()) {
        this.m!.act(a.type === 'pass' ? this.smartPass(a).a : a);
        this.r.showRuns(null);
        this.inkFade = 1;
        this.updateHint();
      } else this.clearInk();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', () => {
      this.drawing = false;
      this.pending = null;
      this.r.setPreview(null, null, null);
      this.clearInk();
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (this.replay && this.screen === 'play') {
        this.replay = null;
        return;
      }
      if (k === 'r' || k === 'к') this.so ? this.startShootout(this.so.diff) : this.fk ? this.startFreeKicks() : this.restart();
      else if (k === 'escape') this.screen === 'play' || this.screen === 'result' ? this.showMap() : this.screen === 'map' && this.showTitle();
      else if (k === 'm' || k === 'ь') this.toggleMute();
      else if (k === ' ' && this.screen === 'play') {
        e.preventDefault();
        this.setLob(!this.forceLob);
      } else if ((k === 'c' || k === 'с') && this.screen === 'play') this.topView = !this.topView;
      else if (k === 'arrowleft' || k === 'a' || k === 'ф') this.yawOff += 0.3;
      else if (k === 'arrowright' || k === 'd' || k === 'в') this.yawOff -= 0.3;
      else if (k === 'enter' && this.screen === 'intro') this.beginPlay();
    });
  }

  private inkFade = 0;

  private strokeLen() {
    let l = 0;
    for (let i = 1; i < this.stroke.length; i++) l += Math.hypot(this.stroke[i].x - this.stroke[i - 1].x, this.stroke[i].y - this.stroke[i - 1].y);
    return l;
  }

  /** Turn the drawn stroke into a kick: end point → target (goal plane = shot, grass = pass), bend → curl. */
  private computeAction() {
    const m = this.m;
    this.pending = null;
    if (!m || this.stroke.length < 2) return;
    const E = this.stroke[this.stroke.length - 1];
    const ray = this.r.ray(E.x, E.y);
    const o = ray.origin, d = ray.direction;
    let shot: THREE.Vector3 | null = null;
    let ground: THREE.Vector3 | null = null;
    const tg = Math.abs(d.x) > 1e-4 ? (GOAL_X - o.x) / d.x : -1;
    const t0 = d.y < -1e-4 ? -o.y / d.y : -1;
    if (tg > 0) {
      const P = o.clone().addScaledVector(d, tg);
      if (P.y >= 0 && (t0 < 0 || tg <= t0) && Math.abs(P.z) < HW + 5 && P.y < GH + 4) shot = new THREE.Vector3(GOAL_X, Math.max(0.12, P.y), P.z);
    }
    if (!shot && t0 > 0) {
      const G = o.clone().addScaledVector(d, t0);
      if (G.x < GOAL_X - 0.2 && o.x < GOAL_X) ground = new THREE.Vector3(G.x, 0, Math.max(-33.5, Math.min(33.5, G.z)));
      else if (Math.abs(G.z) < HW + 3) shot = new THREE.Vector3(GOAL_X, 0.12, G.z);
    }
    // bend of the stroke relative to the chord (screen space)
    const S = this.stroke[0];
    const cx = E.x - S.x, cy = E.y - S.y;
    const L = Math.hypot(cx, cy) || 1;
    const px = -cy / L, py = cx / L;
    let dev = 0;
    for (const p of this.stroke) {
      const v = (p.x - S.x) * px + (p.y - S.y) * py;
      if (Math.abs(v) > Math.abs(dev)) dev = v;
    }
    const ratio = dev / L;
    // the ball bends much less on screen than people draw: a clearly bent line (≈ 20 % of its length) = full curl
    let curl = Math.abs(ratio) < 0.03 ? 0 : Math.max(-1, Math.min(1, -Math.sign(ratio) * (Math.abs(ratio) - 0.03) * 5.5));
    curl = Math.round(curl * 20) / 20;
    if (shot) this.pending = { type: 'shot', target: shot, curl };
    else if (ground) this.pending = { type: this.forceLob || m.autoLob(ground) ? 'lob' : 'pass', target: ground, curl: this.forceLob ? curl : 0 };
  }

  /** Play the pass out on a copy of the moment; a ground pass that would be cut out goes in the air if that works. */
  private smartPass(a: Action): { a: Action; danger: THREE.Vector3 | null } {
    const m = this.m!;
    const probe = (act: Action) => {
      const c = m.clone();
      c.act(act);
      let g = 0;
      while ((c.phase === 'windup' || c.phase === 'fly') && g++ < 1200) c.step();
      if (!c.result || c.result.ok) return null;
      const e = c.events.find((ev) => ev.type === 'intercept' || ev.type === 'catch' || ev.type === 'block');
      return e?.pos?.clone() ?? c.ball.pos.clone();
    };
    const danger = probe(a);
    if (danger && a.type === 'pass' && !this.forceLob) {
      const lob: Action = { ...a, type: 'lob' };
      if (!probe(lob)) return { a: lob, danger: null };
    }
    return { a, danger };
  }

  private drawInk(dt: number) {
    const g = this.g2;
    if (this.drawing) {
      g.clearRect(0, 0, innerWidth, innerHeight);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const pts = this.stroke;
      for (const [w, col] of [[12, 'rgba(20,10,40,0.35)'], [6, this.pending?.type === 'shot' ? '#ffd23f' : '#ffffff']] as const) {
        g.lineWidth = w;
        g.strokeStyle = col;
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.stroke();
      }
    } else if (this.inkFade > 0) {
      this.inkFade = Math.max(0, this.inkFade - dt * 3);
      g.clearRect(0, 0, innerWidth, innerHeight);
      if (this.inkFade > 0) {
        g.globalAlpha = this.inkFade;
        g.lineWidth = 6;
        g.strokeStyle = '#ffffff';
        g.beginPath();
        this.stroke.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.stroke();
        g.globalAlpha = 1;
      }
    }
  }

  // ---------------------------------------------------------------- loop

  private frame() {
    requestAnimationFrame(() => this.frame());
    const now = performance.now();
    let dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const speed = Number(qs.get('speed') ?? 1);
    dt *= speed;
    const m = this.m;
    if (!m) return;

    if (this.previewDirty && this.drawing && this.so?.turn === 'them') {
      this.previewDirty = false;
      this.computeAction();
      const a = this.pending;
      this.r.markGoal(a && a.type === 'shot' ? new THREE.Vector3(GOAL_X, a.target.y, a.target.z) : null);
    } else if (this.previewDirty && this.drawing) {
      this.previewDirty = false;
      this.computeAction();
      let a = this.pending;
      if (a) {
        const sp = a.type === 'shot' ? { a, danger: null } : this.smartPass(a);
        a = sp.a;
        this.pending = a;
        let path = m.preview(a);
        const danger = sp.danger;
        if (danger) {
          const cut = path.findIndex((p) => Math.hypot(p.x - danger.x, p.z - danger.z) < 0.9);
          if (cut > 1) path = path.slice(0, cut + 1);
        }
        this.r.setPreview(path, a.type, a.type === 'shot' ? null : m.pickReceiver(a.target, a.type === 'lob'), danger);
      } else this.r.setPreview(null, null, null);
    }
    this.drawInk(dt);

    if (this.replay) {
      this.stepReplay(dt);
      return;
    }

    // shoot-out, their kick: the run-up, then the shot (our dive is whatever was drawn by then)
    const kp = this.so?.turn === 'them' && this.screen === 'play' ? this.so.keeper : null;
    if (kp && m.phase === 'aim') {
      kp.t += dt;
      const h = m.holder!;
      const k = Math.min(1, kp.t / RUN_UP);
      h.pos.x = kp.startX + (m.ball.pos.x - 0.55 - kp.startX) * k;
      h.vel.set(k < 1 ? 3.2 / RUN_UP * 1.4 : 0, 0, 0);
      if (kp.t >= RUN_UP) {
        m.userGuess = kp.guess;
        m.act(kp.ai);
        this.drawing = false;
        this.clearInk();
        this.updateHint();
      }
    }

    // slow motion near the goal on shots
    const b = m.ball;
    const shotNear = m.phase === 'fly' && m.lastAction?.type === 'shot' && GOAL_X - b.pos.x < 10 && b.vel.x > 5;
    const target = shotNear || (m.phase === 'over' && m.overT < 0.35 && m.result?.ok) ? 0.32 : 1;
    this.timeScale += (target - this.timeScale) * Math.min(1, dt * (target < this.timeScale ? 12 : 3));
    const live = this.screen === 'play' || this.screen === 'result';
    if (live && (m.phase !== 'aim')) {
      this.acc += dt * this.timeScale;
      let n = 0;
      while (this.acc >= SIM_DT && n++ < 40) {
        this.acc -= SIM_DT;
        m.step();
        if ((m.phase as string) === 'aim') {
          this.acc = 0;
          break;
        }
      }
      this.handleEvents(m.events.splice(0));
    } else {
      m.step(0); // keep anim timers sane
      this.acc = 0;
    }
    if (m.phase === 'fly' || m.phase === 'windup' || m.phase === 'over') this.record();

    if ((this.so || this.fk) && m.phase === 'over' && this.screen === 'play') {
      this.overT += dt;
      if (m.overT > (this.fk && m.result?.ok ? 2.3 : 1.7) && !this.resultShown) {
        this.resultShown = true;
        if (this.so) this.soRecord();
        else this.fkRecord();
        return;
      }
    } else if (m.phase === 'over' && this.screen === 'play' && !this.resultShown) {
      this.overT += dt;
      const res = m.result!;
      if (res.ok && m.overT > 2.4 && this.frames.length > 30 && !this.replayDone) {
        this.startReplay();
        return;
      }
      if (m.overT > (res.ok ? 3.2 : 1.6)) this.showResult();
    } else this.overT = 0;

    this.updateCamera(dt);
    this.updateDemo(dt);
    this.r.netFade = this.so?.turn === 'them' ? 0.22 : 1;
    for (const a of m.actors) this.views.set(a.id, liveView(a));
    this.r.draw(this.views, b, dt, m.phase === 'aim' && m.holder ? liveView(m.holder) : null);
  }

  private replayDone = false;
  private demoT = -1;

  /** animated finger: ball → goal corner (level 1) or → the team-mate (level 3) */
  private updateDemo(dt: number) {
    const f = this.hud?.querySelector('[data-finger]') as HTMLElement | null;
    const m = this.m;
    if (!f || !m) return;
    if (this.demoT < 0 || this.drawing || m.phase !== 'aim' || m.kicks > 0 || this.screen !== 'play') {
      f.hidden = true;
      if (this.drawing) this.demoT = -1;
      return;
    }
    this.demoT += dt;
    const a = this.r.project(m.ball.pos);
    const mate = m.actors.find((x) => x.team === 0 && x !== m.holder);
    const tgt = this.level.id === 3 && mate ? mate.pos : new THREE.Vector3(GOAL_X, 1.9, 2.9);
    const b = this.r.project(tgt);
    const k = Math.min(1, (this.demoT % 2.2) / 1.4);
    const e = k * k * (3 - 2 * k);
    // a little bend, like a curler
    const bend = Math.sin(e * Math.PI) * -40;
    const x = a.x + (b.x - a.x) * e + bend;
    const y = a.y + (b.y - a.y) * e;
    f.hidden = false;
    f.style.transform = `translate(${x}px, ${y}px)`;
    f.style.opacity = k >= 1 ? '0' : '1';
  }

  private record() {
    const m = this.m!;
    const actors = new Map<number, ActorView>();
    for (const a of m.actors) actors.set(a.id, snapActor(a));
    this.frames.push({ t: m.t, ball: m.ball.pos.clone(), vel: m.ball.vel.clone(), spin: m.ball.spin.clone(), actors });
    if (this.frames.length > 600) this.frames.shift();
  }

  private goalT = 0;

  private startReplay() {
    this.replayDone = true;
    // from ~2 s of game time before the goal to just after it
    const side = (this.m!.lastKickFrom.z || 1) > 0 ? -1 : 1;
    const t0 = Math.max(this.frames[0].t, this.goalT - 2.0);
    this.replay = { i: 0, t: t0, side };
    this.r.net.reset();
    this.r.ball.resetTrail();
    this.toast('ПОВТОР');
    this.hud?.classList.add('replaying');
  }

  private stepReplay(dt: number) {
    const rp = this.replay!;
    rp.t += dt * 0.45;
    while (rp.i < this.frames.length - 1 && this.frames[rp.i + 1].t <= rp.t) rp.i++;
    const f = this.frames[rp.i];
    // low camera beside the goal
    const look = f.ball;
    const pos = new THREE.Vector3(GOAL_X - 7, 1.5, rp.side * 11);
    this.r.camera.position.lerp(pos, 0.2);
    this.camLook.lerp(look, 0.25);
    this.r.camera.fov = 38;
    this.r.camera.updateProjectionMatrix();
    this.r.camera.lookAt(this.camLook);
    this.r.draw(f.actors, { pos: f.ball, vel: f.vel, spin: f.spin }, dt * 0.45, null);
    if (rp.t > this.goalT + 0.8 || rp.i >= this.frames.length - 1) {
      this.replay = null;
      this.hud?.classList.remove('replaying');
      this.r.camera.fov = this.r.baseFov();
      this.r.camera.updateProjectionMatrix();
      this.showResult();
    }
  }

  private handleEvents(evs: SimEvent[]) {
    const m = this.m!;
    for (const e of evs) {
      switch (e.type) {
        case 'kick':
          this.r.showRuns(null);
          this.sound.kick(e.strength ?? 10);
          if (e.pos) this.r.particles.grass(e.pos, (e.strength ?? 0) * 0.4);
          if ((e.strength ?? 0) > 18 || Math.abs(m.lastAction?.curl ?? 0) > 0.3) this.r.ball.boostTrail(0.45);
          this.updateHint();
          break;
        case 'bounce':
          this.sound.bounce(e.strength ?? 3);
          break;
        case 'post':
          this.sound.post(e.strength ?? 10);
          this.r.shake = 0.6;
          break;
        case 'net':
          this.sound.net(e.strength ?? 10);
          break;
        case 'receive':
          this.sound.kick(4);
          this.toast(pick(['Есть пас!', 'Принял!', 'Отлично!', 'Точно в ноги!']));
          this.r.showRuns(m);
          this.updateHint();
          break;
        case 'freeze':
          this.toast(e.text === 'header' ? 'Головой!' : 'С лёта!');
          this.r.showRuns(m);
          this.updateHint();
          break;
        case 'goal': {
          this.goalT = m.t;
          const res = m.result!;
          if (this.so?.turn === 'them') {
            this.sound.crowdReact('ooh');
            this.banner('ГОЛ', 'пропустил', '#ff6b6b');
            break;
          }
          this.sound.crowdReact('goal');
          this.sound.whistle(1);
          this.r.stadium.hype(1);
          this.r.particles.confetti(new THREE.Vector3(GOAL_X - 1, 2, e.pos?.z ?? 0), [this.home.primary, this.home.secondary, '#ffd23f', '#ffffff']);
          this.r.shake = 1;
          if (m.targetHit) this.r.burstTarget();
          const best = [...res.bonuses].sort((a, b) => b.pts - a.pts).find((b) => b.label !== 'Гол');
          this.banner(res.stars === 3 ? 'ГОЛАЗО!' : 'ГОЛ!', best?.label ?? '', res.stars === 3 ? '#ff4fa3' : '#ffd23f');
          break;
        }
        case 'save':
        case 'catch':
          this.sound.crowdReact('ooh');
          this.sound.bounce(10);
          if (this.so?.turn === 'them') {
            this.sound.crowdReact('goal');
            this.r.shake = 0.8;
            this.banner('ТАЩИШЬ!', e.type === 'save' ? 'сейв' : 'поймал', '#6fe3ff');
          } else this.banner(e.type === 'save' ? 'СЕЙВ!' : 'ПОЙМАЛ!', '', '#7fe0ff');
          break;
        case 'intercept':
        case 'block':
          this.sound.bonk(6);
          this.sound.crowdReact('ooh');
          this.banner(e.type === 'block' ? 'В СТЕНКУ!' : 'ПЕРЕХВАТ!', '', '#ff6b6b');
          break;
        case 'miss':
        case 'lost':
          this.sound.crowdReact('ooh');
          if (this.so?.turn === 'them') this.banner('МИМО!', 'повезло', '#6fe3ff');
          else this.banner(m.result?.reason.toUpperCase() ?? 'МИМО!', '', '#ff6b6b');
          break;
        case 'dive':
          this.sound.whoosh();
          break;
      }
    }
  }

  // ---------------------------------------------------------------- camera director

  private updateCamera(dt: number) {
    const m = this.m!;
    const cam = this.r.camera;
    const b = m.ball.pos;
    let pos: THREE.Vector3;
    let look: THREE.Vector3;
    let rate = 3.5;
    if (this.screen === 'title' || this.screen === 'map') {
      // slow orbit around the goal
      this.orbitT += dt * 0.06;
      const a = 2.6 + Math.sin(this.orbitT) * 0.9;
      pos = new THREE.Vector3(GOAL_X + Math.cos(a) * 30, 9 + Math.sin(this.orbitT * 1.7) * 2, Math.sin(a) * 30);
      look = new THREE.Vector3(GOAL_X - 8, 1.5, 0);
      rate = 1.5;
    } else if (this.screen === 'intro') {
      // high overview of the whole moment
      const c = new THREE.Vector3();
      for (const a of m.actors) c.add(a.pos);
      c.divideScalar(m.actors.length);
      c.lerp(new THREE.Vector3(GOAL_X - 12, 0, 0), 0.35);
      // tactical view from high behind: positions and the run arrows read like a board
      const span = Math.max(...m.actors.map((a) => Math.hypot(a.pos.x - c.x, a.pos.z - c.z)));
      const h = 16 + span * 0.9;
      pos = new THREE.Vector3(c.x - h * 0.55, h, c.z * 0.85);
      look = new THREE.Vector3(c.x + 2, 0, c.z * 0.9);
      rate = 2.5;
    } else if (this.so?.turn === 'them') {
      // behind our keeper, looking through the net at the kicker
      // inside the goal, just behind and beside the keeper (under the bar)
      pos = new THREE.Vector3(GOAL_X + 1.9, 1.5, 1.1);
      look = new THREE.Vector3(GOAL_X - 11, 0.75, -0.2);
      rate = 5;
    } else if (m.phase === 'aim' || m.phase === 'windup') {
      // look at the goal, pulled a little towards the team-mates so their runs stay in frame
      const dir = new THREE.Vector3(GOAL_X - b.x, 0, -b.z * 0.65);
      if (dir.lengthSq() < 1) dir.set(1, 0, 0);
      dir.normalize();
      const pull = new THREE.Vector3();
      for (const a of m.actors) {
        if (a.team !== 0 || a === m.holder) continue;
        const run = a.runs[m.kicks];
        const p = run && run.length ? run[run.length - 1] : a.pos;
        pull.add(new THREE.Vector3(p.x - b.x, 0, p.z - b.z).normalize());
      }
      dir.addScaledVector(pull, this.r.portrait ? 0.45 : 0.25).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yawOff);
      const far = Math.min(1, Math.max(0, (GOAL_X - b.x - 12) / 30));
      if (this.topView) {
        pos = new THREE.Vector3(b.x + dir.x * 8 - dir.x * 2, 38, b.z + dir.z * 8 + 0.01);
        look = new THREE.Vector3(b.x + dir.x * 12, 0, b.z + dir.z * 12);
      } else {
        // ball in the lower part of the screen, the goal and the runs ahead visible
        const pk = this.r.portrait ? 1.45 : 1;
        const back = (7 + far * 5) * pk;
        const up = (3.2 + far * 3.3) * (this.r.portrait ? 1.7 : 1) + (m.touch !== 'feet' ? b.y * 0.8 : 0);
        pos = new THREE.Vector3(b.x - dir.x * back, up, b.z - dir.z * back);
        // over the kicker's shoulder, so he does not hide the ball
        pos.x += -dir.z * 1.3;
        pos.z += dir.x * 1.3;
        const ahead = 7 + far * 6;
        look = new THREE.Vector3(b.x + dir.x * ahead, 0.9, b.z + dir.z * ahead);
      }
      rate = 6;
      // never move the camera under the player's pen
      if (this.drawing) return;
    } else if (this.so) {
      // shoot-out: a fixed broadcast angle from behind the spot
      pos = new THREE.Vector3(GOAL_X - 19, 3.4, 0);
      look = new THREE.Vector3(GOAL_X, 1.1, 0);
      rate = 2.5;
    } else {
      // follow the flight
      const v = m.ball.vel;
      const hd = new THREE.Vector3(v.x, 0, v.z);
      if (hd.lengthSq() < 1) hd.set(1, 0, 0);
      hd.normalize();
      const shot = m.lastAction?.type === 'shot';
      if (m.phase === 'over' && m.result?.ok && m.scorer && m.overT > 0.8) {
        // celebration: follow the scorer to the corner flag
        const sc = m.scorer.pos;
        pos = new THREE.Vector3(sc.x - 7, 2.4, sc.z * 0.75);
        look = new THREE.Vector3(sc.x, 1.1, sc.z);
        rate = 2;
      } else if (m.phase === 'over' && m.result?.ok) {
        pos = cam.position.clone().lerp(new THREE.Vector3(GOAL_X - 9, 2.6, b.z * 0.5 + (cam.position.z > b.z ? 5 : -5)), 0.5);
        look = new THREE.Vector3(GOAL_X, 1.2, b.z);
        rate = 1.5;
      } else if (shot) {
        pos = new THREE.Vector3(b.x - hd.x * 6, Math.max(2.2, b.y + 1.4), b.z - hd.z * 6);
        pos.x = Math.min(pos.x, GOAL_X - 7);
        look = b.clone();
        rate = 3;
      } else {
        pos = new THREE.Vector3(b.x - hd.x * 9, 7.5, b.z - hd.z * 9);
        look = new THREE.Vector3(b.x + hd.x * 4, 0.5, b.z + hd.z * 4);
        rate = 2.2;
      }
    }
    if (this.camSnap) {
      this.camPos.copy(pos);
      this.camLook.copy(look);
      this.camSnap = false;
    } else {
      const k = 1 - Math.exp(-dt * rate);
      this.camPos.lerp(pos, k);
      this.camLook.lerp(look, k);
    }
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
  }
}

const liveView = (a: Actor): ActorView => a;

/** readable text colour on a kit colour */
function ink(hex: string) {
  const c = new THREE.Color(hex);
  return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.6 ? '#120a2e' : '#ffffff';
}

function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}

function failTip(reason: string) {
  if (reason.includes('Перехват')) return 'Защитник успел к мячу. Отдай пас подальше от него — или навесом поверх.';
  if (reason.includes('стенку')) return 'Стенка прыгает. Закрути мяч в обход неё — изогни линию сильнее.';
  if (reason.includes('Сейв') || reason.includes('поймал')) return 'Вратарь прочитал удар. Бей в угол, а кручёный мяч он видит хуже.';
  if (reason.includes('Мимо') || reason.includes('штанги')) return 'Чуть-чуть! Смотри на точку, где линия пересекает ворота.';
  if (reason.includes('потерян') || reason.includes('линию') || reason.includes('Аут')) return 'Мяч никто не подобрал. Пас — к партнёру или в конец его стрелки.';
  return 'Попробуй ещё раз!';
}

const app = new App();
(window as unknown as { __gz: App }).__gz = app;
