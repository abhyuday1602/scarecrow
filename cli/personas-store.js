// cli/personas-store.js — user-defined personas, persisted as JSON next to the config
// file (<configDir>/personas.json). The built-in PERSONAS (personas.js) are always
// available; these are extras a user creates with `/persona-add` in the interactive UI.
// Built-ins win on a key collision and can never be overwritten or removed through here.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { PERSONAS } from "../personas.js";
import { configDir, personasPath, ensureDir } from "./paths.js";

// CLI-friendly keys: a lowercase slug (matches how the built-ins are keyed).
// Exported for the TUI persona-add wizard, which validates as the user types.
export const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

export const isBuiltin = (key) => Object.hasOwn(PERSONAS, key);

// The user store only. Returns {} if missing or corrupt — never throws — and drops any
// malformed entries so one bad record can't break persona selection everywhere.
export function userPersonas() {
  try {
    const obj = JSON.parse(readFileSync(personasPath(), "utf8"));
    if (!obj || typeof obj !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(obj))
      if (v && typeof v.name === "string" && typeof v.description === "string")
        out[k] = { name: v.name, description: v.description };
    return out;
  } catch {
    return {};
  }
}

// Built-ins + user personas merged. Built-ins take precedence on a key collision.
export const allPersonas = () => ({ ...userPersonas(), ...PERSONAS });

function saveUser(obj) {
  ensureDir(configDir());
  const tmp = join(configDir(), `.personas.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)  }\n`);
  renameSync(tmp, personasPath()); // atomic replace
}

// Create or update a user persona. Throws an Error (friendly message) on bad input.
export function addPersona(key, { name, description } = {}) {
  key = String(key || "").trim().toLowerCase();
  name = String(name || "").trim();
  description = String(description || "").trim();
  if (!KEY_RE.test(key)) throw new Error(`key must be lowercase letters, digits or hyphens (got "${key}")`);
  if (isBuiltin(key)) throw new Error(`"${key}" is a built-in persona — pick another key`);
  if (!name) throw new Error("a name is required");
  if (!description) throw new Error("a description is required");
  const store = userPersonas();
  store[key] = { name, description };
  saveUser(store);
  return { key, name, description };
}

export function removePersona(key) {
  if (isBuiltin(key)) throw new Error(`"${key}" is a built-in persona and can't be removed`);
  const store = userPersonas();
  if (!Object.hasOwn(store, key)) return false;
  delete store[key];
  saveUser(store);
  return true;
}
