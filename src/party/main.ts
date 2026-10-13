import '../ui/style.css';
import './bean.css';
import * as THREE from 'three';
import { Sound } from '../audio/sound';
import { settings, Quality } from '../settings';
import { TEAM_PRESETS } from '../sim/team';
import { EVENT_INFO, EventKind, NO_INPUT, PARTY_DT, PartyInput, PartyWorld } from './world';
import { PartyRenderer } from './view';

/**
 * Footballbro "Bean Ball": a Fall Guys-style football party game. You are one jelly bean (with a
 * crown) in a 3–5-a-side team vs AI beans, third-person camera, a giant bouncy ball, chaos events.
 * The old FIFA-style game lives in classic.html / src/main.ts.
 */

const gameEl = document.getElementById('game')!;
const uiEl = document.getElementById('ui')!;
const sound = new Sound();

// ---------------- input ----------------
type Layout = 'arrows' | 'wasd';
type Act = 'up' | 'down' | 'left' | 'right' | 'sprint' | 'jump' | 'kick' | 'pass' | 'lob' | 'tackle' | 'grab' | 'switch' | 'skill';
const LAYOUTS: Record<Layout, { name: string; keys: Record<Act, string[]> }> = {
  arrows: {
    name: 'Стрелки + ASDWEQR',
    keys: { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], sprint: ['ShiftLeft', 'ShiftRight'], jump: ['Space', 'KeyW'], kick: ['KeyD'], pass: ['KeyS'], lob: ['KeyA'], tackle: ['KeyE'], grab: ['KeyR'], switch: ['KeyQ'], skill: ['KeyF'] },
  },
  wasd: {
    name: 'WASD + JKLIU',
    keys: { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], sprint: ['ShiftLeft', 'ShiftRight'], jump: ['Space'], kick: ['KeyJ'], pass: ['KeyK'], lob: ['KeyL'], tackle: ['KeyI'], grab: ['KeyU'], switch: ['KeyQ', 'KeyO'], skill: ['KeyH'] },
  },
};
let layout: Layout = 'arrows';
const opts = { size: 4, length: 180, difficulty: 'normal' as 'easy' | 'normal' | 'hard', autoSwitch: true };
try {
  layout = (localStorage.getItem('footballbro.bean.layout') as Layout) || 'arrows';
  Object.assign(opts, JSON.parse(localStorage.getItem('footballbro.bean.opts') ?? '{}'));
} catch {
  /* storage blocked */
}
const keys = new Set<string>();
const presses: string[] = [];
window.addEventListener('keydown', (e) => {
  if (!e.repeat) presses.push(e.code);
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
function readInput(cam: { forward(): THREE.Vector3 }): PartyInput {
  const k = LAYOUTS[layout].keys;
  const h = (a: Act) => k[a].some((c) => keys.has(c));
  const sx = (h('right') ? 1 : 0) - (h('left') ? 1 : 0);
  const sy = (h('up') ? 1 : 0) - (h('down') ? 1 : 0);
  // camera-relative: up = away from the camera
  const f = cam.forward();
  const r = new THREE.Vector3(-f.z, 0, f.x);
  let mx = f.x * sy + r.x * sx, mz = f.z * sy + r.z * sx;
  const l = Math.hypot(mx, mz);
  if (l > 1) {
    mx /= l;
    mz /= l;
  }
  return { mx, mz, sprint: h('sprint'), jump: h('jump'), kick: h('kick'), pass: h('pass'), lob: h('lob'), tackle: h('tackle'), grab: h('grab'), switch: h('switch'), skill: h('skill') };
}
const label = (c: string) =>
  c.startsWith('Key') ? c.slice(3) : c.startsWith('Arrow') ? ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' } as Record<string, string>)[c] : c === 'Space' ? 'Пробел' : c.replace('Left', '').replace('Right', '');
const kl = (a: Act) => [...new Set(LAYOUTS[layout].keys[a].map(label))].join('/');

// ---------------- session ----------------
class Session {
  gfx: PartyRenderer;
  acc = 0;
  last = performance.now();
  raf = 0;
  paused = false;
  hud: HTMLDivElement;
  banner: HTMLDivElement;
  toast: HTMLDivElement;
  score: HTMLDivElement;
  clock: HTMLDivElement;
  chaos: HTMLDivElement;
  tag: HTMLDivElement;
  sw: HTMLDivElement;
  count: HTMLDivElement;
  bannerT = 0;
  toastT = 0;
  countT = 0;
  overShown = false;
  speed = Number(new URLSearchParams(location.search).get('speed') ?? 1);

  constructor(public w: PartyWorld, public watch: boolean) {
    const q = (new URLSearchParams(location.search).get('q') as Quality | null) ?? settings.quality;
    this.gfx = new PartyRenderer(gameEl, w, q);
    const [a, b] = w.teams;
    const hud = document.createElement('div');
    hud.className = 'bb-hud';
    hud.innerHTML = `
      <div class="bb-score">
        <div class="bb-team" style="--c:${a.info.primary}">${a.info.short}</div>
        <div class="bb-num">0 : 0</div>
        <div class="bb-team" style="--c:${b.info.primary}">${b.info.short}</div>
      </div>
      <div class="bb-clock">3:00</div>
      <div class="bb-chaos"></div>
      <div class="bb-banner"></div>
      <div class="bb-count"></div>
      <div class="bb-toast"></div>
      <div class="bb-tag"><div class="bb-name">ТЫ</div><div class="bb-power"><div></div></div></div>
      <div class="bb-sw">${kl('switch')}</div>
      <div class="bb-hint">${watch ? 'Режим наблюдения · Esc пауза' : `<b>${kl('kick')}</b> удар (держи) · <b>${kl('pass')}</b> пас · <b>${kl('lob')}</b> навес · <b>${kl('tackle')}</b> подкат · <b>${kl('skill')}</b> финт · <b>${kl('grab')}</b> схватить · <b>${kl('switch')}</b> смена · <b>${kl('jump')}</b> прыжок · <b>${kl('sprint')}</b> спринт · <b>V</b> камера · <b>Esc</b> пауза`}</div>`;
    uiEl.appendChild(hud);
    this.hud = hud;
    this.banner = hud.querySelector('.bb-banner')!;
    this.toast = hud.querySelector('.bb-toast')!;
    this.score = hud.querySelector('.bb-num')!;
    this.clock = hud.querySelector('.bb-clock')!;
    this.chaos = hud.querySelector('.bb-chaos')!;
    this.tag = hud.querySelector('.bb-tag')!;
    this.count = hud.querySelector('.bb-count')!;
    this.sw = hud.querySelector('.bb-sw')!;
    this.showCount('3');
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    (window as unknown as { __fb: Session }).__fb = this;
  }

  showBanner(t: string, sub = '', dur = 2.5, color = '#ffd23f') {
    this.banner.innerHTML = `<span style="--c:${color}">${t}</span>${sub ? `<small>${sub}</small>` : ''}`;
    this.banner.classList.remove('show');
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
    this.bannerT = dur;
  }
  showToast(t: string, dur = 1.2) {
    this.toast.textContent = t;
    this.toast.classList.remove('show');
    void this.toast.offsetWidth;
    this.toast.classList.add('show');
    this.toastT = dur;
  }
  showCount(t: string) {
    this.count.textContent = t;
    this.count.classList.remove('show');
    void this.count.offsetWidth;
    this.count.classList.add('show');
    this.countT = 0.9;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.gfx.dispose();
    this.hud.remove();
  }

  events() {
    const w = this.w;
    const me = w.controlled;
    for (const e of w.events) {
      switch (e.type) {
        case 'kick':
          sound.kick(e.strength ?? 10);
          break;
        case 'bounce':
          sound.bounce(e.strength ?? 3);
          break;
        case 'wall':
          sound.boing(e.strength ?? 6);
          break;
        case 'post':
          sound.post(e.strength ?? 10);
          this.showToast('ШТАНГА!');
          break;
        case 'net':
          sound.net(e.strength ?? 10);
          break;
        case 'whistle':
          sound.whistle(e.strength ?? 1);
          break;
        case 'bonk':
          sound.bonk(e.strength ?? 5);
          if ((e.strength ?? 0) > 9) this.showToast('БАЦ!');
          break;
        case 'tackle':
          sound.bonk(9);
          this.showToast(['ПОДКАТ!', 'ШМЯК!', 'ВЖУХ!'][Math.floor(Math.random() * 3)]);
          break;
        case 'grab':
          sound.whoosh();
          if (e.team === me?.team) this.showToast('ПОПАЛСЯ!');
          break;
        case 'skill':
          sound.whoosh();
          if (e.team === me?.team) this.showToast(({ rainbow: 'РАДУГА!', cut: 'ФИНТ!', turn: 'РАЗВОРОТ!' } as Record<string, string>)[e.text ?? ''] ?? 'ФИНТ!');
          break;
        case 'volley':
          this.showToast('С ЛЁТА!');
          break;
        case 'bicycle':
          sound.crowdReact('ooh');
          this.showToast('ЧЕРЕЗ СЕБЯ!!');
          break;
        case 'save':
          sound.crowdReact('ooh');
          this.showToast('СЕЙВ!');
          break;
        case 'switch':
          sound.whoosh();
          break;
        case 'header':
          sound.kick(12);
          this.showToast('ГОЛОВОЙ!');
          break;
        case 'countdown':
          this.showCount(String(e.strength));
          sound.boing(3);
          break;
        case 'drop':
          if (w.phase === 'play' && w.phaseT < 0.1) this.showCount('ВПЕРЁД!');
          sound.whoosh();
          break;
        case 'event': {
          const info = EVENT_INFO[e.text as EventKind];
          this.showBanner(info.title, info.sub, 2.6, '#ff7ab8');
          sound.crowdReact('ooh');
          break;
        }
        case 'golden':
          this.showBanner('ЗОЛОТОЙ ГОЛ', 'кто забьёт — тот победил', 3, '#ffd23f');
          break;
        case 'goal': {
          sound.crowdReact('goal');
          const t = w.teams[e.team ?? 0].info;
          const own = w.lastScorer && w.lastScorer.team !== e.team;
          const mine = me && me.team === e.team;
          const byMe = w.lastScorer === me && !own;
          this.showBanner(byMe ? 'ТВОЙ ГОЛ!' : 'ГОЛ!', own ? `${t.name} · автогол!` : `${t.name}${w.lastScorer ? ' · ' + w.lastScorer.name : ''}`, 3.2, mine || !me ? t.primary : '#9aa3b5');
          break;
        }
      }
    }
    this.gfx.handleEvents(w.events);
    w.events.length = 0;
  }

  loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    for (const k of presses.splice(0)) {
      if (k === 'Escape' || k === 'KeyP') this.togglePause();
      if (k === 'KeyM') sound.setMuted(!sound.muted);
      if (k === 'KeyR' && (this.paused || this.w.phase === 'over')) start(this.watch);
      if (k === 'KeyV' && this.w.controlled) {
        this.gfx.cam.mode = (this.gfx.cam.mode + 1) % 3;
        this.showToast(['Камера: за спиной', 'Камера: повыше', 'Камера: трансляция'][this.gfx.cam.mode]);
      }
    }
    if (this.paused) return;
    const w = this.w;
    const inp = this.watch ? NO_INPUT : readInput(this.gfx.cam);
    // a short slow-motion right after a goal
    const slow = w.slowmo > 0 ? 0.35 : 1;
    this.acc += dt * this.speed * slow;
    while (this.acc >= PARTY_DT) {
      w.step(PARTY_DT, inp);
      this.events();
      this.acc -= PARTY_DT;
    }
    this.gfx.draw(dt * slow);
    // HUD
    this.score.textContent = `${w.teams[0].score} : ${w.teams[1].score}`;
    const rem = Math.ceil(w.remaining);
    this.clock.textContent = w.golden ? 'ЗОЛОТОЙ ГОЛ' : w.phase === 'over' ? 'КОНЕЦ' : `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
    this.clock.classList.toggle('hurry', rem <= 10 && w.phase === 'play' && !w.golden);
    if (w.chaos) {
      const info = EVENT_INFO[w.chaos.kind];
      this.chaos.style.display = 'block';
      this.chaos.innerHTML = `${info.title} <i style="width:${Math.round((1 - w.chaos.t / w.chaos.dur) * 100)}%"></i>`;
    } else this.chaos.style.display = 'none';
    if ((this.bannerT -= dt) <= 0) this.banner.classList.remove('show');
    if ((this.toastT -= dt) <= 0) this.toast.classList.remove('show');
    if ((this.countT -= dt) <= 0) this.count.classList.remove('show');
    const c = w.controlled;
    if (c && !this.watch) {
      const s = this.gfx.project(c.position().add(new THREE.Vector3(0, 1.9, 0)));
      this.tag.style.display = s.visible ? 'flex' : 'none';
      this.tag.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
      (this.tag.querySelector('.bb-name') as HTMLElement).textContent = c.state === 'up' ? (c.grabbing ? 'ДЕРЖУ!' : w.grabbedBy(c) ? 'ПУСТИ!' : 'ТЫ') : 'ОЙ…';
      const pw = this.tag.querySelector('.bb-power') as HTMLElement;
      pw.style.visibility = c.charging ? 'visible' : 'hidden';
      (pw.firstElementChild as HTMLElement).style.width = `${Math.round(Math.min(1, c.kickCharge / 0.8) * 100)}%`;
    } else this.tag.style.display = 'none';
    // who the switch key would take over
    const st = w.switchTarget;
    if (st && !this.watch && w.phase !== 'over') {
      const s = this.gfx.project(st.position().add(new THREE.Vector3(0, 1.45, 0)));
      this.sw.style.display = s.visible ? 'block' : 'none';
      this.sw.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
    } else this.sw.style.display = 'none';
    if (w.phase === 'over' && !this.overShown && w.phaseT > 1.5) {
      this.overShown = true;
      const [a, b] = w.teams;
      const me = w.controlled;
      const won = me ? w.teams[me.team].score > w.teams[1 - me.team].score : null;
      const o = document.createElement('div');
      o.className = 'overlay';
      o.innerHTML = `<div class="panel bb-panel"><h2>${won === null ? 'Финальный свисток' : won ? 'ПОБЕДА!' : 'Эх, проиграли'}</h2>
        <div class="final">${a.info.name} ${a.score} : ${b.score} ${b.info.name}</div>
        <div class="row"><button class="btn big" data-a="again">Ещё матч</button><button class="btn" data-a="menu">В меню</button></div></div>`;
      o.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).dataset.a;
        if (act === 'again') start(this.watch);
        if (act === 'menu') toMenu();
      });
      this.hud.appendChild(o);
      sound.crowdReact('cheer');
    }
  }

  pauseEl: HTMLDivElement | null = null;
  togglePause() {
    if (this.w.phase === 'over') return;
    this.paused = !this.paused;
    if (this.paused) {
      const o = document.createElement('div');
      o.className = 'overlay';
      o.innerHTML = `<div class="panel bb-panel"><h2>Пауза</h2><div class="row"><button class="btn big" data-a="resume">Продолжить</button></div>
        <div class="row" style="margin-top:12px"><button class="btn" data-a="again">Заново (R)</button><button class="btn" data-a="menu">В меню</button></div></div>`;
      o.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).dataset.a;
        if (act === 'resume') this.togglePause();
        if (act === 'again') start(this.watch);
        if (act === 'menu') toMenu();
      });
      this.hud.appendChild(o);
      this.pauseEl = o;
    } else {
      this.pauseEl?.remove();
      this.last = performance.now();
    }
  }
}

let session: Session | null = null;

async function start(watch: boolean) {
  sound.volume = settings.volume;
  sound.start();
  session?.dispose();
  session = null;
  const teams = [...TEAM_PRESETS].sort(() => Math.random() - 0.5).slice(0, 2) as [(typeof TEAM_PRESETS)[0], (typeof TEAM_PRESETS)[0]];
  const params = new URLSearchParams(location.search);
  const size = Number(params.get('size') ?? opts.size);
  const length = Number(params.get('len') ?? opts.length);
  const w = await PartyWorld.create({ humanTeam: watch ? -1 : 0, size, matchLength: length, teams, difficulty: opts.difficulty, autoSwitch: opts.autoSwitch });
  session = new Session(w, watch);
}
function toMenu() {
  session?.dispose();
  session = null;
  showMenu();
}

function save() {
  try {
    localStorage.setItem('footballbro.bean.opts', JSON.stringify(opts));
    localStorage.setItem('footballbro.bean.layout', layout);
  } catch {
    /* ignore */
  }
}

function showMenu() {
  const el = document.createElement('div');
  el.className = 'menu bb-menu';
  const seg = (key: string, items: [number | string, string][], cur: number | string) =>
    `<div class="seg">${items.map(([v, l]) => `<button data-k="${key}" data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const render = () => {
    el.innerHTML = `<div class="menu-card bb-card">
      <div class="bb-logo">FOOTBALL<span>BRO</span></div>
      <div class="bb-tag-line">Угарный футбол · финты, удары через себя, подкаты, захваты и полный хаос</div>
      <button class="btn big bb-play" id="play">ИГРАТЬ</button>
      <div class="options bb-opts">
        <div class="opt"><div class="label">Команды</div>${seg('size', [[3, '3×3'], [4, '4×4'], [5, '5×5']], opts.size)}</div>
        <div class="opt"><div class="label">Матч</div>${seg('length', [[120, '2 мин'], [180, '3 мин'], [300, '5 мин']], opts.length)}</div>
        <div class="opt"><div class="label">Соперники</div>${seg('difficulty', [['easy', 'Сонные'], ['normal', 'Бодрые'], ['hard', 'Злые']], opts.difficulty)}</div>
        <div class="opt"><div class="label">Автосмена игрока</div>${seg('auto', [['on', 'Вкл'], ['off', 'Выкл']], opts.autoSwitch ? 'on' : 'off')}</div>
        <div class="opt"><div class="label">Раскладка</div>${seg('layout', (Object.keys(LAYOUTS) as Layout[]).map((k) => [k, LAYOUTS[k].name]), layout)}</div>
      </div>
      <div class="controls bb-controls">
        <div><b>${kl('up')} ${kl('left')} ${kl('down')} ${kl('right')}</b> бег (вперёд — от камеры), <b>${kl('sprint')}</b> спринт</div>
        <div><b>${kl('kick')}</b> удар — держи, чтобы сильнее; стрелкой целишься в угол (мимо штанги — закрутит); мяч в воздухе — с лёта или через себя</div>
        <div><b>${kl('pass')}</b> пас своему · <b>${kl('lob')}</b> навес</div>
        <div><b>${kl('tackle')}</b> подкат · <b>${kl('grab')}</b> схватить за майку (держи)</div>
        <div><b>${kl('skill')}</b> финт: вперёд — радуга, вбок — финт с уходом, назад — разворот</div>
        <div><b>${kl('switch')}</b> смена игрока — на того, кто ближе к мячу (жми ещё — следующий)</div>
        <div><b>${kl('jump')}</b> прыжок (по мячу в воздухе — удар головой)</div>
        <div><b>V</b> камера · <b>Esc</b> пауза · <b>M</b> звук</div>
      </div>
      <div class="row"><button class="btn" id="watch">Посмотреть, как играют боты</button></div>
      <div class="credits">Без офсайдов, аутов и фолов. Каждые полминуты — случайное событие!</div>
    </div>`;
  };
  render();
  uiEl.appendChild(el);
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const k = t.dataset.k;
    if (k) {
      const v = t.dataset.v!;
      if (k === 'size') opts.size = Number(v);
      if (k === 'length') opts.length = Number(v);
      if (k === 'difficulty') opts.difficulty = v as typeof opts.difficulty;
      if (k === 'layout') layout = v as Layout;
      if (k === 'auto') opts.autoSwitch = v === 'on';
      save();
      render();
    }
    if (t.id === 'play' || t.id === 'watch') {
      el.remove();
      start(t.id === 'watch');
    }
  });
}

function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('watch') || params.has('autostart')) start(params.has('watch'));
  else showMenu();
}
boot();
