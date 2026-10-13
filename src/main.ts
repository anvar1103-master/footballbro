import './ui/style.css';
import * as THREE from 'three';
import { Sound } from './audio/sound';
import { Input } from './input/input';
import { GameRenderer } from './render/game';
import { loadCharacters } from './render/players';
import { ReplayBuffer, captureFrame, FrameView } from './render/view';
import { SIM_DT } from './sim/config';
import { chargeLevel } from './sim/human';
import { EMPTY_INPUT, GameEvent, Match } from './sim/match';
import { Hud } from './ui/hud';
import { MenuResult, showMenu } from './ui/menu';
import { showSettings } from './ui/settingsPanel';
import { TEAM_PRESETS } from './sim/team';
import { settings, Quality, bindingLabel } from './settings';

const gameEl = document.getElementById('game')!;
const uiEl = document.getElementById('ui')!;
const input = new Input();
const sound = new Sound();

const SET_PIECE_NAMES: Record<string, string> = {
  throwin: 'АУТ',
  corner: 'УГЛОВОЙ',
  goalkick: 'ОТ ВОРОТ',
  freekick: 'ШТРАФНОЙ',
  penalty: 'ПЕНАЛЬТИ!',
};

const REPLAY_SPEED = 0.55;
const REPLAY_BEFORE = 4.2;
const REPLAY_AFTER = 1.4;

/** One running match: simulation + renderer + HUD + replay director. */
class Session {
  match: Match;
  gfx: GameRenderer;
  hud: Hud;
  buffer = new ReplayBuffer(7);
  acc = 0;
  paused = false;
  replay: { start: number; t: number; end: number; goalX: number } | null = null;
  pendingReplay: { at: number; goalTime: number; goalX: number } | null = null;
  fullTimeShown = false;
  raf = 0;
  last = performance.now();
  lastFrame: FrameView | null = null;
  replayCount = 0;
  /** debug: render live play with the goal camera (?cam=goal) — used by screenshot scripts */
  debugGoalCam = 0;
  hintShown = false;
  /** debug: simulation speed multiplier (?speed=4) */
  timeScale = Number(new URLSearchParams(location.search).get('speed') ?? 1);

  constructor(public opts: MenuResult) {
    this.match = new Match({
      teamSize: opts.teamSize,
      halfLength: opts.halfLength,
      difficulty: opts.difficulty,
      humanTeam: opts.watch ? -1 : 0,
      teams: [opts.home, opts.away],
    });
    this.gfx = new GameRenderer(gameEl, this.match, ((new URLSearchParams(location.search).get('q') as Quality | null) ?? (new URLSearchParams(location.search).has('lq') ? 'low' : settings.quality)));
    this.gfx.rig.setPreset(settings.camera);
    this.hud = new Hud(uiEl, this.match);
    this.hud.showBanner('KICK OFF', `${opts.home.name} vs ${opts.away.name}`, 2.2);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    (window as unknown as { __fb: Session }).__fb = this; // debug handle (screenshots / tests)
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.gfx.dispose();
    this.hud.dispose();
  }

