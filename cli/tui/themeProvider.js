// cli/tui/themeProvider.js — React context for theme management. Provides the current
// theme to all components and allows switching themes at runtime.

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { THEMES, DEFAULT_THEME } from "./themes.js";
import { applyTerminalBg } from "./terminalBg.js";
import { html } from "./html.js";

const ThemeContext = createContext(null);

export function ThemeProvider({ children, initialTheme = DEFAULT_THEME }) {
  const [themeName, setThemeName] = useState(initialTheme);
  const theme = THEMES[themeName] || THEMES[DEFAULT_THEME];

  // Tint the whole terminal to the theme's bg. Runs on every switch, so the picker's
  // live preview (and its revert-on-cancel) repaints the screen too. startTui resets it
  // back to the terminal default on exit.
  useEffect(() => {
    applyTerminalBg(theme.bg);
  }, [theme.bg]);

  const switchTheme = useCallback((name) => {
    if (THEMES[name]) {
      setThemeName(name);
      return true;
    }
    return false;
  }, []);

  const value = {
    themeName,
    theme,
    switchTheme,
    themes: THEMES,
  };

  return html`<${ThemeContext.Provider} value=${value}>${children}<//>`;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
