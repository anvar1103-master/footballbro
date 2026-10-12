import { InputState, EMPTY_INPUT } from '../sim/match';

/**
 * Keyboard + gamepad -> InputState.
 * Keyboard: WASD/arrows move, Shift sprint, J shoot, I finesse, K pass, L through, O lob, Space/Q switch.
 * Gamepad (standard): left stick, A pass, B shoot, X through, Y lob, RB finesse, LB switch, RT sprint.
 */
export class Input {
  keys = new Set<string>();
  /** one-shot UI keys (Escape, C, Enter...) */
  private presses: string[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.presses.push(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
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

  read(): InputState {
    const k = this.keys;
    const s: InputState = { ...EMPTY_INPUT };
    let mx = 0, my = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) my += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my -= 1;
    const l = Math.hypot(mx, my);
    if (l > 0) {
      mx /= l;
      my /= l;
    }
    s.mx = mx;
    s.my = my;
    s.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    s.shoot = k.has('KeyJ');
    s.finesse = k.has('KeyI');
    s.pass = k.has('KeyK');
    s.through = k.has('KeyL');
    s.lob = k.has('KeyO');
    s.switch = k.has('Space') || k.has('KeyQ');

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
      const rb = b(5);
      s.pass ||= b(0);
      if (rb) s.finesse ||= b(1) || b(5);
      else s.shoot ||= b(1);
      s.through ||= b(2);
      s.lob ||= b(3);
      s.switch ||= b(4);
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
