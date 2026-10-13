/**
 * Persistent user settings (localStorage): graphics quality, camera, volume, key bindings.
 * Everything is optional at runtime: when storage is blocked the defaults are used.
 */

export type Quality = 'high' | 'medium' | 'low';

/** Game actions that can be bound to keys. Context decides the meaning (attack vs defence). */
export const ACTIONS = [
  { id: 'up', label: 'Вверх' },
  { id: 'down', label: 'Вниз' },
  { id: 'left', label: 'Влево' },
  { id: 'right', label: 'Вправо' },
  { id: 'sprint', label: 'Спринт' },
  { id: 'pass', label: 'Пас / сдерживание (в защите)' },
  { id: 'through', label: 'Пас на ход / помощь партнёра (в защите)' },
  { id: 'lob', label: 'Навес / подкат (в защите)' },
  { id: 'shoot', label: 'Удар / отбор (в защите)' },
  { id: 'finesse', label: 'Крученый удар' },
  { id: 'chip', label: 'Удар парашютом' },
  { id: 'skill', label: 'Финт' },
  { id: 'switch', label: 'Смена игрока' },
] as const;

export type ActionId = (typeof ACTIONS)[number]['id'];
export type Bindings = Record<ActionId, string[]>;

export const PRESETS: Record<string, { name: string; bindings: Bindings }> = {
  fifa: {
    name: 'Как в FIFA (стрелки)',
    bindings: {
      up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
      sprint: ['KeyE'], pass: ['KeyS'], through: ['KeyW'], lob: ['KeyA'], shoot: ['KeyD'],
      finesse: ['ShiftLeft'], chip: ['KeyZ'], skill: ['KeyC'], switch: ['KeyQ'],
    },
  },
  wasd: {
    name: 'WASD + JKL',
    bindings: {
      up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
      sprint: ['ShiftLeft'], pass: ['KeyK'], through: ['KeyL'], lob: ['KeyO'], shoot: ['KeyJ'],
      finesse: ['KeyI'], chip: ['KeyU'], skill: ['KeyE'], switch: ['Space', 'KeyQ'],
    },
  },
};

export interface Settings {
  quality: Quality;
  camera: string;
  volume: number;
  preset: string;
  bindings: Bindings;
}

const KEY = 'footballbro.options';

function defaults(): Settings {
  return { quality: 'high', camera: 'tv', volume: 0.7, preset: 'fifa', bindings: structuredClone(PRESETS.fifa.bindings) };
}

export const settings: Settings = (() => {
  const d = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return { ...d, ...s, bindings: { ...d.bindings, ...(s.bindings ?? {}) } };
  } catch {
    return d;
  }
})();

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

/** Human readable key name for the UI. */
export function keyLabel(code: string) {
  const map: Record<string, string> = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Пробел', ShiftLeft: 'Shift', ShiftRight: 'R-Shift',
    ControlLeft: 'Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'Alt', Enter: 'Enter', Tab: 'Tab', Backspace: '⌫',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  return code;
}

export function bindingLabel(id: ActionId) {
  return settings.bindings[id].map(keyLabel).join(' / ') || '—';
}