  private onEvents(events: GameEvent[]) {
    const m = this.match;
    for (const e of events) {
      switch (e.type) {
        case 'kick':
          sound.kick(e.strength ?? 10);
          break;
        case 'bounce':
          sound.bounce(e.strength ?? 3);
          break;
        case 'post':
          sound.post(e.strength ?? 10);
          this.hud.showToast('ШТАНГА!');
          break;
        case 'net':
          sound.net(e.strength ?? 10);
          break;
        case 'whistle':
          sound.whistle(e.strength ?? 1);
          break;
        case 'save':
          sound.crowdReact('ooh');
          this.hud.showToast('СЕЙВ!');
          break;
        case 'catch':
          this.hud.showToast('ВРАТАРЬ ЛОВИТ');
          break;
        case 'foul':
          this.hud.showToast('ФОЛ!');
          break;
        case 'setpiece':
          if (e.text && SET_PIECE_NAMES[e.text]) this.hud.showToast(SET_PIECE_NAMES[e.text]);
          break;
        case 'kickoff':
          if (e.team === m.humanTeam) this.hud.showToast(`${bindingLabel('pass')} — разыграть мяч`, 2.5);
          break;
        case 'goal': {
          sound.crowdReact('goal');
          sound.whistle(1);
          const g = m.lastGoal;
          const team = m.teams[e.team ?? 0].info;
          this.hud.showBanner('ГОЛ!', g?.scorer ? `${g.scorer.name}${g.ownGoal ? ' (автогол)' : ''} · ${team.name}` : team.name, 3.2);
          this.pendingReplay = { at: m.time + 1.6, goalTime: m.time, goalX: m.attackGoalX(e.team ?? 0) };
          break;
        }
        case 'halftime':
          this.hud.showBanner('ПЕРЕРЫВ', `${m.teams[0].score} - ${m.teams[1].score}`, 3);
          break;
        case 'fulltime':
          sound.crowdReact('cheer');
          break;
      }
    }
    this.gfx.handleEvents(events);
  }

  private handleKeys() {
    const presses = input.takePresses();
    const pad = input.padPresses;
    for (const k of presses) {
      if (k === 'Escape' || k === 'KeyP') this.togglePause();
      if (k === 'KeyV') this.hud.showToast('Камера: ' + this.gfx.rig.cycle());
      if (k === 'KeyM') sound.setMuted(!sound.muted);
    }
    if (pad.includes(9)) this.togglePause();
    if (pad.includes(8)) this.gfx.rig.cycle();
    if (this.replay && (presses.some((k) => k === 'Enter' || (['pass', 'shoot', 'through', 'lob', 'switch'] as const).some((a) => settings.bindings[a].includes(k))) || pad.some((b) => b <= 3))) {
      this.endReplay();
    }
  }

  togglePause() {
    if (this.match.phase === 'fulltime') return;
    this.paused = !this.paused;
    if (this.paused)
      this.hud.showPause(
        () => this.togglePause(),
        () => restart(this.opts),
        () => backToMenu(),
        () => {
          this.hud.closeOverlay();
          openSettings(() => {
            this.paused = false;
            this.togglePause();
          }, this);
        },
      );
    else this.hud.closeOverlay();
  }

  private startReplay() {
    const p = this.pendingReplay!;
    this.pendingReplay = null;
    const start = Math.max(this.buffer.frames[0]?.t ?? p.goalTime, p.goalTime - REPLAY_BEFORE);
    this.replay = { start, t: 0, end: p.goalTime + REPLAY_AFTER, goalX: p.goalX };
    this.gfx.rig.replayAngle = this.replayCount++ % 2;
    this.gfx.ball.resetTrail();
    this.hud.setReplay(true);
  }

  private endReplay() {
    this.replay = null;
    this.hud.setReplay(false);
    this.buffer.clear();
    this.gfx.ball.resetTrail();
    // skip the rest of the celebration
    if (this.match.phase === 'goal') this.match.phaseT = Math.max(this.match.phaseT, 5.2);
    this.gfx.rig.follow(this.match.ball.pos, this.match.ball.vel, 0, true);
  }

  loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.handleKeys();
    const m = this.match;

    if (this.paused) {
      if (this.lastFrame) this.gfx.render();
      return;
    }

    if (this.replay) {
      const r = this.replay;
      const first = r.t === 0;
      r.t += dt * REPLAY_SPEED * this.timeScale;
      const frame = this.buffer.at(r.start + r.t);
      if (frame) this.gfx.draw(frame, dt * REPLAY_SPEED, { replay: true, controlledId: -1, snap: first, goalX: r.goalX });
      if (r.start + r.t >= r.end) this.endReplay();
      return;
    }

