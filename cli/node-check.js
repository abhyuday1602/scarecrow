// cli/node-check.js — refuse an unsupported Node runtime in our own words.
//
// Without this, the first error someone on an old Node sees comes from Playwright
// ("Playwright requires Node.js 20 or higher") — a dependency they never installed
// directly, raised only once a command happens to reach the browser. Checking up front
// names Scarecrow, names their actual version, and fires the same way for every command.
//
// The supported range is read from package.json's "engines" field rather than repeated
// here, so the check and the manifest cannot drift apart.

// Does `current` satisfy `range`?  Deliberately narrow: it understands only the two
// clause shapes an engines field of ours actually uses — "^maj.min.patch" and ">=maj" —
// and treats anything else as satisfied. A version guard that can't parse its own range
// should get out of the way, not block a working install.
export function isUnsupportedNode(range, current = process.versions.node) {
  if (typeof range !== "string" || !range.trim()) return false;

  const [cMaj, cMin, cPat] = String(current).split(".").map(Number);
  if (![cMaj, cMin, cPat].every(Number.isInteger)) return false; // unparseable runtime

  for (const clause of range.split("||").map((s) => s.trim()).filter(Boolean)) {
    // "^maj.min.patch" → >= that version, but pinned to the same major
    const caret = clause.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
    if (caret) {
      const [maj, min, pat] = caret.slice(1).map(Number);
      if (cMaj === maj && (cMin > min || (cMin === min && cPat >= pat))) return false;
      continue;
    }
    // ">=maj" → any release of that major or later
    const gte = clause.match(/^>=\s*(\d+)$/);
    if (gte) {
      if (cMaj >= Number(gte[1])) return false;
      continue;
    }
    return false; // clause shape we don't recognize — don't block on it
  }
  return true; // every clause understood, none satisfied
}

// The message shown when the runtime is too old. Plain text; the caller adds color.
export const unsupportedNodeMessage = (range, current = process.versions.node) =>
  `Scarecrow needs Node.js ${range} — this is v${current}.\n` +
  `Upgrade at https://nodejs.org, or switch versions with nvm/fnm if you have one.`;
