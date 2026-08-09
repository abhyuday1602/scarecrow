import { describe, it, expect } from "vitest";
import { isUnsupportedNode, unsupportedNodeMessage } from "../cli/node-check.js";

// The range package.json actually declares. Kept literal so a change to engines.node
// that this parser can't handle shows up as a failure here rather than at a user's
// terminal.
const RANGE = "^20.19.0 || ^22.13.0 || >=24";

describe("isUnsupportedNode", () => {
  it("rejects a major below every clause", () => {
    expect(isUnsupportedNode(RANGE, "18.19.1")).toBe(true);
  });

  it("rejects a version that is only a patch line short of the floor", () => {
    // The case that actually bit us: 20.18.1 satisfies a naive ">=20" but not ^20.19.0.
    expect(isUnsupportedNode(RANGE, "20.18.1")).toBe(true);
  });

  it("accepts the exact floor of a caret clause", () => {
    expect(isUnsupportedNode(RANGE, "20.19.0")).toBe(false);
  });

  it("accepts later patches and minors within a caret clause", () => {
    expect(isUnsupportedNode(RANGE, "20.19.4")).toBe(false);
    expect(isUnsupportedNode(RANGE, "20.20.0")).toBe(false);
  });

  it("rejects an odd-numbered major that no clause covers", () => {
    expect(isUnsupportedNode(RANGE, "21.7.0")).toBe(true);
  });

  it("honors the second caret clause independently", () => {
    expect(isUnsupportedNode(RANGE, "22.12.0")).toBe(true);
    expect(isUnsupportedNode(RANGE, "22.13.0")).toBe(false);
  });

  it("accepts anything at or past the >= clause", () => {
    expect(isUnsupportedNode(RANGE, "24.0.0")).toBe(false);
    expect(isUnsupportedNode(RANGE, "26.3.1")).toBe(false);
  });

  it("stays out of the way when the range is missing or unparseable", () => {
    // A guard that can't read its own range must not block a working install.
    expect(isUnsupportedNode(undefined, "18.0.0")).toBe(false);
    expect(isUnsupportedNode("", "18.0.0")).toBe(false);
    expect(isUnsupportedNode(">=18.0.0 <20", "18.0.0")).toBe(false);
    expect(isUnsupportedNode("garbage", "18.0.0")).toBe(false);
  });

  it("stays out of the way when the runtime version is unparseable", () => {
    expect(isUnsupportedNode(RANGE, "not-a-version")).toBe(false);
  });

  it("tolerates a prerelease runtime by reading its numeric parts", () => {
    expect(isUnsupportedNode(RANGE, "24.0.0-nightly")).toBe(false);
  });
});

describe("unsupportedNodeMessage", () => {
  it("names the tool, the required range, and the version in use", () => {
    const msg = unsupportedNodeMessage(RANGE, "18.19.1");
    expect(msg).toContain("Scarecrow");
    expect(msg).toContain(RANGE);
    expect(msg).toContain("18.19.1");
    expect(msg).toContain("nodejs.org");
  });
});
