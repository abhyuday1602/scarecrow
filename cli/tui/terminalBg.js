// cli/tui/terminalBg.js — paint the terminal's own background to match the theme. Ink can't
// fill a <Box> background, so instead of faking a full-screen fill cell-by-cell we ask the
// emulator directly: OSC 11 sets the terminal background color, OSC 111 restores its
// configured default. Modern emulators (kitty, alacritty, wezterm, foot, VTE, iTerm2,
// Windows Terminal) honor both; anything else silently ignores them, so themes degrade to
// accent-only there. Inside tmux without `allow-passthrough` the sequence may be swallowed.

export function applyTerminalBg(hex) {
  if (!process.stdout.isTTY || !hex) return;
  process.stdout.write(`\x1b]11;${hex}\x07`);
}

export function resetTerminalBg() {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b]111\x07");
}
