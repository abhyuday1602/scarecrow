import { spawn, execSync, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { registerCleanup } from "./cleanup.js";

let daemonProc = null;
let startedByUs = false;

// Cross-platform binary lookup: `which` on Unix, `where` on Windows.
const WHICH = process.platform === "win32" ? "where" : "which";

export function isOllamaInstalled() {
  try {
    execFileSync(WHICH, ["ollama"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function isOllamaRunning() {
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function listInstalledModels() {
  try {
    const out = execSync("ollama list", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().split("\n").slice(1).map((l) => {
      const parts = l.split(/\s+/);
      // parts: [name, id, size, unit?, ...rest...]
      // size col can be "2.1 GB" (3 tokens) or "886 MB" or "4.5GB" (2 tokens)
      let sizeStr = parts[2];
      if (parts[3] && /^(GB|MB|KB)$/i.test(parts[3])) sizeStr += parts[3];
      return { name: parts[0], sizeStr };
    });
  } catch {
    return [];
  }
}

export function removeModel(model) {
  // execFileSync avoids shell interpolation — a model name can't inject commands.
  execFileSync("ollama", ["rm", model], { stdio: "pipe" });
}

export async function isModelInstalled(model) {
  try {
    const out = execSync("ollama list", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const lines = out.trim().split("\n").slice(1);
    return lines.some((l) => {
      const name = l.split(/\s+/)[0];
      return name === model || name.startsWith(`${model}:`);
    });
  } catch {
    return false;
  }
}

export async function waitForDaemon(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isOllamaRunning()) return true;
    await sleep(500);
  }
  return false;
}

export function startDaemon() {
  if (startedByUs && daemonProc) return daemonProc;
  daemonProc = spawn("ollama", ["serve"], { stdio: "ignore", detached: false });
  startedByUs = true;
  // Fallback for external kills / crashes; the CLI flow (commands.js) also stops the
  // daemon itself in its own `finally`, and the Set-based registry dedupes this reference
  // across repeated startDaemon() calls (e.g. batch mode).
  registerCleanup(stopDaemon, { sync: true });
  daemonProc.on("exit", () => { daemonProc = null; startedByUs = false; });
  return daemonProc;
}

export function stopDaemon() {
  if (startedByUs && daemonProc) {
    daemonProc.kill("SIGTERM");
    daemonProc = null;
    startedByUs = false;
  }
}

export function pullModel(model, onProgress) {
  const proc = spawn("ollama", ["pull", model], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buf = "";

  const parseLine = (line) => {
    const trimmed = line.replace(/\r/g, "").trim();
    if (!trimmed) return null;

    if (/^pulling\s+\S+\.\.\.\s*$/.test(trimmed)) {
      return { phase: "resolving", percent: 0, label: trimmed };
    }

    const pullMatch = trimmed.match(/^pulling\s+\S+\.\.\.\s+(\d+)%\s+.*?(\d+\.?\d*)\s*(GB|MB)\/(\d+\.?\d*)\s*(GB|MB)\s+(\S+)\s+(.+)$/);
    if (pullMatch) {
      return {
        phase: "pulling",
        percent: parseInt(pullMatch[1], 10),
        currentSize: `${pullMatch[2]} ${pullMatch[3]}`,
        totalSize: `${pullMatch[4]} ${pullMatch[5]}`,
        speed: pullMatch[6],
        eta: pullMatch[7].replace(/\s*$/, ""),
      };
    }

    const phaseMatch = trimmed.match(/^(verifying|writing|success|error)/);
    if (phaseMatch) {
      return { phase: phaseMatch[1], percent: phaseMatch[1] === "success" ? 100 : undefined, label: trimmed };
    }

    return { phase: "unknown", label: trimmed };
  };

  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";

    let lastProgress = null;
    for (const raw of lines) {
      const parsed = parseLine(raw);
      if (parsed) lastProgress = parsed;
    }
    if (lastProgress) onProgress(lastProgress);
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.trim()) onProgress({ phase: "error", label: text.trim() });
  });

  return proc;
}

export function installOllama(onProgress) {
  const proc = spawn("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const emit = (text) => { if (onProgress) onProgress(text); };
  let buf = "";
  const onData = (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) emit(line.trim());
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  return proc;
}

export function openOllamaTerminal(action, model) {
  // Build the command string safely. For "pull", the model name is validated by
  // the picker (curated list / `ollama list` output), but we still avoid shell
  // interpolation in the construction to be defense-in-depth.
  const safeModel = String(model || "qwen3-vl").replace(/[^a-zA-Z0-9._:/-]/g, "");
  const cmds = {
    install: "curl -fsSL https://ollama.com/install.sh | sh",
    serve: "ollama serve",
    pull: `ollama pull ${safeModel}`,
  };
  const cmd = cmds[action];
  if (!cmd) throw new Error(`Unknown action: ${action}`);

  const plat = process.platform;

  if (plat === "darwin") {
    const escaped = cmd.replace(/"/g, '\\"').replace(/'/g, "'\\''");
    spawn("osascript", ["-e", `tell app "Terminal" to do script "${escaped}"`], { stdio: "ignore" });
    return;
  }

  if (plat === "win32") {
    spawn("cmd", ["/c", "start", "cmd", "/k", cmd], { stdio: "ignore", shell: true });
    return;
  }

  // Linux: try common terminal emulators
  const terms = [
    { cmd: "x-terminal-emulator", args: ["-e", "sh", "-c", cmd] },
    { cmd: "gnome-terminal", args: ["--", "sh", "-c", cmd] },
    { cmd: "xterm", args: ["-e", cmd] },
    { cmd: "konsole", args: ["-e", cmd] },
    { cmd: "xfce4-terminal", args: ["-e", cmd] },
  ];
  for (const t of terms) {
    try { execFileSync(WHICH, [t.cmd], { stdio: "ignore" }); spawn(t.cmd, t.args, { stdio: "ignore" }); return; }
    catch { /* terminal not found, try next */ }
  }
  console.error(`Could not open terminal. Run this command manually:\n  ${cmd}`);
}