    const inp = m.humanTeam >= 0 ? input.read() : (input.read(), EMPTY_INPUT);
    this.acc += dt * this.timeScale;
    while (this.acc >= SIM_DT) {
      m.step(SIM_DT, inp);
      if (m.events.length) {
        this.onEvents(m.events);
        m.events.length = 0;
      }
      this.acc -= SIM_DT;
    }
    const frame = captureFrame(m);
    this.buffer.push(frame);
    this.lastFrame = frame;
    if (this.debugGoalCam !== 0) this.gfx.draw(frame, dt, { replay: true, controlledId: -1, snap: true, goalX: (this.debugGoalCam * m.field.length) / 2 });
    else this.gfx.draw(frame, dt, { replay: false, controlledId: m.controlled?.id ?? -1, switchId: m.switchTarget?.id ?? -1 });

    // crowd excitement: ball near a goal
    const dGoal = m.field.length / 2 - Math.abs(m.ball.pos.x);
    sound.setExcitement(Math.max(0, 1 - dGoal / 25), dt);

    // name, stamina and power bar above the controlled player
    const c = m.controlled;
    if (c && m.humanTeam >= 0) {
      const s = this.gfx.project(new THREE.Vector3(c.pos.x, 2.3, c.pos.z));
      this.hud.setPlayerTag(s.x, s.y, s.visible, `${c.number} ${c.name}`, c.stamina, chargeLevel(c), c.chargeKind);
    } else this.hud.setPlayerTag(0, 0, false, '', 1, 0, null);
    this.hud.update(dt);

    const sp = m.setPiece;
    if (sp && sp.ready && sp.taker === m.controlled && !this.hintShown && sp.kind !== 'kickoff') {
      this.hintShown = true;
      const P = bindingLabel('pass'), L = bindingLabel('lob'), S = bindingLabel('shoot'), F = bindingLabel('finesse');
      const hint = sp.kind === 'throwin' ? `${P} — короткий аут · ${L} — длинный` : sp.kind === 'corner' ? `${L} — навес · ${P} — короткий` : `${P} пас · ${L} навес · ${S} удар · ${F} крученый`;
      this.hud.showToast(hint, 3);
    }
    if (!sp) this.hintShown = false;
    if (this.pendingReplay && m.time >= this.pendingReplay.at) this.startReplay();
    if (m.phase === 'fulltime' && !this.fullTimeShown && m.phaseT > 1.5) {
      this.fullTimeShown = true;
      this.hud.showFullTime(
        () => restart(this.opts),
        () => backToMenu(),
      );
    }
  }
}

let session: Session | null = null;

function openSettings(done: () => void, s: Session | null = null) {
  showSettings(uiEl, {
    capture: (h) => (input.captureHook = h),
    onCamera: (id) => s?.gfx.rig.setPreset(id),
    onVolume: (v) => sound.setVolume(v),
    onClose: done,
  });
}

function start(opts: MenuResult) {
  sound.volume = settings.volume;
  sound.start();
  session?.dispose();
  session = new Session(opts);
}
function restart(opts: MenuResult) {
  start(opts);
}
function backToMenu() {
  session?.dispose();
  session = null;
  showMenu(uiEl, start, (done) => openSettings(done));
}

async function boot() {
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.innerHTML = 'SOCCERBRO<div class="bar"><div></div></div>';
  uiEl.appendChild(loading);
  const bar = loading.querySelector('.bar div') as HTMLDivElement;
  try {
    await loadCharacters((f) => (bar.style.width = `${Math.round(f * 100)}%`));
  } catch (e) {
    loading.innerHTML = `Не удалось загрузить ассеты: ${(e as Error).message}`;
    return;
  }
  loading.remove();
  const params = new URLSearchParams(location.search);
  if (params.has('autostart') || params.has('watch')) {
    start({
      home: TEAM_PRESETS[0],
      away: TEAM_PRESETS[1],
      teamSize: Number(params.get('size') ?? 11) as 5 | 7 | 11,
      halfLength: Number(params.get('half') ?? 150),
      difficulty: 'normal',
      watch: params.has('watch'),
    });
  } else showMenu(uiEl, start, (done) => openSettings(done));
}
boot();
