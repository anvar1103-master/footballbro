import { Difficulty, TeamSize } from '../sim/config';
import { TEAM_PRESETS, TeamInfo } from '../sim/team';
import { ActionId, bindingLabel } from '../settings';

export interface MenuResult {
  home: TeamInfo;
  away: TeamInfo;
  teamSize: TeamSize;
  halfLength: number;
  difficulty: Difficulty;
  watch: boolean;
}

const SETTINGS_KEY = 'footballbro.settings';

function kitHtml(t: TeamInfo) {
  return `<div class="kit">
    <div class="sleeve" style="left:0;background:${t.primary}"></div>
    <div class="sleeve" style="right:0;background:${t.primary}"></div>
    <div class="shirt" style="background:${t.primary}"></div>
    <div class="shorts" style="background:${t.secondary}"></div>
  </div>`;
}

export function showMenu(root: HTMLElement, onStart: (r: MenuResult) => void, onSettings?: (done: () => void) => void) {
  let saved: Partial<{ home: number; away: number; size: TeamSize; half: number; diff: Difficulty }> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    /* storage unavailable */
  }
  const state = {
    home: saved.home ?? 0,
    away: saved.away ?? 1,
    size: (saved.size ?? 11) as TeamSize,
    half: saved.half ?? 150,
    diff: (saved.diff ?? 'normal') as Difficulty,
  };
  const el = document.createElement('div');
  el.className = 'menu';
  root.appendChild(el);

  const render = () => {
    const b = (id: ActionId) => bindingLabel(id);
    const h = TEAM_PRESETS[state.home];
    const a = TEAM_PRESETS[state.away];
    const seg = (key: string, items: [string | number, string][], cur: string | number) =>
      `<div class="seg">${items.map(([v, l]) => `<button data-k="${key}" data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    el.innerHTML = `
      <div class="menu-card">
        <div class="logo">SOCCER<span>BRO</span></div>
        <div class="tagline">Мультяшный футбол · крученые удары · живая сетка ворот</div>
        <div class="teams">
          <div class="team-pick"><div class="label">Ваша команда</div><div class="name">${h.name}</div>${kitHtml(h)}
            <div class="arrows"><button class="btn" data-team="home" data-d="-1">◀</button><button class="btn" data-team="home" data-d="1">▶</button></div></div>
          <div class="vs">VS</div>
          <div class="team-pick"><div class="label">Соперник</div><div class="name">${a.name}</div>${kitHtml(a)}
            <div class="arrows"><button class="btn" data-team="away" data-d="-1">◀</button><button class="btn" data-team="away" data-d="1">▶</button></div></div>
        </div>
        <div class="options">
          <div class="opt"><div class="label">Формат</div>${seg('size', [[5, '5×5'], [7, '7×7'], [11, '11×11']], state.size)}</div>
          <div class="opt"><div class="label">Тайм</div>${seg('half', [[90, '1.5 мин'], [150, '2.5 мин'], [240, '4 мин']], state.half)}</div>
          <div class="opt"><div class="label">Сложность</div>${seg('diff', [['easy', 'Легко'], ['normal', 'Норм'], ['hard', 'Сложно']], state.diff)}</div>
        </div>
        <div class="start-row">
          <button class="btn big" id="play">НАЧАТЬ МАТЧ</button>
          <div class="row" style="margin-top:10px"><button class="btn" id="watch">Смотреть ИИ vs ИИ</button><button class="btn" id="settings">Настройки</button></div>
        </div>
        <div class="controls">
          <div><b>${b('up')} ${b('left')} ${b('down')} ${b('right')}</b> бег, <b>${b('sprint')}</b> спринт</div>
          <div><b>${b('pass')}</b> пас, <b>${b('through')}</b> на ход, <b>${b('lob')}</b> навес</div>
          <div><b>${b('shoot')}</b> удар (держи — сильнее)</div>
          <div><b>${b('finesse')}</b> крученый, <b>${b('chip')}</b> парашют, <b>${b('skill')}</b> финт</div>
          <div>В защите: <b>${b('pass')}</b> сдерживание, <b>${b('shoot')}</b> отбор</div>
          <div><b>${b('lob')}</b> подкат, <b>${b('through')}</b> прессинг партнёром</div>
          <div><b>${b('switch')}</b> смена игрока, <b>V</b> камера, <b>Esc</b> пауза</div>
          <div><b>Геймпад</b>: A пас, B удар, RB+B крученый</div>
        </div>
        <div class="credits">Персонажи: Kenney Mini Characters (CC0) · Звуки и стадион — процедурные</div>
      </div>`;
  };
  render();

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const team = t.dataset.team;
    if (team) {
      const d = Number(t.dataset.d);
      const n = TEAM_PRESETS.length;
      if (team === 'home') {
        state.home = (state.home + d + n) % n;
        if (state.home === state.away) state.home = (state.home + d + n) % n;
      } else {
        state.away = (state.away + d + n) % n;
        if (state.home === state.away) state.away = (state.away + d + n) % n;
      }
      render();
      return;
    }
    const k = t.dataset.k;
    if (k) {
      const v = t.dataset.v!;
      if (k === 'size') state.size = Number(v) as TeamSize;
      if (k === 'half') state.half = Number(v);
      if (k === 'diff') state.diff = v as Difficulty;
      render();
      return;
    }
    if (t.id === 'settings' && onSettings) {
      el.style.display = 'none';
      onSettings(() => {
        el.style.display = '';
        render();
      });
      return;
    }
    if (t.id === 'play' || t.id === 'watch') {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(state));
      } catch {
        /* ignore */
      }
      el.remove();
      onStart({
        home: TEAM_PRESETS[state.home],
        away: TEAM_PRESETS[state.away],
        teamSize: state.size,
        halfLength: state.half,
        difficulty: state.diff,
        watch: t.id === 'watch',
      });
    }
  });
}
