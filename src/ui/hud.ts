import type { Match } from '../sim/match';

/** DOM overlay: scoreboard, banners, power bar, radar, replay tag, pause & full-time panels. */
export class Hud {
  el: HTMLDivElement;
  private score: HTMLDivElement;
  private clock: HTMLDivElement;
  private banner: HTMLDivElement;
  private toast: HTMLDivElement;
  private power: HTMLDivElement;
  private powerFill: HTMLDivElement;
  private radar: HTMLCanvasElement;
  private tag: HTMLDivElement;
  private replayTag: HTMLDivElement;
  private replaySkip: HTMLDivElement;
  private bannerT = 0;
  private toastT = 0;
  overlay: HTMLDivElement | null = null;

  constructor(root: HTMLElement, public m: Match) {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;inset:0;';
    root.appendChild(el);
    this.el = el;
    const [a, b] = m.teams;
    el.innerHTML = `
      <div class="scoreboard">
        <div class="t"><span class="chip" style="background:${a.info.primary}"></span>${a.info.short}</div>
        <div class="score">0 - 0</div>
        <div class="t">${b.info.short}<span class="chip" style="background:${b.info.primary}"></span></div>
        <div class="clock">0'</div>
      </div>
      <div class="banner"></div>
      <div class="toast"></div>
      <div class="power"><div class="fill"></div></div>
      <canvas class="radar" width="200" height="128"></canvas>
      <div class="player-tag"></div>
      <div class="hint">K пас · L на ход · O навес · J удар · I крученый · Shift спринт · Space смена · C камера</div>
      <div class="replay-tag">ПОВТОР</div>
      <div class="replay-skip">любая кнопка — пропустить</div>`;
    this.score = el.querySelector('.score')!;
    this.clock = el.querySelector('.clock')!;
    this.banner = el.querySelector('.banner')!;
    this.toast = el.querySelector('.toast')!;
    this.power = el.querySelector('.power')!;
    this.powerFill = el.querySelector('.power .fill')!;
    this.radar = el.querySelector('.radar')!;
    this.tag = el.querySelector('.player-tag')!;
    this.replayTag = el.querySelector('.replay-tag')!;
    this.replaySkip = el.querySelector('.replay-skip')!;
    if (m.humanTeam < 0) {
      this.tag.style.display = 'none';
      (el.querySelector('.hint') as HTMLElement).textContent = 'Режим наблюдения · C камера · Esc пауза';
    }
    const ratio = m.field.width / m.field.length;
    this.radar.height = Math.round(200 * ratio);
  }

  showBanner(text: string, sub = '', dur = 2.5) {
    this.banner.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    this.banner.classList.add('show');
    this.bannerT = dur;
  }

