// cli/browser-setup.js — browser detection and lazy install for Playwright Chromium.
//
// Mirrors cli/ollama.js's pattern: a function that checks if the browser is present,
// and a function that installs it on demand. The actual install runs Playwright's own
// CLI, which has a polished progress bar — we let its output show through.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
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

function installBrowser() {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["playwright", "install", "chromium"], {
      stdio: "inherit",
      shell: true,
    });
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
    "Scarecrow needs a headless browser (~150 MB) to run tests. Install it now?",
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
