// cli/paths.js — filesystem locations for persisted state, in one place so several
// modules can share them without import cycles. Follows the XDG base-dir convention
// ($XDG_CONFIG_HOME/scarecrow, falling back to ~/.config/scarecrow).

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import os from "node:os";

export const configDir = () =>
  join(process.env.XDG_CONFIG_HOME || join(os.homedir(), ".config"), "scarecrow");
export const configPath = () => join(configDir(), "config.json");
export const personasPath = () => join(configDir(), "personas.json");

// Create a directory (recursively) mode 0o700 — these hold sensitive data: API keys
// (config dir), prompts/screenshots sent to an LLM (run dirs), session logs. `mode` is a
// no-op on Windows, where NTFS ACLs already scope a user's profile directory to that user.
export const ensureDir = (dir) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
