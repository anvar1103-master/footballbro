import '../ui/style.css';
import * as THREE from 'three';
import { Sound } from '../audio/sound';
import { loadCharacters } from '../render/players';
import { settings, Quality } from '../settings';
import { TEAM_PRESETS } from '../sim/team';
import type { TeamSize } from '../sim/config';
import { NO_INPUT, PARTY_DT, PartyInput, PartyWorld } from './world';
import { PartyRenderer } from './view';

/**
 * footballbro (party edition): clumsy physics football, broadcast camera, you vs AI.
 * The classic FIFA-style game lives in classic.html / src/main.ts.
 */

const gameEl = document.getElementById('game')!;
const uiEl = document.getElementById('ui')!;
const sound = new Sound();

// ---------------- input ----------------
type Layout = 'arrows' | 'wasd';
const LAYOUTS: Record<Layout, { name: string; keys: Record<keyof Omit<PartyInput, 'mx' | 'my'> | 'up' | 'down' | 'left' | 'right', string[]> }> = {
  arrows: {
    name: 'Стрелки + ASDWE',
    keys: { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], sprint: ['ShiftLeft', 'ShiftRight'], kick: ['KeyD'], pass: ['KeyS'], dive: ['KeyA'], jump: ['KeyW', 'Space'], shove: ['KeyE'], switch: ['KeyQ'] },
  },
  wasd: {
    name: 'WASD + JKL',
    keys: { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], sprint: ['ShiftLeft', 'ShiftRight'], kick: ['KeyJ'], pass: ['KeyK'], dive: ['KeyL'], jump: ['Space'], shove: ['KeyI'], switch: ['KeyQ'] },
  },
};
let layout: Layout = 'arrows';
try {
  layout = (localStorage.getItem('footballbro.party.layout') as Layout) || 'arrows';
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
function readInput(): PartyInput {
  const k = LAYOUTS[layout].keys;
  const h = (a: keyof typeof k) => k[a].some((c) => keys.has(c));
  let mx = (h('right') ? 1 : 0) - (h('left') ? 1 : 0);
  let my = (h('up') ? 1 : 0) - (h('down') ? 1 : 0);
  const l = Math.hypot(mx, my) || 1;
  mx /= l;
  my /= l;
  return { mx, my, sprint: h('sprint'), kick: h('kick'), pass: h('pass'), dive: h('dive'), jump: h('jump'), shove: h('shove'), switch: h('switch') };
}
const label = (c: string) => (c.startsWith('Key') ? c.slice(3) : c.startsWith('Arrow') ? ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' } as Record<string, string>)[c] : c.replace('Left', '').replace('Right', ''));
const kl = (a: keyof (typeof LAYOUTS)['arrows']['keys']) => [...new Set(LAYOUTS[layout].keys[a].map(label))].join('/');

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
  tag: HTMLDivElement;
  bannerT = 0;
  toastT = 0;
  overShown = false;

  constructor(public w: PartyWorld, public watch: boolean) {
    const q = (new URLSearchParams(location.search).get('q') as Quality | null) ?? settings.quality;
    this.gfx = new PartyRenderer(gameEl, w, q);
    const [a, b] = w.teams;
    const hud = document.createElement('div');
    hud.style.cssText = 'position:absolute;inset:0;';
    hud.innerHTML = `
      <div class="scoreboard">
        <div class="t"><span class="chip" style="background:${a.info.primary}"></span>${a.info.short}</div>
        <div class="score">0 - 0</div>
        <div class="t">${b.info.short}<span class="chip" style="background:${b.info.primary}"></span></div>
        <div class="clock">0:00</div>
      </div>
      <div class="banner"></div>
      <div class="toast"></div>
      <div class="ptag"><div class="pname"></div><div class="power"><div class="fill"></div></div></div>
      <div class="hint">${watch ? 'Режим наблюдения · Esc пауза' : `${kl('kick')} удар · ${kl('pass')} пас · ${kl('dive')} рыбка · ${kl('jump')} прыжок · ${kl('shove')} толчок · ${kl('sprint')} спринт · ${kl('switch')} смена · Esc пауза`}</div>`;
    uiEl.appendChild(hud);
    this.hud = hud;
    this.banner = hud.querySelector('.banner')!;
    this.toast = hud.querySelector('.toast')!;
    this.score = hud.querySelector('.score')!;
    this.clock = hud.querySelector('.clock')!;
    this.tag = hud.querySelector('.ptag')!;
    this.showBanner('KICK OFF', `неуклюжий футбол ${w.opts.size}×${w.opts.size}`, 2);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    (window as unknown as { __fb: Session }).__fb = this;
  }

  showBanner(t: string, sub = '', dur = 2.5) {
    this.banner.innerHTML = `${t}${sub ? `<small>${sub}</small>` : ''}`;
    this.banner.classList.add('show');
    this.bannerT = dur;
  }
  showToast(t: string, dur = 1.4) {
    this.toast.textContent = t;
    this.toast.classList.add('show');
    this.toastT = dur;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.gfx.dispose();
    this.hud.remove();
  }

  events() {
    const w = this.w;
    for (const e of w.events) {
      switch (e.type) {
        case 'kick':
          sound.kick(e.strength ?? 10);
          break;
        case 'bounce':
          sound.bounce(e.strength ?? 3);
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
          if ((e.strength ?? 0) > 8) this.showToast('БАЦ!');
          break;
        case 'shove':
          sound.bonk(4);
          break;
        case 'setpiece':
          if (e.text) this.showToast(e.text);
          break;
        case 'foul':
          this.showToast('ФОЛ!');
          break;
        case 'halftime':
          this.showBanner('ПЕРЕРЫВ', `${w.teams[0].score} - ${w.teams[1].score}`, 3);
          break;
        case 'goal': {
          sound.crowdReact('goal');
          const t = w.teams[e.team ?? 0].info;
          const own = w.lastScorer && w.lastScorer.team !== e.team;
          this.showBanner('ГОЛ!', `${t.name}${own ? ' (автогол!)' : ''}`, 3);
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
      if (k === 'KeyR' && (this.paused || this.w.phase === 'over')) restart(this.watch);
      if (k === 'KeyV') this.gfx.cam.zoom = this.gfx.cam.zoom ? 0 : 1;
    }
    if (this.paused) return;
    const w = this.w;
    const inp = this.watch ? NO_INPUT : readInput();
    const speed = Number(new URLSearchParams(location.search).get('speed') ?? 1);
    this.acc += dt * speed;
    while (this.acc >= PARTY_DT) {
      w.step(PARTY_DT, inp);
      this.events();
      this.acc -= PARTY_DT;
    }
    this.gfx.draw(dt);
    // HUD
    this.score.textContent = `${w.teams[0].score} - ${w.teams[1].score}`;
    this.clock.textContent = w.phase === 'halftime' ? 'ПЕРЕРЫВ' : w.phase === 'over' ? 'КОНЕЦ' : `${w.minute}'`;
    if ((this.bannerT -= dt) <= 0) this.banner.classList.remove('show');
    if ((this.toastT -= dt) <= 0) this.toast.classList.remove('show');
    const c = w.controlled;
    if (c && !this.watch) {
      const s = this.gfx.project(c.position().add(new THREE.Vector3(0, 1.4, 0)));
      this.tag.style.display = 'flex';
      this.tag.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
      (this.tag.querySelector('.pname') as HTMLElement).textContent = c.state === 'up' ? `ТЫ ${c.name}` : 'ВСТАЁМ…';
      const pw = this.tag.querySelector('.power') as HTMLElement;
      pw.style.display = c.charging ? 'block' : 'none';
      pw.dataset.kind = c.charging === 'pass' ? 'pass' : 'shot';
      (pw.firstElementChild as HTMLElement).style.width = `${Math.round(Math.min(1, c.kickCharge / 0.8) * 100)}%`;
    } else this.tag.style.display = 'none';
    if (w.phase === 'over' && !this.overShown && w.phaseT > 1) {
      this.overShown = true;
      const [a, b] = w.teams;
      const o = document.createElement('div');
      o.className = 'overlay';
      o.innerHTML = `<div class="panel"><h2>Финальный свисток</h2><div class="final">${a.info.name} ${a.score} - ${b.score} ${b.info.name}</div>
        <div class="row"><button class="btn big" data-a="again">Ещё матч</button><button class="btn" data-a="menu">В меню</button></div></div>`;
      o.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).dataset.a;
        if (act === 'again') restart(this.watch);
        if (act === 'menu') toMenu();
      });
      this.hud.appendChild(o);
    }
  }

  pauseEl: HTMLDivElement | null = null;
  togglePause() {
    if (this.w.phase === 'over') return;
    this.paused = !this.paused;
    if (this.paused) {
      const o = document.createElement('div');
      o.className = 'overlay';
      o.innerHTML = `<div class="panel"><h2>Пауза</h2><div class="row"><button class="btn big" data-a="resume">Продолжить</button></div>
        <div class="row" style="margin-top:12px"><button class="btn" data-a="again">Заново (R)</button><button class="btn" data-a="menu">В меню</button></div></div>`;
      o.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).dataset.a;
        if (act === 'resume') this.togglePause();
        if (act === 'again') restart(this.watch);
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
const matchOpts: { size: TeamSize; half: number } = { size: 11, half: 150 };
try {
  Object.assign(matchOpts, JSON.parse(localStorage.getItem('footballbro.party.match') ?? '{}'));
} catch {
  /* storage blocked */
}

async function start(watch: boolean) {
  sound.volume = settings.volume;
  sound.start();
  session?.dispose();
  session = null;
  const teams = [...TEAM_PRESETS].sort(() => Math.random() - 0.5).slice(0, 2) as [typeof TEAM_PRESETS[0], typeof TEAM_PRESETS[0]];
  const params = new URLSearchParams(location.search);
  const size = Number(params.get('size') ?? matchOpts.size) as TeamSize;
  const half = Number(params.get('half') ?? matchOpts.half);
  const w = await PartyWorld.create({ humanTeam: watch ? -1 : 0, size, halfLength: half, teams });
  session = new Session(w, watch);
}
function restart(watch: boolean) {
  start(watch);
}
function toMenu() {
  session?.dispose();
  session = null;
  showMenu();
}

function showMenu() {
  const el = document.createElement('div');
  el.className = 'menu';
  const render = () => {
    el.innerHTML = `<div class="menu-card">
      <div class="logo">FOOTBALL<span>BRO</span></div>
      <div class="tagline">Неуклюжий футбол по правилам · толкайся, ныряй рыбкой, падай и забивай</div>
      <div class="start-row">
        <button class="btn big" id="play">ИГРАТЬ</button>
        <div class="row" style="margin-top:10px"><button class="btn" id="watch">Смотреть ИИ vs ИИ</button></div>
      </div>
      <div class="options" style="max-width:720px;margin:0 auto 12px">
        <div class="opt"><div class="label">Формат</div><div class="seg">${([5, 7, 11] as const).map((n) => `<button data-size="${n}" class="${n === matchOpts.size ? 'on' : ''}">${n}×${n}</button>`).join('')}</div></div>
        <div class="opt"><div class="label">Тайм</div><div class="seg">${[[90, '1.5 мин'], [150, '2.5 мин'], [240, '4 мин']].map(([v, l]) => `<button data-half="${v}" class="${v === matchOpts.half ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      </div>
      <div class="opt" style="max-width:520px;margin:0 auto 14px"><div class="label">Раскладка</div>
        <div class="seg">${(Object.keys(LAYOUTS) as Layout[]).map((k) => `<button data-layout="${k}" class="${k === layout ? 'on' : ''}">${LAYOUTS[k].name}</button>`).join('')}</div></div>
      <div class="controls">
        <div><b>${kl('up')} ${kl('left')} ${kl('down')} ${kl('right')}</b> бег, <b>${kl('sprint')}</b> спринт</div>
        <div><b>${kl('kick')}</b> удар (держи — сильнее)</div>
        <div><b>${kl('pass')}</b> пас партнёру</div>
        <div><b>${kl('dive')}</b> рыбка (в том числе на мяч)</div>
        <div><b>${kl('jump')}</b> прыжок, <b>${kl('shove')}</b> толчок</div>
        <div><b>${kl('switch')}</b> смена игрока, <b>V</b> ближе/дальше, <b>Esc</b> пауза</div>
      </div>
      <div class="credits">Толчок в спину или вдали от мяча и рыбка в соперника — фол. Персонажи: Kenney (CC0)</div>
    </div>`;
  };
  render();
  uiEl.appendChild(el);
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.size || t.dataset.half) {
      if (t.dataset.size) matchOpts.size = Number(t.dataset.size) as TeamSize;
      if (t.dataset.half) matchOpts.half = Number(t.dataset.half);
      try {
        localStorage.setItem('footballbro.party.match', JSON.stringify(matchOpts));
      } catch {
        /* ignore */
      }
      render();
    }
    if (t.dataset.layout) {
      layout = t.dataset.layout as Layout;
      try {
        localStorage.setItem('footballbro.party.layout', layout);
      } catch {
        /* ignore */
      }
      render();
    }
    if (t.id === 'play' || t.id === 'watch') {
      el.remove();
      start(t.id === 'watch');
    }
  });
}

async function boot() {
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.innerHTML = 'FOOTBALLBRO<div class="bar"><div></div></div>';
  uiEl.appendChild(loading);
  const bar = loading.querySelector('.bar div') as HTMLDivElement;
  try {
    await loadCharacters((f) => (bar.style.width = `${Math.round(f * 100)}%`));
  } catch (e) {
    loading.textContent = `Не удалось загрузить: ${(e as Error).message}`.slice(0, 200);
    return;
  }
  loading.remove();
  const params = new URLSearchParams(location.search);
  if (params.has('watch') || params.has('autostart')) start(params.has('watch'));
  else showMenu();
}
boot();
