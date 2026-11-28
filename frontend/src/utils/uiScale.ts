const STORAGE_KEY = 'meridian.ui_scale.v1';

export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.4;
export const UI_SCALE_STEP = 0.05;
export const UI_SCALE_DEFAULT = 1;
export const UI_SCALE_PRESETS = [0.85, 0.9, 1, 1.1, 1.2, 1.3];

export function clampUiScale(value: number): number {
  if (!Number.isFinite(value)) return UI_SCALE_DEFAULT;
  const clamped = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, value));
  return Math.round(clamped * 100) / 100;
}

export function getStoredUiScale(): number {
  if (typeof window === 'undefined') return UI_SCALE_DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return UI_SCALE_DEFAULT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampUiScale(parsed) : UI_SCALE_DEFAULT;
  } catch {
    return UI_SCALE_DEFAULT;
  }
}

export function applyUiScale(scale: number): number {
  const next = clampUiScale(scale);
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--ui-scale', String(next));
  }
  return next;
}

export function setUiScale(scale: number): number {
  const next = applyUiScale(scale);
  if (typeof window !== 'undefined') {
    try {
      if (Math.abs(next - UI_SCALE_DEFAULT) < 0.001) {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      }
    } catch {
      /* ignore storage errors */
    }
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
  }
  return next;
}

export function initUiScale(): number {
  return applyUiScale(getStoredUiScale());
}
