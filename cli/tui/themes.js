// cli/tui/themes.js — the TUI color themes. Each theme defines a full palette (backgrounds,
// text, accent, borders, and semantic statuses) plus a one-line `blurb` shown as the hint in
// the theme picker. The active theme is loaded from config and applied via the ThemeProvider
// React context; every colored surface in the UI reads from it (see input.js / runView.js /
// app.js / overlays.js), so switching themes visibly recolors the whole interface.
//
// `bg` is painted onto the terminal itself via OSC 11 (see terminalBg.js), so it fills the
// whole viewport — keep it a *subtle tint* of the theme's hue, not a vivid wash: at these
// lightness levels that means an RGB channel spread of roughly 4–10 (cursor is 2, real
// Discord/Claude app backgrounds are 2–4). The theme's identity lives in the accent and the
// `surface` band painted behind the header and status footer (see app.js `Bar`; Ink can't
// fill a <Box> background), which may be richer. `highlight` sits between the two for
// selection rows. Keep bg < highlight < surface in lightness, all in the same hue family.
// discord and claude use the actual product colors (Discord's #1e1f22/#2b2d31/#313338 layer
// stack; claude.ai dark mode's hsl(60 3% 13%) warm grays).
//
// Object order is the picker order: `cursor` (the default) is first, `gotham` is last.

export const THEMES = {
  // Sleek, Cursor-editor-style dark: near-black with a crisp silver-white accent, but it
  // keeps colored severity/verdict status so it reads as a clean neutral default.
  cursor: {
    name: "cursor",
    blurb: "sleek editor dark",
    bg: "#0d0d0f",
    fg: "#e6e6ea",
    accent: "#e8e8ec",
    muted: "#6e6e78",
    border: "#26262c",
    success: "#4ec9a5",
    warning: "#d7ba7d",
    error: "#f14c4c",
    info: "#9aa0ff",
    highlight: "#1b1b21",
    surface: "#202028",
  },
  // Product-inspired palettes — the actual colors those apps ship in dark mode, with the brand
  // accent doing the talking.
  discord: {
    name: "discord",
    blurb: "blurple (Discord)",
    bg: "#1e1f22",
    fg: "#dbdee1",
    accent: "#5865f2",
    muted: "#949ba4",
    border: "#2b2d31",
    success: "#23a55a",
    warning: "#f0b232",
    error: "#f23f43",
    info: "#5865f2",
    highlight: "#2b2d31",
    surface: "#313338",
  },
  claude: {
    name: "claude",
    blurb: "warm clay (Claude)",
    bg: "#222220",
    fg: "#f0e6dd",
    accent: "#d97757",
    muted: "#96826f",
    border: "#2c231d",
    success: "#7fb069",
    warning: "#e0a458",
    error: "#e5534b",
    info: "#d99a7c",
    highlight: "#2c2c29",
    surface: "#393937",
  },
  // Named terminal palettes — canonical values from the upstream color schemes, used verbatim
  // (these are exempt from the subtle-tint spread rule above; their bg IS the brand).
  tokyo: {
    name: "tokyo",
    blurb: "neon navy (Tokyo Night)",
    bg: "#1a1b26",
    fg: "#c0caf5",
    accent: "#7aa2f7",
    muted: "#565f89",
    border: "#292e42",
    success: "#9ece6a",
    warning: "#e0af68",
    error: "#f7768e",
    info: "#7dcfff",
    highlight: "#24283b",
    surface: "#283457",
  },
  catppuccin: {
    name: "catppuccin",
    blurb: "soft pastels (Catppuccin)",
    bg: "#24273a",
    fg: "#cad3f5",
    accent: "#c6a0f6",
    muted: "#5b6078",
    border: "#363a4f",
    success: "#a6da95",
    warning: "#eed49f",
    error: "#ed8796",
    info: "#8aadf4",
    highlight: "#363a4f",
    surface: "#494d64",
  },
  gruvbox: {
    name: "gruvbox",
    blurb: "retro earth (Gruvbox)",
    bg: "#282828",
    fg: "#dfbf8e",
    accent: "#a9b665",
    muted: "#5a524c",
    border: "#3c3836",
    success: "#a9b665",
    warning: "#d8a657",
    error: "#ea6962",
    info: "#7daea3",
    highlight: "#32302f",
    surface: "#45403d",
  },
  ocean: {
    name: "ocean",
    blurb: "teal depths",
    bg: "#0b1318",
    fg: "#cfe6f0",
    accent: "#22d3ee",
    muted: "#5b7d8c",
    border: "#142836",
    success: "#2dd4bf",
    warning: "#eab308",
    error: "#f87171",
    info: "#38bdf8",
    highlight: "#0e2c39",
    surface: "#0f3a4a",
  },
  rose: {
    name: "rose",
    blurb: "magenta bloom",
    bg: "#110d10",
    fg: "#f0dce8",
    accent: "#ff4d9d",
    muted: "#9c6f86",
    border: "#2e1826",
    success: "#86efac",
    warning: "#fbbf77",
    error: "#fb7185",
    info: "#c084fc",
    highlight: "#2e1526",
    surface: "#3a1a2e",
  },
  // Brutalist black-and-signal-yellow, inspired by modern Batman gear: OLED-black bg pushes
  // the UI into shadow, industrial silver text and utility-belt yellow cut through it.
  gotham: {
    name: "gotham",
    blurb: "black & signal yellow",
    bg: "#080808",
    fg: "#d8d8db",
    accent: "#fada5e",
    muted: "#414144",
    border: "#29292c",
    success: "#3fb950",
    warning: "#fada5e",
    error: "#e50000",
    info: "#9aa3ad",
    highlight: "#1a1a1d",
    surface: "#232328",
  },
};

// Get Ink-compatible color from theme (Ink accepts hex directly).
export function themeColor(theme, colorName) {
  return theme[colorName] || theme.fg;
}

// Contrast color for a background (for text on colored backgrounds).
export function contrastColor(theme, bgColor) {
  const r = parseInt(bgColor.slice(1, 3), 16);
  const g = parseInt(bgColor.slice(3, 5), 16);
  const b = parseInt(bgColor.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? theme.bg : theme.fg;
}

// Picker order + theme names.
export const THEME_NAMES = Object.keys(THEMES);

// Default theme (a fresh install with no saved config lands here).
export const DEFAULT_THEME = "cursor";

// Old theme keys from before the rename, mapped to their closest current match so an existing
// saved `config.theme` doesn't silently reset. Anything not found falls back to DEFAULT_THEME.
const LEGACY_ALIASES = {
  dark: "gotham",
  nord: "ocean",
  mono: "cursor", // removed — grayscale overlapped cursor
  light: "cursor", // removed — cursor is the neutral successor for a light look
  netflix: "gotham", // removed — red-black niche folded into gotham's black + crimson alerts
  forest: "gruvbox", // removed — organic-green niche covered by gruvbox's olive earth tones
  amber: "gruvbox", // removed — it was built from gruvbox status colors anyway
  violet: "catppuccin", // removed — dracula-purple overlapped catppuccin's mauve
  dracula: "catppuccin",
};

// Resolve any theme name (current, legacy alias, or unknown) to a valid current key.
export function resolveThemeName(name) {
  if (name && THEMES[name]) return name;
  const alias = name && LEGACY_ALIASES[name];
  if (alias && THEMES[alias]) return alias;
  return DEFAULT_THEME;
}
