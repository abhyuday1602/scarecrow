import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyTerminalBg, resetTerminalBg } from "../cli/tui/terminalBg.js";
import { THEMES } from "../cli/tui/themes.js";

describe("terminalBg", () => {
  let writes;
  let writeSpy;
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    writes = [];
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((s) => { writes.push(s); return true; });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    process.stdout.isTTY = originalIsTTY;
  });

  it("emits OSC 11 with the hex color on a TTY", () => {
    process.stdout.isTTY = true;
    applyTerminalBg("#190a0c");
    expect(writes).toEqual(["\x1b]11;#190a0c\x07"]);
  });

  it("emits OSC 111 to reset on a TTY", () => {
    process.stdout.isTTY = true;
    resetTerminalBg();
    expect(writes).toEqual(["\x1b]111\x07"]);
  });

  it("writes nothing when stdout is not a TTY", () => {
    process.stdout.isTTY = false;
    applyTerminalBg("#190a0c");
    resetTerminalBg();
    expect(writes).toEqual([]);
  });

  it("writes nothing for a missing color", () => {
    process.stdout.isTTY = true;
    applyTerminalBg(undefined);
    expect(writes).toEqual([]);
  });
});

describe("theme backgrounds", () => {
  it("every theme has a valid hex bg, highlight, and surface", () => {
    for (const t of Object.values(THEMES)) {
      for (const key of ["bg", "highlight", "surface"]) {
        expect(t[key], `${t.name}.${key}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("no two themes share a bg", () => {
    const bgs = Object.values(THEMES).map((t) => t.bg);
    expect(new Set(bgs).size).toBe(bgs.length);
  });
});
