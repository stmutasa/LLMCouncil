import hljsLight from 'highlight.js/styles/github.css?inline';
import hljsDark from 'highlight.js/styles/github-dark.css?inline';
import { useStore, type ThemePreference } from './store';

/**
 * The two highlight.js themes target the same selectors, so they cannot both be imported as
 * ordinary stylesheets. Both are injected and the one for the inactive theme is disabled.
 */
function injectStyle(css: string, id: string): HTMLStyleElement {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLStyleElement) return existing;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  // First in <head> so the app's own styles, loaded later, can override the themes.
  document.head.prepend(el);
  return el;
}

function resolve(pref: ThemePreference, media: MediaQueryList): 'light' | 'dark' {
  if (pref === 'system') return media.matches ? 'dark' : 'light';
  return pref;
}

/** Applies the theme preference now and whenever it, or the system setting, changes. */
export function startTheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const light = injectStyle(hljsLight, 'hljs-light');
  const dark = injectStyle(hljsDark, 'hljs-dark');

  const apply = () => {
    const resolved = resolve(useStore.getState().theme, media);
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
    light.disabled = resolved === 'dark';
    dark.disabled = resolved === 'light';
  };

  apply();
  let last = useStore.getState().theme;
  const unsubscribe = useStore.subscribe((s) => {
    if (s.theme !== last) {
      last = s.theme;
      apply();
    }
  });
  media.addEventListener('change', apply);
  return () => {
    unsubscribe();
    media.removeEventListener('change', apply);
  };
}
