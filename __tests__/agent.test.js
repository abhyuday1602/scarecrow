import { describe, it, expect } from "vitest";
import { safeJson, stopAtDelimiter, stripThinkAloud } from "../agent.js";

describe("stripThinkAloud", () => {
  const collect = () => {
    const out = [];
    return { out, fn: stripThinkAloud((t) => out.push(t)) };
  };

  it("removes the tags but keeps the narration", () => {
    const { out, fn } = collect();
    fn("<think-aloud>\nHmm, this is confusing.\n</think-aloud>");
    expect(out.join("")).toBe("\nHmm, this is confusing.\n");
  });

  it("removes a tag split across chunk boundaries", () => {
    const { out, fn } = collect();
    for (const ch of "<think-aloud>Wait.</think-aloud>") fn(ch);
    expect(out.join("")).toBe("Wait.");
  });

  it("does not swallow ordinary prose containing '<'", () => {
    const { out, fn } = collect();
    fn("the price is < $5 and ");
    expect(out.join("")).toBe("the price is < $5 and ");
  });

  it("passes through text with no tags at all", () => {
    const { out, fn } = collect();
    fn("plain narration");
    expect(out.join("")).toBe("plain narration");
  });

  it("returns undefined when there is no downstream sink", () => {
    expect(stripThinkAloud(undefined)).toBeUndefined();
  });
});

describe("safeJson", () => {
  it("parses plain JSON", () => {
    expect(safeJson('{"action":"click","target":3}')).toEqual({ action: "click", target: 3 });
  });

  it("parses JSON inside a ```json fence", () => {
    expect(safeJson('```json\n{"action":"done"}\n```')).toEqual({ action: "done" });
  });

  it("parses JSON preceded by prose", () => {
    const out = safeJson('I think the signup button is #4.\n{"action":"click","target":4}');
    expect(out).toEqual({ action: "click", target: 4 });
  });

  it("parses JSON wrapped in prose and a bare fence", () => {
    expect(safeJson('Sure!\n```\n{"summary":"ok","findings":[]}\n```\nHope that helps.'))
      .toEqual({ summary: "ok", findings: [] });
  });

  it("returns null when there is no JSON at all", () => {
    expect(safeJson("I could not decide on an action.")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(safeJson('{"action": "click", target: }')).toBeNull();
  });
});

describe("stopAtDelimiter", () => {
  const collect = (delimiter, chunks) => {
    let out = "";
    const wrapped = stopAtDelimiter((t) => { out += t; }, delimiter);
    for (const ch of chunks) wrapped(ch);
    return out;
  };

  it("streams prose, holding back only a delimiter-length tail", () => {
    // The last (delimiter.length - 1) chars stay unflushed in case they start the
    // delimiter — real responses always end in JSON, so nothing real is lost.
    expect(collect('{"action":', ["thinking about ", "the page"])).toBe("thinking about");
  });

  it("stops at the delimiter and drops the JSON tail", () => {
    expect(collect('{"action":', ['the button looks off. {"action":"click","target":2}']))
      .toBe("the button looks off. ");
  });

  it("never leaks a delimiter split across two chunks", () => {
    expect(collect('{"action":', ["I will click. {\"act", 'ion":"click","target":1}']))
      .toBe("I will click. ");
  });

  it("flushes text that merely starts like the delimiter", () => {
    // "{x" begins like the delimiter but isn't — it must still reach the terminal
    // (minus the standing delimiter-length hold at the very end).
    expect(collect('{"action":', ["brace {x here", " and more"])).toBe("brace {x here");
  });

  it("emits nothing after the delimiter even across further chunks", () => {
    expect(collect("=== FINDINGS", ["narration === FIN", "DINGS\n[]", "more"])).toBe("narration ");
  });

  it("returns undefined when there is no onChunk", () => {
    expect(stopAtDelimiter(undefined, "{")).toBeUndefined();
  });
});
