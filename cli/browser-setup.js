// cli/browser-setup.js — browser detection and lazy install for Playwright Chromium.
//
// Mirrors cli/ollama.js's pattern: a function that checks if the browser is present,
// and a function that installs it on demand. The actual install runs Playwright's own
// CLI, which has a polished progress bar — we let its output show through.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isInteractive, confirm, UserError } from "./ui.js";

export async function isBrowserInstalled() {
  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    return !!exe && existsSync(exe);
  } catch {
    return false;
  }
}

// Run the Playwright CLI bundled with *our* playwright dependency, with this same Node
// binary. `npx playwright` could resolve a different Playwright version (global, or a
// newer one from the registry) and install a browser revision ours can't launch; it also
// needed shell: true, which is a quoting hazard.
function installBrowser() {
  return new Promise((resolve, reject) => {
    let cli;
    try {
      // cli.js isn't in playwright's "exports"; package.json is, and its "bin" names the CLI.
      const require = createRequire(import.meta.url);
      const pkgPath = require.resolve("playwright/package.json");
      cli = join(dirname(pkgPath), require(pkgPath).bin.playwright);
    } catch (e) { reject(e); return; }
    const proc = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Install exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

export async function ensureBrowser() {
  if (await isBrowserInstalled()) return;

  if (!isInteractive()) {
    throw new UserError(
      "Playwright Chromium is not installed.\nRun `npx playwright install chromium`, then try again."
    );
  }

  const ok = await confirm(
    "Scarecrow needs Playwright's Chromium (~400 MB on disk) to run tests. Install it now?",
    true
  );
  if (!ok) {
    throw new UserError(
      'Browser required. Run `npx playwright install chromium` manually, then try again.'
    );
  }

  console.log("\nInstalling Chromium…");
  await installBrowser();
  console.log();

  if (!(await isBrowserInstalled())) {
    throw new UserError("Browser installation failed. Run `npx playwright install chromium` manually.");
  }
}
