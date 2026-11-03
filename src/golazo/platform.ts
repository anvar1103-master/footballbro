import { lang, pickLang, setLang } from './i18n';

/**
 * Yandex Games SDK wrapper. Outside Yandex (GitHub Pages, artifact, dev) everything degrades to no-ops, so the
 * same build runs anywhere. Rules we follow: no third-party requests, LoadingAPI.ready() when playable,
 * GameplayAPI start/stop around real play, pause + mute while an ad shows or the tab is hidden,
 * cloud saves with a localStorage fallback.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type SDK = any;
let ysdk: SDK | null = null;
let player: any = null;
let playing = false;
let adOpen = false;
const pauseListeners: ((paused: boolean) => void)[] = [];
let hidden = false;
let sdkPaused = false;

const emitPause = () => {
  const p = hidden || adOpen || sdkPaused;
  for (const f of pauseListeners) f(p);
};
export const onPause = (f: (paused: boolean) => void) => pauseListeners.push(f);
export const isPaused = () => hidden || adOpen || sdkPaused;
export const onYandex = () => !!ysdk;

/** init the SDK (≤ 2.5 s wait) and pick the language */
export async function initPlatform(): Promise<void> {
  const ya = (window as any).YaGames;
  if (ya?.init) {
    try {
      ysdk = await Promise.race([ya.init(), new Promise((_, rej) => setTimeout(() => rej(new Error('sdk timeout')), 2500))]);
    } catch {
      ysdk = null;
    }
  }
  const code = ysdk?.environment?.i18n?.lang ?? new URLSearchParams(location.search).get('lang') ?? navigator.language;
  setLang(pickLang(code));
  try {
    ysdk?.on?.('game_api_pause', () => ((sdkPaused = true), emitPause()));
    ysdk?.on?.('game_api_resume', () => ((sdkPaused = false), emitPause()));
  } catch {
    /* old sdk */
  }
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
    emitPause();
  });
  window.addEventListener('blur', () => {
    hidden = true;
    emitPause();
  });
  window.addEventListener('focus', () => {
    hidden = document.hidden;
    emitPause();
  });
}

export function gameReady() {
  try {
    ysdk?.features?.LoadingAPI?.ready?.();
  } catch {
    /* ignore */
  }
}

export function gameplay(on: boolean) {
  if (on === playing) return;
  playing = on;
  try {
    if (on) ysdk?.features?.GameplayAPI?.start?.();
    else ysdk?.features?.GameplayAPI?.stop?.();
  } catch {
    /* ignore */
  }
}

/** cloud save (string JSON) */
export async function loadCloud(): Promise<string | null> {
  if (!ysdk) return null;
  try {
    player ??= await ysdk.getPlayer({ scopes: false });
    const d = await player.getData(['golazo']);
    return typeof d?.golazo === 'string' ? d.golazo : d?.golazo ? JSON.stringify(d.golazo) : null;
  } catch {
    return null;
  }
}
let saveTimer = 0;
export function saveCloud(json: string) {
  if (!ysdk) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      player ??= await ysdk.getPlayer({ scopes: false });
      await player.setData({ golazo: json }, true);
    } catch {
      /* offline / not logged in: local copy is still there */
    }
  }, 800);
}

/** interstitial between levels; `done` always fires */
export function showInterstitial(done: () => void) {
  if (!ysdk?.adv?.showFullscreenAdv) return done();
  let finished = false;
  const end = () => {
    if (finished) return;
    finished = true;
    adOpen = false;
    emitPause();
    done();
  };
  try {
    adOpen = true;
    emitPause();
    ysdk.adv.showFullscreenAdv({ callbacks: { onClose: end, onError: end, onOffline: end } });
    setTimeout(end, 90000);
  } catch {
    end();
  }
}

/** rewarded video; `rewarded(true)` when the player watched it */
export function showRewarded(rewarded: (ok: boolean) => void) {
  if (!ysdk?.adv?.showRewardedVideo) return rewarded(true); // outside Yandex the hint is free
  let got = false;
  const end = () => {
    adOpen = false;
    emitPause();
    rewarded(got);
  };
  try {
    adOpen = true;
    emitPause();
    ysdk.adv.showRewardedVideo({ callbacks: { onRewarded: () => (got = true), onClose: end, onError: () => ((got = false), end()) } });
  } catch {
    adOpen = false;
    emitPause();
    rewarded(false);
  }
}

export { lang };
