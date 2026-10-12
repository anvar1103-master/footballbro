import { CAMERA_PRESETS } from '../render/camera';
import { ACTIONS, ActionId, PRESETS, Quality, keyLabel, saveSettings, settings } from '../settings';

export interface SettingsHooks {
  /** route the next key press to the rebinding UI (null to stop) */
  capture: (hook: ((code: string) => void) | null) => void;
  onCamera?: (id: string) => void;
  onVolume?: (v: number) => void;
  onClose: () => void;
}

/** Settings overlay: controls (presets + rebinding), camera, graphics quality, volume. */
export function showSettings(root: HTMLElement, hooks: SettingsHooks) {
  const el = document.createElement('div');
  el.className = 'overlay settings';
  root.appendChild(el);
  let waiting: ActionId | null = null;

  const close = () => {
    hooks.capture(null);
    saveSettings();
    el.remove();
    hooks.onClose();
  };

  const render = () => {
    const seg = (key: string, items: [string, string][], cur: string) =>
      `<div class="seg">${items.map(([v, l]) => `<button data-k="${key}" data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const rows = ACTIONS.map(
      (a) => `<div class="bind-row"><span>${a.label}</span>
        <button class="bind ${waiting === a.id ? 'wait' : ''}" data-bind="${a.id}">${waiting === a.id ? 'нажмите клавишу…' : settings.bindings[a.id].map(keyLabel).join(' / ') || '—'}</button></div>`,
    ).join('');
    el.innerHTML = `<div class="panel wide">
      <h2>Настройки</h2>
      <div class="set-grid">
        <div class="opt"><div class="label">Камера</div>${seg('camera', CAMERA_PRESETS.map((c) => [c.id, c.name]), settings.camera)}</div>
        <div class="opt"><div class="label">Графика</div>${seg('quality', [['high', 'Высокая'], ['medium', 'Средняя'], ['low', 'Низкая']], settings.quality)}
          <div class="note">Применится со следующего матча</div></div>
        <div class="opt"><div class="label">Громкость</div><input id="vol" type="range" min="0" max="1" step="0.05" value="${settings.volume}"></div>
      </div>
      <div class="opt"><div class="label">Раскладка управления</div>${seg('preset', Object.entries(PRESETS).map(([k, p]) => [k, p.name]), settings.preset)}</div>
      <div class="binds">${rows}</div>
      <div class="note">Нажмите на клавишу действия, затем новую клавишу. Esc — отмена. Действия зависят от ситуации: в защите «Пас» — сдерживание, «Удар» — отбор, «Навес» — подкат.</div>
      <div class="row" style="margin-top:14px"><button class="btn big" data-a="close">Готово</button></div>
    </div>`;
  };
  render();

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.a === 'close') return close();
    const k = t.dataset.k;
    if (k) {
      const v = t.dataset.v!;
      if (k === 'camera') {
        settings.camera = v;
        hooks.onCamera?.(v);
      }
      if (k === 'quality') settings.quality = v as Quality;
      if (k === 'preset') {
        settings.preset = v;
        settings.bindings = structuredClone(PRESETS[v].bindings);
      }
      saveSettings();
      render();
      return;
    }
    const b = t.dataset.bind as ActionId | undefined;
    if (b) {
      waiting = b;
      render();
      hooks.capture((code) => {
        if (code !== 'Escape') {
          // a key can only do one thing: remove it from other actions
          for (const a of ACTIONS) settings.bindings[a.id] = settings.bindings[a.id].filter((x) => x !== code);
          settings.bindings[b] = [code];
          settings.preset = 'custom';
        }
        waiting = null;
        hooks.capture(null);
        saveSettings();
        render();
      });
    }
  });
  el.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'vol') {
      settings.volume = Number(t.value);
      hooks.onVolume?.(settings.volume);
      saveSettings();
    }
  });
}
