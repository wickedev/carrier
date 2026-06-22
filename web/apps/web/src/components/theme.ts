import { create } from "zustand";

export type Theme = "light" | "dark";

const STORAGE_KEY = "carrier.theme";

function readInitial(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

export const useTheme = create<ThemeState>((set, get) => {
  const initial = readInitial();
  apply(initial);
  return {
    theme: initial,
    setTheme: (theme) => {
      apply(theme);
      try {
        window.localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        /* ignore */
      }
      set({ theme });
    },
    toggle: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  };
});
