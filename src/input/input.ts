import { InputState, EMPTY_INPUT } from '../sim/match';
import { ActionId, settings } from '../settings';

/**
 * Keyboard + gamepad -> InputState. Keys come from the user's bindings (settings.ts).
 * Gamepad (standard mapping, FIFA layout): left stick, A pass, B shoot, X through, Y lob,
 * RB+B finesse, LT+B chip, LB switch, RT sprint, R3 skill.
 */
export class Input {
  keys = new Set<string>();
  /** one-shot UI keys (Escape, C, Enter...) */
  private presses: string[] = [];
  /** while rebinding keys in the settings screen, game input is muted */
  captureHook: ((code: string) => void) | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (this.captureHook) {
        e.preventDefault();
        this.captureHook(e.code);
        return;
      }
      if (e.repeat) return;
      this.keys.add(e.code);
      this.presses.push(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  takePresses() {
    const p = this.presses;
    this.presses = [];
    return p;
  }

  private padPrev: boolean[] = [];
  padPresses: number[] = [];

  held(id: ActionId) {
    return settings.bindings[id].some((k) => this.keys.has(k));
  }

  read(): InputState {
    const s: InputState = { ...EMPTY_INPUT };
    let mx = 0, my = 0;
    if (this.held('left')) mx -= 1;
    if (this.held('right')) mx += 1;
    if (this.held('up')) my += 1;
    if (this.held('down')) my -= 1;
    const l = Math.hypot(mx, my);
    if (l > 0) {
      mx /= l;
      my /= l;
    }
    s.mx = mx;
    s.my = my;
    s.sprint = this.held('sprint');
    s.shoot = this.held('shoot');
    s.finesse = this.held('finesse');
    s.chip = this.held('chip');
    s.pass = this.held('pass');
    s.through = this.held('through');
    s.lob = this.held('lob');
    s.skill = this.held('skill');
    s.switch = this.held('switch');

    this.padPresses = [];
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad) continue;
      const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
      if (Math.hypot(ax, ay) > 0.2) {
        s.mx = ax;
        s.my = -ay;
      }
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      s.pass ||= b(0);
      s.shoot ||= b(1);
      s.finesse ||= b(5);
      s.chip ||= b(6);
      s.through ||= b(2);
      s.lob ||= b(3);
      s.switch ||= b(4);
      s.skill ||= b(11);
      s.sprint ||= b(7) || (pad.buttons[7]?.value ?? 0) > 0.3;
      pad.buttons.forEach((btn, i) => {
        if (btn.pressed && !this.padPrev[i]) this.padPresses.push(i);
        this.padPrev[i] = btn.pressed;
      });
      break;
    }
    return s;
  }
}
