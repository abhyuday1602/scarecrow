// cli/tui/slash.js — the "/" command registry. One entry per command: a name, an
// optional argument hint (for the menu), a one-line summary, and a handler that acts on
// the `api` the App provides. This is the single source of truth for both the
// autocomplete menu and `/help`. Validation reuses the same coercers the CLI uses.

import { allPersonas, removePersona } from "../personas-store.js";
import { SETTINGS } from "../config.js";
import { normalizeUrl } from "../args.js";

export const COMMANDS = [
  { name: "walkthrough", summary: "step-by-step click-through mode",
    handler: (api) => api.setSession({ mode: "walkthrough" }) },
  { name: "glance", summary: "one-screenshot first-impression mode",
    handler: (api) => api.setSession({ mode: "glance" }) },

  { name: "persona", args: "[key]", summary: "choose who is testing the site",
    handler: (api, arg) => {
      if (!arg) return api.openPersonaPicker();
      const all = allPersonas();
      if (!all[arg]) return api.error(`unknown persona "${arg}" — try /personas`);
      api.setSession({ personaKey: arg });
      api.message(`persona → ${all[arg].name} (${arg})`);
    } },
  { name: "persona-add", summary: "create a new persona",
    handler: (api) => api.openPersonaAdd() },
  { name: "persona-remove", args: "[key]", summary: "delete a custom persona",
    handler: (api, arg) => {
      if (!arg) return api.openPersonaRemove();
      try {
        const ok = removePersona(arg);
        api.message(ok ? `removed persona "${arg}"` : `no custom persona "${arg}"`);
        if (ok && api.session.personaKey === arg) api.setSession({ personaKey: undefined });
      } catch (e) { api.error(e.message); }
    } },
  { name: "personas", summary: "list all personas",
    handler: (api) => api.listPersonas() },

  { name: "url", args: "<address>", summary: "set the target URL",
    handler: (api, arg) => {
      if (!arg.trim()) return api.error("add the address — e.g. /url acme.com");
      const u = normalizeUrl(arg.trim());
      api.setSession({ url: u }); api.message(`url → ${u}`);
    } },
  { name: "task", args: "<goal>", summary: "set the goal (or just type it)",
    handler: (api, arg) => {
      if (!arg.trim()) return api.error("describe the goal — e.g. /task sign up for a trial");
      api.setSession({ task: arg.trim() }); api.message(`goal → ${arg.trim()}`);
    } },
  { name: "steps", args: "<n>", summary: "max actions per run",
    handler: (api, arg) => {
      try { const n = SETTINGS.steps.coerce(arg.trim()); api.setSession({ steps: n }); api.message(`steps → ${n}`); }
      catch (e) { api.error(e.message); }
    } },

  { name: "provider", args: "[name]", summary: "set or edit provider API keys",
    handler: async (api, arg) => {
      if (!arg) return api.openKeyManager();
      const { listProviders } = await import("../../llm.js");
      const provs = listProviders();
      const p = provs.find((x) => x.name === arg.trim().toLowerCase());
      if (!p) return api.error(`unknown provider "${arg}" — choose ${provs.map((x) => x.name).join(", ")}`);
      api.editProviderKey(p.name);
    } },
  { name: "model", args: "[id]", summary: "pick provider + model (searchable); or pass an id",
    handler: (api, arg) => {
      if (!arg.trim()) return api.openModelPicker();
      api.setSession({ model: arg.trim() }); api.message(`model → ${arg.trim()}`);
    } },
  { name: "model-rm", summary: "remove an installed Ollama model",
    handler: (api) => api.openModelRemove() },

  { name: "headed", summary: "show the browser window during runs",
    handler: (api) => { api.setSession({ headed: true }); api.message("browser → headed (visible)"); } },
  { name: "headless", summary: "hide the browser window during runs",
    handler: (api) => { api.setSession({ headed: false }); api.message("browser → headless"); } },
  { name: "device", args: "[preset]", summary: "viewport preset: mobile | tablet | desktop | desktop-lg | desktop-xl",
    handler: (api, arg) => {
      const devices = [
        { value: "desktop", label: "desktop", hint: "1280×800" },
        { value: "desktop-lg", label: "desktop-lg", hint: "1440×900" },
        { value: "desktop-xl", label: "desktop-xl", hint: "1920×1080" },
        { value: "tablet", label: "tablet", hint: "768×1024 (iPad)" },
        { value: "mobile", label: "mobile", hint: "390×844 (iPhone)" },
      ];
      const apply = (d) => { api.setSession({ device: d }); api.message(`device → ${d}`); };
      if (!arg) return api.choose({ title: "Choose a device preset", items: devices, initial: api.session.device, onPick: apply });
      const d = arg.trim().toLowerCase();
      if (!devices.some((x) => x.value === d)) return api.error(`unknown device "${d}" — choose mobile, tablet, desktop, desktop-lg, or desktop-xl`);
      apply(d);
    } },
  { name: "theme", args: "[name]", summary: "TUI color theme — opens a picker (or pass a name)",
    handler: async (api, arg) => {
      const { THEMES, THEME_NAMES } = await import("./themes.js");
      if (!arg) return api.openThemePicker();
      const t = arg.trim().toLowerCase();
      if (!THEMES[t]) return api.error(`unknown theme "${t}" — choose ${THEME_NAMES.join(", ")}`);
      api.setTheme(t);
    } },
  { name: "full", summary: "toggle full-page glance",
    handler: (api) => { const v = !api.session.full; api.setSession({ full: v }); api.message(`full-page glance → ${v ? "on" : "off"}`); } },
  { name: "success", args: "<text>", summary: "objective success marker (walkthrough)",
    handler: (api, arg) => { const v = arg.trim() || null; api.setSession({ success: v }); api.message(v ? `success marker → "${v}"` : "success marker cleared"); } },
  { name: "upload", args: "[files]", summary: "attach files (bare = whole uploads/ folder)",
    handler: (api, arg) => {
      const v = arg.trim() ? arg.trim() : true;
      api.setSession({ upload: v });
      api.message(typeof v === "string" ? `uploads → ${v}` : "uploads → entire uploads/ folder");
    } },
  { name: "record", summary: "toggle video recording of the session",
    handler: (api) => { const v = !api.session.record; api.setSession({ record: v }); api.message(`video recording → ${v ? "on" : "off"}`); } },
  { name: "a11y", summary: "toggle accessibility audit (axe-core) on each page",
    handler: (api) => { const v = !api.session.a11y; api.setSession({ a11y: v }); api.message(`accessibility audit → ${v ? "on" : "off"}`); } },
  { name: "export-format", args: "[format]", summary: "set export format: html | junit | json",
    handler: (api, arg) => {
      const formats = [
        { value: "html", label: "html", hint: "self-contained report page" },
        { value: "junit", label: "junit", hint: "JUnit XML for CI" },
        { value: "json", label: "json", hint: "raw findings data" },
      ];
      const apply = (f) => { api.setSession({ exportFormat: f }); api.message(`export format → ${f}`); };
      if (!arg) return api.choose({ title: "Choose an export format", items: formats, initial: api.session.exportFormat || "html", onPick: apply });
      const f = arg.trim().toLowerCase();
      if (!formats.some((x) => x.value === f)) return api.error(`unknown format "${f}" — choose html, junit, or json`);
      apply(f);
    } },
  { name: "output-type", args: "[format]", summary: "set session output type: html | junit | json",
    handler: (api, arg) => {
      const formats = [
        { value: "html", label: "html", hint: "self-contained report page" },
        { value: "junit", label: "junit", hint: "JUnit XML for CI" },
        { value: "json", label: "json", hint: "raw findings data" },
      ];
      const apply = (f) => { api.setSession({ exportFormat: f }); api.message(`output type → ${f}`); };
      if (!arg) return api.choose({ title: "Choose an output type", items: formats, initial: api.session.exportFormat || "html", onPick: apply });
      const f = arg.trim().toLowerCase();
      if (!formats.some((x) => x.value === f)) return api.error(`unknown output type "${f}" — choose html, junit, or json`);
      apply(f);
    } },
  { name: "export", args: "[path]", summary: "export findings in the set format",
    handler: async (api, arg) => {
      const format = api.session.exportFormat || "html";
      const path = arg.trim() || api.session.lastFindingsPath;
      if (!path) return api.error("nothing to export yet — run a session first, or pass a path: /export runs/<ts>/findings.json");
      try {
        const { saveExport } = await import("../export.js");
        const { resolve, dirname } = await import("node:path");
        const resolved = resolve(path);
        const outPath = saveExport(resolved, format, dirname(resolved));
        api.message(`exported to ${outPath}`);
      } catch (e) {
        api.error(`export failed: ${e.message}`);
      }
    } },

  { name: "rerun", summary: "rerun a past session's configuration",
    handler: (api) => api.openRerunPicker() },

  { name: "config", summary: "show current settings",
    handler: (api) => api.showConfig() },
  { name: "save", summary: "save current settings as defaults",
    handler: (api) => api.saveDefaults() },
  { name: "profile", args: "[name]", summary: "switch config profile, or list profiles",
    handler: (api, arg) => {
      if (!arg) return api.openProfilePicker();
      try { api.switchProfile(arg.trim()); } catch (e) { api.error(e.message); }
    } },
  { name: "profile-create", args: "<name>", summary: "save current session as a new named profile",
    handler: (api, arg) => {
      if (!arg.trim()) return api.error("provide a profile name — e.g. /profile-create quick-test");
      api.createProfile(arg.trim());
    } },
  { name: "profile-delete", summary: "remove a saved profile",
    handler: (api) => api.openProfileDelete() },
  { name: "doctor", summary: "check setup (keys, browser, model)",
    handler: (api) => api.doctor() },
  { name: "providers", summary: "list all providers and their status",
    handler: (api) => api.listProviders() },
  { name: "clear", summary: "clear the screen",
    handler: (api) => api.clear() },
  { name: "logs", summary: "browse session logs",
    handler: (api) => api.openLogsBrowser() },
  { name: "help", summary: "show commands & keys",
    handler: (api) => api.help() },
  { name: "quit", summary: "exit Scarecrow",
    handler: (api) => api.quit() },
  { name: "exit", summary: "exit Scarecrow",
    handler: (api) => api.quit() },
];

COMMANDS.sort((a, b) => a.name.localeCompare(b.name));

const COMMAND_MAP = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));

// Commands matching a typed prefix (without the leading "/"): exact-prefix first, then
// substring matches, so "/per" surfaces persona/personas/persona-add near the top.
export function filterCommands(prefix) {
  prefix = (prefix || "").toLowerCase().trimStart();
  if (!prefix) return COMMANDS.filter((c) => c.name !== "exit");
  const starts = COMMANDS.filter((c) => c.name.startsWith(prefix));
  const includes = COMMANDS.filter((c) => !c.name.startsWith(prefix) && c.name.includes(prefix));
  return [...starts, ...includes];
}

// Parse and dispatch a raw "/command args" line.
export function runSlash(api, raw) {
  const body = raw.replace(/^\//, "");
  const sp = body.indexOf(" ");
  const name = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
  const arg = sp < 0 ? "" : body.slice(sp + 1);
  const cmd = COMMAND_MAP[name];
  if (!cmd) return api.error(`unknown command "/${name}" — type /help`);
  return cmd.handler(api, arg);
}