  showToast(text: string, dur = 1.6) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    this.toastT = dur;
  }

  hideBanner() {
    this.bannerT = 0;
    this.banner.classList.remove('show');
  }

  setReplay(on: boolean) {
    if (on) this.hideBanner();
    this.replayTag.classList.toggle('show', on);
    this.replaySkip.classList.toggle('show', on);
    this.power.style.display = 'none';
  }

  setPower(x: number, y: number, level: number, finesse: boolean) {
    if (level <= 0) {
      this.power.style.display = 'none';
      return;
    }
    this.power.style.display = 'block';
    this.power.style.left = `${x - 35}px`;
    this.power.style.top = `${y - 8}px`;
    this.power.classList.toggle('finesse', finesse);
    this.powerFill.style.width = `${Math.round(level * 100)}%`;
  }

  update(dt: number) {
    const m = this.m;
    this.score.textContent = `${m.teams[0].score} - ${m.teams[1].score}`;
    this.clock.textContent = m.phase === 'halftime' ? 'HT' : m.phase === 'fulltime' ? 'FT' : `${m.minute}'`;
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.banner.classList.remove('show');
    }
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.toast.classList.remove('show');
    }
    const c = m.controlled;
    if (c) this.tag.innerHTML = `<span style="color:${m.teams[c.team].info.primary}">●</span> #${c.number} ${c.name}`;
    this.drawRadar();
  }

  private drawRadar() {
    const m = this.m;
    const cv = this.radar;
    const g = cv.getContext('2d')!;
    const W = cv.width, H = cv.height;
    const f = m.field;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.strokeRect(1, 1, W - 2, H - 2);
    g.beginPath();
    g.moveTo(W / 2, 0);
    g.lineTo(W / 2, H);
    g.stroke();
    const X = (x: number) => (x / f.length + 0.5) * W;
    const Y = (z: number) => (z / f.width + 0.5) * H;
    const bd = (f.boxDepth / f.length) * W, bw = (f.boxHalfW * 2 / f.width) * H;
    g.strokeRect(0, H / 2 - bw / 2, bd, bw);
    g.strokeRect(W - bd, H / 2 - bw / 2, bd, bw);
    for (const p of m.players) {
      g.fillStyle = m.teams[p.team].info.primary;
      g.beginPath();
      g.arc(X(p.pos.x), Y(p.pos.z), p === m.controlled ? 4.5 : 3.2, 0, Math.PI * 2);
      g.fill();
      if (p === m.controlled) {
        g.strokeStyle = '#ffe14d';
        g.lineWidth = 2;
        g.stroke();
        g.lineWidth = 1;
        g.strokeStyle = 'rgba(255,255,255,0.55)';
      }
    }
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(X(m.ball.pos.x), Y(m.ball.pos.z), 2.6, 0, Math.PI * 2);
    g.fill();
  }

  showPause(onResume: () => void, onRestart: () => void, onMenu: () => void) {
    this.closeOverlay();
    const o = document.createElement('div');
    o.className = 'overlay';
    o.innerHTML = `<div class="panel"><h2>Пауза</h2>
      <div class="row"><button class="btn big" data-a="resume">Продолжить</button></div>
      <div class="row" style="margin-top:12px"><button class="btn" data-a="restart">Заново</button><button class="btn" data-a="menu">В меню</button></div></div>`;
    o.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === 'resume') onResume();
      if (a === 'restart') onRestart();
      if (a === 'menu') onMenu();
    });
    this.el.appendChild(o);
    this.overlay = o;
  }

  showFullTime(onRestart: () => void, onMenu: () => void) {
    this.closeOverlay();
    const m = this.m;
    const [a, b] = m.teams;
    const tot = a.possessionT + b.possessionT || 1;
    const row = (k: string, x: string | number, y: string | number) => `<div>${x}</div><div class="k">${k}</div><div>${y}</div>`;
    const goals = m.goals.map((g) => `${g.minute}' ${g.scorer} (${m.teams[g.team].info.short})`).join(' · ') || 'Без голов';
    const o = document.createElement('div');
    o.className = 'overlay';
    o.innerHTML = `<div class="panel"><h2>Финальный свисток</h2>
      <div class="final">${a.info.name} ${a.score} - ${b.score} ${b.info.name}</div>
      <div class="stats">${row('Удары', a.shots, b.shots)}${row('В створ', a.shotsOnTarget, b.shotsOnTarget)}${row('Владение', Math.round((a.possessionT / tot) * 100) + '%', Math.round((b.possessionT / tot) * 100) + '%')}</div>
      <div class="goals">${goals}</div>
      <div class="row"><button class="btn big" data-a="restart">Реванш</button><button class="btn" data-a="menu">В меню</button></div></div>`;
    o.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).dataset.a;
      if (act === 'restart') onRestart();
      if (act === 'menu') onMenu();
    });
    this.el.appendChild(o);
    this.overlay = o;
  }

  closeOverlay() {
    this.overlay?.remove();
    this.overlay = null;
  }

  dispose() {
    this.el.remove();
  }
}
