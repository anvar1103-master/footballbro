import '../ui/style.css';
import './bean.css';
import * as THREE from 'three';
import { Sound } from '../audio/sound';
import { settings, Quality } from '../settings';
import { TEAM_PRESETS, TeamInfo } from '../sim/team';
import { EVENT_INFO, EventKind, NO_INPUT, PARTY_DT, PartyInput, PartyWorld } from './world';
import { PartyRenderer } from './view';
import { Tutorial } from './tutorial';

/**
 * Footballbro: funny third-person arcade football with crash-test-dummy footballers.
 * A TV camera follows the ball, two main buttons (pass / shot) do everything in context, passes,
 * skills and tackles fill the ОГОНЬ meter for a fire shot, goals get an instant replay, and a
 * short tutorial teaches the basics. The old FIFA-style game lives in classic.html / src/main.ts.
 */

const gameEl = document.getElementById('game')!;
const uiEl = document.getElementById('ui')!;
const sound = new Sound();

// ---------------- input ----------------
type Layout = 'mouse' | 'keys';
type Act = 'up' | 'down' | 'left' | 'right' | 'sprint' | 'jump' | 'kick' | 'pass' | 'lob' | 'tackle' | 'grab' | 'switch' | 'skill';
const LAYOUTS: Record<Layout, { name: string; keys: Record<Act, string[]> }> = {
  // mouse + keyboard; the J/K/L keys work as well for those who prefer keys with WASD
  mouse: {
    name: 'Мышь + клавиатура',
    keys: {
      up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
      sprint: ['ShiftLeft', 'ShiftRight'], jump: ['Space'],
      pass: ['Mouse0', 'KeyJ'], kick: ['Mouse2', 'KeyK'], lob: ['Mouse1', 'KeyC', 'KeyL'],
      skill: ['KeyF', 'KeyH'], tackle: ['KeyE', 'KeyI'], grab: ['KeyR', 'KeyU'], switch: ['KeyQ', 'KeyO'],
    },
  },
  keys: {
    name: 'Только клавиатура',
    keys: {
      up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
      sprint: ['ShiftLeft', 'ShiftRight'], jump: ['Space'],
      pass: ['KeyS'], kick: ['KeyD'], lob: ['KeyA'], skill: ['KeyW', 'KeyF'], tackle: ['KeyE'], grab: ['KeyR'], switch: ['KeyQ'],
    },
  },
};
let layout: Layout = 'mouse';
const opts = { size: 4, length: 180, difficulty: 'normal' as 'easy' | 'normal' | 'hard', autoSwitch: true, hints: true };
let tutorialDone = false;
try {
  const l = localStorage.getItem('footballbro.layout3') as Layout | null;
  if (l && l in LAYOUTS) layout = l;
  Object.assign(opts, JSON.parse(localStorage.getItem('footballbro.bean.opts') ?? '{}'));
  tutorialDone = localStorage.getItem('footballbro.tutorial') === '1';
} catch {
  /* storage blocked */
}
const keys = new Set<string>();
const presses: string[] = [];
/** what the player used last (prompts show mouse buttons or keys accordingly) */
let device: 'mouse' | 'keys' = layout === 'mouse' ? 'mouse' : 'keys';
let lastMouseMove = 0;
/** keys that stand in for the mouse buttons: using them means "no mouse aim" */
const ACTION_KEYS = new Set(['KeyJ', 'KeyK', 'KeyL']);
window.addEventListener('keydown', (e) => {
  if (!e.repeat) presses.push(e.code);
  keys.add(e.code);
  if (ACTION_KEYS.has(e.code)) device = 'keys';
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// ---------------- mouse: the cursor on the pitch is the aim; LMB pass, RMB shot, wheel-click lob ----------------
let mouseX = -1, mouseY = -1;
const mouseOn = () => layout === 'mouse' && !!session && session.mode !== 'watch' && !session.paused && session.w.phase !== 'over';
gameEl.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('contextmenu', (e) => {
  if (mouseOn()) e.preventDefault();
});
window.addEventListener('mousedown', (e) => {
  presses.push('Click');
  if (!mouseOn()) return;
  if ((e.target as HTMLElement).closest('button')) return;
  const code = 'Mouse' + e.button;
  keys.add(code);
  presses.push(code);
  device = 'mouse';
  e.preventDefault();
});
window.addEventListener('mouseup', (e) => keys.delete('Mouse' + e.button));
window.addEventListener('mousemove', (e) => {
  if (Math.abs(e.clientX - mouseX) + Math.abs(e.clientY - mouseY) > 3) lastMouseMove = performance.now();
  mouseX = e.clientX;
  mouseY = e.clientY;
});
document.addEventListener('mouseleave', () => (mouseX = mouseY = -1));
/** the cursor aims only while the mouse is actually in use (moved lately or clicked last) */
const mouseAim = () => mouseOn() && mouseX >= 0 && (device === 'mouse' || performance.now() - lastMouseMove < 2500);

function readInput(cam: { forward(): THREE.Vector3 }, aim: { dir: THREE.Vector3; dist: number } | null): PartyInput {
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
  return { mx, mz, sprint: h('sprint'), jump: h('jump'), kick: h('kick'), pass: h('pass'), lob: h('lob'), tackle: h('tackle'), grab: h('grab'), switch: h('switch'), skill: h('skill'), aimX: aim?.dir.x ?? 0, aimZ: aim?.dir.z ?? 0, aimDist: aim?.dist ?? 0 };
}
const ARROWS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const label = (c: string) =>
  c === 'Mouse0' ? 'ЛКМ' : c === 'Mouse2' ? 'ПКМ' : c === 'Mouse1' ? 'Колесо' : c.startsWith('Key') ? c.slice(3) : c.startsWith('Arrow') ? ARROWS[c] : c === 'Space' ? 'Пробел' : c.replace('Left', '').replace('Right', '');
/** all bindings of an action */
const kl = (a: Act) => [...new Set(LAYOUTS[layout].keys[a].map(label))].join('/');
/** the one binding to show in prompts: the mouse button or the key, whichever the player uses */
const key1 = (a: Act) => {
  const all = LAYOUTS[layout].keys[a];
  const m = all.find((c) => c.startsWith('Mouse'));
  const kb = all.find((c) => !c.startsWith('Mouse'));
  return label((device === 'mouse' && m) || kb || all[0]);
};

/** two teams that look different from each other (and from the grass) */
function pickTeams(): [TeamInfo, TeamInfo] {
  // (no yellow kits: the dummies themselves are yellow plastic)
  const pool = TEAM_PRESETS.filter((t) => t.short !== 'SUN').sort(() => Math.random() - 0.5);
  const a = pool[0];
  const rgb = (c: string) => {
    const k = { r: 0, g: 0, b: 0 };
    new THREE.Color(c).getRGB(k, THREE.SRGBColorSpace);
    return k;
  };
  const ca = rgb(a.primary);
  const b = pool.slice(1).find((t) => {
    const cb = rgb(t.primary);
    return Math.hypot(ca.r - cb.r, ca.g - cb.g, ca.b - cb.b) > 0.75;
  }) ?? pool[1];
  return [a, b];
}

// ---------------- session ----------------
type Mode = 'match' | 'watch' | 'tutorial';
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
  prompts: HTMLDivElement;
  sw: HTMLDivElement;
  balla: HTMLDivElement;
  flash: HTMLDivElement;
  replayEl: HTMLDivElement;
  fires: HTMLDivElement[];
  count: HTMLDivElement;
  coach: HTMLDivElement;
  bannerT = 0;
  toastT = 0;
  countT = 0;
  flashT = 0;
  overShown = false;
  replayed = false;
  promptKey = '';
  speed = Number(new URLSearchParams(location.search).get('speed') ?? 1);
  tutorial: Tutorial | null = null;
  get watch() {
    return this.mode === 'watch';
  }

  constructor(public w: PartyWorld, public mode: Mode) {
    const q = (new URLSearchParams(location.search).get('q') as Quality | null) ?? settings.quality;
    this.gfx = new PartyRenderer(gameEl, w, q);
    if (layout === 'mouse') gameEl.style.cursor = 'crosshair';
    const [a, b] = w.teams;
    const hud = document.createElement('div');
    hud.className = 'bb-hud';
    const fireBar = (i: number) => `<div class="bb-fire" data-i="${i}"><i></i><span>ОГОНЬ</span></div>`;
    hud.innerHTML = `
      <div class="bb-score">
        <div class="bb-side"><div class="bb-team" style="--c:${a.info.primary}">${a.info.short}</div>${fireBar(0)}</div>
        <div class="bb-num">0 : 0</div>
        <div class="bb-side"><div class="bb-team" style="--c:${b.info.primary}">${b.info.short}</div>${fireBar(1)}</div>
      </div>
      <div class="bb-clock">3:00</div>
      <div class="bb-chaos"></div>
      <div class="bb-banner"></div>
      <div class="bb-count"></div>
      <div class="bb-toast"></div>
      <div class="bb-tag"><div class="bb-name">ТЫ</div><div class="bb-power"><div></div></div><div class="bb-prompts"></div></div>
      <div class="bb-sw">${key1('switch')}</div>
      <div class="bb-balla">⚽</div>
      <div class="bb-flash"></div>
      <div class="bb-replay">ПОВТОР <small>любая клавиша — пропустить</small></div>
      <div class="bb-coach"></div>
      <div class="bb-hint">${
        mode === 'watch'
          ? 'Режим наблюдения · V камера · Esc пауза'
          : `<b>${layout === 'mouse' ? 'WASD' : '←↑↓→'}</b> бег · <b>${key1('pass')}</b> пас · <b>${key1('kick')}</b> удар (держи) · <b>${kl('sprint')}</b> спринт · <b>${key1('skill')}</b> финт · <b>${key1('lob')}</b> навес · <b>${kl('jump')}</b> прыжок · <b>V</b> камера · <b>Esc</b> пауза`
      }</div>`;
    uiEl.appendChild(hud);
    this.hud = hud;
    this.banner = hud.querySelector('.bb-banner')!;
    this.toast = hud.querySelector('.bb-toast')!;
    this.score = hud.querySelector('.bb-num')!;
    this.clock = hud.querySelector('.bb-clock')!;
    this.chaos = hud.querySelector('.bb-chaos')!;
    this.tag = hud.querySelector('.bb-tag')!;
    this.prompts = hud.querySelector('.bb-prompts')!;
    this.count = hud.querySelector('.bb-count')!;
    this.sw = hud.querySelector('.bb-sw')!;
    this.balla = hud.querySelector('.bb-balla')!;
    this.flash = hud.querySelector('.bb-flash')!;
    this.replayEl = hud.querySelector('.bb-replay')!;
    this.coach = hud.querySelector('.bb-coach')!;
    this.fires = [...hud.querySelectorAll<HTMLDivElement>('.bb-fire')];

    if (mode === 'tutorial') {
      hud.classList.add('tut');
      this.tutorial = new Tutorial(w, {
        show: (step, total, title, text) => {
          this.coach.innerHTML = `<div class="n">Шаг ${step} из ${total}</div><h3>${title}</h3><p>${text}</p>`;
          this.coach.classList.remove('show');
          void this.coach.offsetWidth;
          this.coach.classList.add('show');
        },
        praise: (t) => {
          this.showToast(t, 1.4);
          sound.chime(3);
        },
        finish: () => this.tutorialOver(),
      }, key1);
    } else this.showCount('3');
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
  doFlash(strength = 0.7) {
    this.flash.style.transition = 'none';
    this.flash.style.opacity = String(strength);
    void this.flash.offsetWidth;
    this.flash.style.transition = 'opacity 0.45s ease-out';
    this.flash.style.opacity = '0';
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.gfx.dispose();
    this.hud.remove();
  }

  events() {
    const w = this.w;
    const me = w.controlled;
    const mine = (t?: number) => !!me && t === me.team;
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
          if (mine(e.team)) this.showToast('ПОПАЛСЯ!');
          break;
        case 'skill':
          sound.whoosh();
          if (mine(e.team)) this.showToast(({ rainbow: 'РАДУГА!', cut: 'ФИНТ!', turn: 'РАЗВОРОТ!' } as Record<string, string>)[e.text ?? ''] ?? 'ФИНТ!');
          break;
        case 'combo':
          if (mine(e.team) && (e.strength ?? 0) >= 2) {
            this.showToast(`ПАС ×${e.strength}!`, 0.9);
            sound.chime(Math.min(4, e.strength ?? 2));
          }
          break;
        case 'fireReady':
          if (mine(e.team)) {
            this.showBanner('ОГОНЬ ГОТОВ!', `следующий удар — огненный · ${key1('kick')}`, 2.2, '#ff7a1a');
            sound.chime(4);
          } else if (me) this.showToast('Осторожно: у соперника ОГОНЬ!', 1.6);
          break;
        case 'fire':
          sound.fire();
          this.doFlash(0.75);
          this.showBanner('ОГНЕННЫЙ УДАР!', '', 1.4, '#ff5a1f');
          break;
        case 'burn':
          sound.bonk(12);
          this.showToast(['СНЕСЛО!', 'ПРОЖАРКА!', 'КРАШ-ТЕСТ!'][Math.floor(Math.random() * 3)]);
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
          const byMe = w.lastScorer === me && !own;
          this.showBanner(byMe ? 'ТВОЙ ГОЛ!' : 'ГОЛ!', own ? `${t.name} · автогол!` : `${t.name}${w.lastScorer ? ' · ' + w.lastScorer.name : ''}`, 3.2, mine(e.team) || !me ? t.primary : '#9aa3b5');
          this.doFlash(0.35);
          break;
        }
      }
    }
    this.tutorial?.onEvents(w.events);
    this.gfx.handleEvents(w.events);
    w.events.length = 0;
  }

  /** context buttons next to your player: what the two main buttons do right now */
  updatePrompts() {
    const w = this.w;
    const c = w.controlled;
    let html = '';
    if (c && opts.hints && this.mode !== 'watch' && w.phase === 'play' && c.state === 'up' && !w.gkHold) {
      const chip = (a: Act, t: string, hot = false) => `<span class="${hot ? 'hot' : ''}"><b>${key1(a)}</b>${t}</span>`;
      const h = w.holder;
      const p = c.position();
      const bp = w.ballPos();
      const fire = w.teams[c.team].fire >= 1;
      if (h && h.team !== c.team) {
        const hp = h.position();
        const d = Math.hypot(hp.x - p.x, hp.z - p.z);
        html = d < 4.5 ? chip('kick', 'подкат', true) + chip('grab', 'схватить') : w.switchTarget ? chip('pass', 'сменить игрока') : '';
      } else if (w.onBall(c)) {
        const dGoal = Math.hypot(w.goalX(c.team) - bp.x, bp.z);
        const high = bp.y - w.ballR > 1.15;
        if (high) html = chip('kick', 'головой!', true);
        else {
          const pt = w.passTarget;
          html = chip('pass', pt ? `пас → ${pt.name}` : 'пас вперёд') + chip('kick', fire ? '🔥 огненный удар' : dGoal < 24 ? 'удар!' : 'удар', fire || dGoal < 24);
          if (h === c && dGoal >= 24) html += chip('skill', 'финт');
        }
      } else if (w.switchTarget) {
        const sp = w.switchTarget.position();
        if (Math.hypot(sp.x - bp.x, sp.z - bp.z) + 3 < Math.hypot(p.x - bp.x, p.z - bp.z)) html = chip('pass', 'сменить игрока');
      }
    }
    if (html !== this.promptKey) {
      this.promptKey = html;
      this.prompts.innerHTML = html;
    }
  }

  loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const w = this.w;
    const pressed = presses.splice(0);
    // an instant replay is running: the match waits; any key / click skips it
    if (this.gfx.replaying) {
      const skip = pressed.some((k) => k !== 'Escape' && k !== 'KeyP');
      if (skip || !this.gfx.drawReplay(dt)) {
        this.gfx.stopReplay();
        w.phaseT = Math.max(w.phaseT, 3.5); // straight on to the next kick-off
      }
      this.replayEl.classList.toggle('show', this.gfx.replaying);
      this.hud.classList.toggle('cine', this.gfx.replaying);
      this.tag.style.display = 'none';
      this.balla.style.display = 'none';
      this.sw.style.display = 'none';
      if ((this.bannerT -= dt) <= 0) this.banner.classList.remove('show');
      return;
    }
    this.replayEl.classList.remove('show');
    this.hud.classList.remove('cine');
    for (const k of pressed) {
      if (k === 'Escape' || k === 'KeyP') this.togglePause();
      if (k === 'KeyM') sound.setMuted(!sound.muted);
      if (k === 'KeyR' && (this.paused || w.phase === 'over')) start(this.mode);
      if (k === 'KeyV' && (w.controlled || this.watch)) {
        this.gfx.cam.mode = (this.gfx.cam.mode + 1) % 3;
        this.showToast(['Камера: трансляция', 'Камера: сверху-сзади', 'Камера: близко'][this.gfx.cam.mode]);
      }
    }
    if (this.paused) return;
    // mouse aim = the point on the grass under the cursor
    let aim: { dir: THREE.Vector3; dist: number } | null = null;
    this.gfx.aimPoint = null;
    if (mouseAim() && w.controlled) {
      const pt = this.gfx.pickGround(mouseX, mouseY);
      if (pt) {
        const cp = w.controlled.position();
        const d = new THREE.Vector3(pt.x - cp.x, 0, pt.z - cp.z);
        const dist = d.length();
        if (dist > 0.6) {
          aim = { dir: d.normalize(), dist };
          this.gfx.aimPoint = pt;
        }
      }
    }
    const inp = this.watch ? NO_INPUT : readInput(this.gfx.cam, aim);
    // slow motion right after a goal / a fire shot
    const slow = w.slowmo > 0 ? 0.35 : 1;
    this.acc += dt * this.speed * slow;
    while (this.acc >= PARTY_DT) {
      this.tutorial?.preStep(PARTY_DT);
      w.step(PARTY_DT, inp);
      this.events();
      this.acc -= PARTY_DT;
    }
    this.tutorial?.update(dt);
    this.gfx.draw(dt * slow);
    // after a goal: celebrate a moment, then the replay
    if (w.phase === 'goal' && !this.replayed && w.phaseT > 1.3 && this.mode !== 'tutorial') {
      this.replayed = true;
      this.gfx.startReplay();
    }
    if (w.phase !== 'goal') this.replayed = false;
    this.hudUpdate(dt);
  }

  hudUpdate(dt: number) {
    const w = this.w;
    this.score.textContent = `${w.teams[0].score} : ${w.teams[1].score}`;
    const rem = Math.ceil(w.remaining);
    this.clock.textContent = this.mode === 'tutorial' ? 'ОБУЧЕНИЕ' : w.golden ? 'ЗОЛОТОЙ ГОЛ' : w.phase === 'over' ? 'КОНЕЦ' : `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
    this.gfx.scoreboard(this.mode === 'tutorial' ? 'ТРЕНИРОВКА' : this.clock.textContent ?? '');
    this.clock.classList.toggle('hurry', rem <= 10 && w.phase === 'play' && !w.golden && this.mode !== 'tutorial');
    w.teams.forEach((t, i) => {
      const el = this.fires[i];
      (el.firstElementChild as HTMLElement).style.width = `${Math.round(t.fire * 100)}%`;
      el.classList.toggle('full', t.fire >= 1);
    });
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
      const s = this.gfx.project(c.position().add(new THREE.Vector3(0, 1.45, 0)));
      this.tag.style.display = s.visible ? 'flex' : 'none';
      this.tag.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
      (this.tag.querySelector('.bb-name') as HTMLElement).textContent = c.state === 'up' ? (c.grabbing ? 'ДЕРЖУ!' : w.grabbedBy(c) ? 'ПУСТИ!' : 'ТЫ') : 'ОЙ…';
      const pw = this.tag.querySelector('.bb-power') as HTMLElement;
      pw.style.visibility = c.charging ? 'visible' : 'hidden';
      (pw.firstElementChild as HTMLElement).style.width = `${Math.round(Math.min(1, c.kickCharge / 0.8) * 100)}%`;
      this.updatePrompts();
    } else this.tag.style.display = 'none';
    // ball off screen: an arrow on the edge pointing at it
    {
      const bp = w.ballPos();
      const v = bp.clone().project(this.gfx.cam.camera);
      const behind = v.z > 1;
      let x = v.x, y = v.y;
      if (behind) {
        x = -x;
        y = -y;
      }
      const off = behind || Math.abs(x) > 0.95 || Math.abs(y) > 0.95;
      this.balla.style.display = off && w.phase === 'play' ? 'block' : 'none';
      if (off) {
        const m = Math.max(Math.abs(x), Math.abs(y)) / 0.9;
        const ex = ((x / m + 1) / 2) * window.innerWidth, ey = ((1 - y / m) / 2) * window.innerHeight;
        this.balla.style.transform = `translate(${Math.round(ex)}px, ${Math.round(ey)}px) translate(-50%, -50%) rotate(${Math.atan2(-y, x)}rad)`;
      }
    }
    // who the switch key would take over
    const st = w.switchTarget;
    if (st && !this.watch && w.phase !== 'over' && this.mode !== 'tutorial') {
      const s = this.gfx.project(st.position().add(new THREE.Vector3(0, 1.45, 0)));
      this.sw.style.display = s.visible ? 'block' : 'none';
      this.sw.textContent = key1('switch');
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
        if (act === 'again') start(this.mode);
        if (act === 'menu') toMenu();
      });
      this.hud.appendChild(o);
      sound.crowdReact('cheer');
    }
  }

  tutorialOver() {
    tutorialDone = true;
    try {
      localStorage.setItem('footballbro.tutorial', '1');
    } catch {
      /* ignore */
    }
    this.coach.classList.remove('show');
    const o = document.createElement('div');
    o.className = 'overlay';
    o.innerHTML = `<div class="panel bb-panel"><h2>Ты готов!</h2>
      <div class="final" style="font-size:22px">Пас, удар, подкат, финт и ОГОНЬ — всё, что нужно.<br>Теперь — настоящий матч.</div>
      <div class="row"><button class="btn big" data-a="play">Играть матч</button><button class="btn" data-a="menu">В меню</button></div></div>`;
    o.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).dataset.a;
      if (act === 'play') start('match');
      if (act === 'menu') toMenu();
    });
    this.hud.appendChild(o);
    sound.crowdReact('cheer');
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
        if (act === 'again') start(this.mode);
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

async function start(mode: Mode) {
  sound.volume = settings.volume;
  sound.start();
  session?.dispose();
  session = null;
  const teams = pickTeams();
  const params = new URLSearchParams(location.search);
  let w: PartyWorld;
  if (mode === 'tutorial') w = await PartyWorld.create({ humanTeam: 0, size: 3, matchLength: 1e6, teams, difficulty: 'easy', events: false, autoSwitch: true });
  else {
    const size = Number(params.get('size') ?? opts.size);
    const length = Number(params.get('len') ?? opts.length);
    w = await PartyWorld.create({ humanTeam: mode === 'watch' ? -1 : 0, size, matchLength: length, teams, difficulty: opts.difficulty, autoSwitch: opts.autoSwitch });
  }
  session = new Session(w, mode);
}
function toMenu() {
  session?.dispose();
  session = null;
  showMenu();
}

function save() {
  try {
    localStorage.setItem('footballbro.bean.opts', JSON.stringify(opts));
    localStorage.setItem('footballbro.layout3', layout);
  } catch {
    /* ignore */
  }
}

function showMenu() {
  const el = document.createElement('div');
  el.className = 'menu bb-menu';
  const seg = (key: string, items: [number | string, string][], cur: number | string) =>
    `<div class="seg">${items.map(([v, l]) => `<button data-k="${key}" data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const tile = (k: string, t: string, sub: string) => `<div class="bb-key"><b>${k}</b><div>${t}</div><small>${sub}</small></div>`;
  const render = () => {
    const mouse = layout === 'mouse';
    el.innerHTML = `<div class="menu-card bb-card">
      <div class="bb-logo">FOOTBALL<span>BRO</span></div>
      <div class="bb-tag-line">Угарный футбол краш-тест манекенов · финты, удары через себя, подкаты и огненные удары</div>
      <div class="row bb-main">
        <button class="btn big bb-play" id="play">ИГРАТЬ</button>
        <button class="btn big bb-learn ${tutorialDone ? '' : 'new'}" id="learn">ОБУЧЕНИЕ${tutorialDone ? '' : '<em>новичкам</em>'}</button>
      </div>
      <div class="bb-keys">
        ${tile(mouse ? 'WASD' : '← ↑ → ↓', 'бег', `${kl('sprint')} — спринт`)}
        ${tile(mouse ? 'ЛКМ' : 'S', 'пас', 'без мяча — сменить игрока')}
        ${tile(mouse ? 'ПКМ' : 'D', 'удар', 'держи — сильнее · без мяча — подкат')}
        ${tile(mouse ? 'F' : 'W', 'финт', `${mouse ? 'C' : 'A'} — навес · ${kl('jump')} — прыжок`)}
      </div>
      <div class="bb-firehelp"><b>🔥 ОГОНЬ</b> Пасуй, финти, отбирай мяч — шкала заполнится, и следующий удар станет огненным: он сносит всех на пути, даже вратаря!</div>
      <div class="options bb-opts">
        <div class="opt"><div class="label">Команды</div>${seg('size', [[3, '3×3'], [4, '4×4'], [5, '5×5']], opts.size)}</div>
        <div class="opt"><div class="label">Матч</div>${seg('length', [[120, '2 мин'], [180, '3 мин'], [300, '5 мин']], opts.length)}</div>
        <div class="opt"><div class="label">Соперники</div>${seg('difficulty', [['easy', 'Сонные'], ['normal', 'Бодрые'], ['hard', 'Злые']], opts.difficulty)}</div>
        <div class="opt"><div class="label">Управление</div>${seg('layout', (Object.keys(LAYOUTS) as Layout[]).map((k) => [k, LAYOUTS[k].name]), layout)}</div>
        <div class="opt"><div class="label">Подсказки</div>${seg('hints', [['on', 'Вкл'], ['off', 'Выкл']], opts.hints ? 'on' : 'off')}</div>
        <div class="opt"><div class="label">Автосмена игрока</div>${seg('auto', [['on', 'Вкл'], ['off', 'Выкл']], opts.autoSwitch ? 'on' : 'off')}</div>
      </div>
      <div class="controls bb-controls">
        ${
          mouse
            ? `<div><b>Курсор</b> на поле — куда пасовать и бить (или <b>J</b> пас, <b>K</b> удар — тогда бьёт по воротам сам)</div>`
            : `<div><b>Стрелки</b> — бег, удар сам летит в угол ворот, куда жмёшь стрелку</div>`
        }
        <div><b>${kl('tackle')}</b> подкат · <b>${kl('grab')}</b> схватить за майку · <b>${kl('switch')}</b> смена игрока</div>
        <div>Мимо штанги — мяч закрутит в ворота. Мяч в воздухе — удар с лёта, через себя или головой</div>
        <div><b>V</b> камера · <b>Esc</b> пауза · <b>M</b> звук</div>
      </div>
      <div class="row"><button class="btn" id="watch">Посмотреть, как играют боты</button></div>
      <div class="credits">Без офсайдов, аутов и фолов. Каждые полминуты — случайное событие!</div>
    </div>`;
  };
  render();
  uiEl.appendChild(el);
  el.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!t) return;
    const k = t.dataset.k;
    if (k) {
      const v = t.dataset.v!;
      if (k === 'size') opts.size = Number(v);
      if (k === 'length') opts.length = Number(v);
      if (k === 'difficulty') opts.difficulty = v as typeof opts.difficulty;
      if (k === 'layout') {
        layout = v as Layout;
        device = layout === 'mouse' ? 'mouse' : 'keys';
      }
      if (k === 'auto') opts.autoSwitch = v === 'on';
      if (k === 'hints') opts.hints = v === 'on';
      save();
      render();
    }
    if (t.id === 'play' || t.id === 'watch' || t.id === 'learn') {
      el.remove();
      start(t.id === 'watch' ? 'watch' : t.id === 'learn' ? 'tutorial' : 'match');
    }
  });
}

function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('tutorial')) start('tutorial');
  else if (params.has('watch') || params.has('autostart')) start(params.has('watch') ? 'watch' : 'match');
  else showMenu();
}
boot();

