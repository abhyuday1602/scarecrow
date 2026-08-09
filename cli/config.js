import { readFileSync, writeFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { PERSONAS } from "../personas.js";
import { ALL_PROVIDERS } from "./env.js";
import { allPersonas } from "./personas-store.js";
import { configDir, configPath, ensureDir } from "./paths.js";
import { THEME_NAMES } from "./tui/themes.js";

export { configDir, configPath };

const providers = ALL_PROVIDERS;
const asBool = (v) => {
  if (/^(true|1|yes|on)$/i.test(v)) return true;
  if (/^(false|0|no|off)$/i.test(v)) return false;
  throw new Error(`expected true or false, got "${v}"`);
};
export const SETTINGS = {
  provider: { desc: `default provider (${providers.join(" | ")})`,
    coerce: (v) => { if (!providers.includes(v)) throw new Error(`unknown provider "${v}" — choose ${providers.join(", ")}`); return v; } },
  model: { desc: "default model id for the chosen provider", coerce: (v) => v },
  persona: { desc: `default persona (${Object.keys(PERSONAS).join(" | ")})`,
    coerce: (v) => { const all = allPersonas(); if (!all[v]) throw new Error(`unknown persona "${v}" — choose ${Object.keys(all).join(", ")}`); return v; } },
  steps: { desc: "default max steps for a session",
    coerce: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error(`expected a positive integer, got "${v}"`); return n; } },
  headed: { desc: "open a browser window during runs (default: on)", coerce: asBool },
  full: { desc: "glance the full scrollable page by default", coerce: asBool },
  color: { desc: "force color output on/off (otherwise auto)", coerce: asBool },
  device: { desc: "viewport preset: mobile | tablet | desktop | desktop-lg | desktop-xl",
    coerce: (v) => { const devices = ["mobile", "tablet", "desktop", "desktop-lg", "desktop-xl"]; if (!devices.includes(v)) throw new Error(`unknown device "${v}" — choose ${devices.join(", ")}`); return v; } },
  theme: { desc: `TUI color theme (${THEME_NAMES.join(" | ")})`,
    coerce: (v) => { if (!THEME_NAMES.includes(v)) throw new Error(`unknown theme "${v}" — choose ${THEME_NAMES.join(", ")}`); return v; } },
};

const DEFAULT_PROFILES = {
  default: { name: "Default", description: "Standard configuration", settings: {} },
};

function readRaw() {
  try {
    const p = configPath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeRaw(obj) {
  ensureDir(configDir());
  const tmp = join(configDir(), `.config.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, configPath());
}

function ensureProfiles(raw) {
  if (raw && raw.profiles && typeof raw.profiles === "object") {
    return { ...raw, profiles: { ...DEFAULT_PROFILES, ...raw.profiles } };
  }
  if (raw && typeof raw === "object" && !raw.profiles) {
    const migrated = { activeProfile: "default", profiles: { default: { name: "Default", description: "", settings: { ...raw } } } };
    writeRaw(migrated);
    return migrated;
  }
  return { activeProfile: "default", profiles: { ...DEFAULT_PROFILES } };
}

export function listProfiles() {
  const raw = readRaw();
  const doc = ensureProfiles(raw);
  return doc.profiles;
}

export function activeProfileName() {
  const raw = readRaw();
  const doc = ensureProfiles(raw);
  return doc.activeProfile || "default";
}

export function switchProfile(name) {
  const raw = readRaw();
  const doc = ensureProfiles(raw);
  if (!doc.profiles[name]) throw new Error(`no profile named "${name}"`);
  doc.activeProfile = name;
  writeRaw(doc);
}

export function createProfile(name, settings = {}, meta = {}) {
  const raw = readRaw();
  const doc = ensureProfiles(raw);
  if (doc.profiles[name]) throw new Error(`profile "${name}" already exists`);
  doc.profiles[name] = { name: meta.name || name, description: meta.description || "", settings: { ...settings } };
  writeRaw(doc);
}

export function deleteProfile(name) {
  if (name === "default") throw new Error("cannot delete the default profile");
  const raw = readRaw();
  const doc = ensureProfiles(raw);
  if (!doc.profiles[name]) throw new Error(`no profile named "${name}"`);
  delete doc.profiles[name];
  if (doc.activeProfile === name) doc.activeProfile = "default";
  writeRaw(doc);
}

export function loadConfig() {
  const raw = readRaw();
  const doc = ensureProfiles(raw);
  const active = doc.profiles[doc.activeProfile || "default"];
  return active ? { ...active.settings } : {};
}

export function saveConfig(obj) {
  const raw = readRaw();
  const doc = ensureProfiles(raw);
  const activeName = doc.activeProfile || "default";
  if (!doc.profiles[activeName]) doc.profiles[activeName] = { name: "Default", description: "", settings: {} };
  doc.profiles[activeName].settings = { ...obj };
  writeRaw(doc);
}

export function setSetting(key, rawValue) {
  if (!Object.hasOwn(SETTINGS, key)) throw new Error(`unknown setting "${key}" — see \`crow config\` for the list.`);
  const spec = SETTINGS[key];
  const value = spec.coerce(rawValue);
  const cfg = loadConfig();
  cfg[key] = value;
  saveConfig(cfg);
  return value;
}

export function unsetSetting(key) {
  if (!Object.hasOwn(SETTINGS, key)) throw new Error(`unknown setting "${key}".`);
  const cfg = loadConfig();
  const had = key in cfg;
  delete cfg[key];
  saveConfig(cfg);
  return had;
}

export function resetConfig() {
  try { rmSync(configPath()); return true; } catch { return false; }
}

export const pick = (flag, env, cfg, def) => flag ?? env ?? cfg ?? def;
