import { describe, it, expect } from "vitest";
import { parse, looksLikeUrl, suggest, COMMANDS, assertSafeTarget, normalizeUrl } from "../cli/args.js";

describe("parse", () => {
  it("parses a bare URL as a positional", () => {
    const result = parse(["example.com"]);
    expect(result.command).toBeNull();
    expect(result.positionals).toEqual(["example.com"]);
    expect(result.flags).toEqual({});
  });

  it("parses the run command", () => {
    const result = parse(["run", "example.com"]);
    expect(result.command).toBe("run");
    expect(result.positionals).toEqual(["example.com"]);
  });

  it("parses the glance command", () => {
    const result = parse(["glance", "example.com"]);
    expect(result.command).toBe("glance");
    expect(result.positionals).toEqual(["example.com"]);
  });

  it("parses short flags", () => {
    const result = parse(["run", "example.com", "-p", "skeptic", "-t", "sign up"]);
    expect(result.flags.persona).toBe("skeptic");
    expect(result.flags.task).toBe("sign up");
  });

  it("parses long flags with = syntax", () => {
    const result = parse(["run", "example.com", "--persona=skeptic", "--task=sign up"]);
    expect(result.flags.persona).toBe("skeptic");
    expect(result.flags.task).toBe("sign up");
  });

  it("parses boolean flags", () => {
    const result = parse(["run", "example.com", "--headed", "--json"]);
    expect(result.flags.headed).toBe(true);
    expect(result.flags.json).toBe(true);
  });

  it("parses negated boolean flags", () => {
    const result = parse(["run", "example.com", "--no-headed"]);
    expect(result.flags.headed).toBe(false);
  });

  it("parses clustered boolean aliases", () => {
    const result = parse(["run", "example.com", "-qy"]);
    expect(result.flags.quiet).toBe(true);
    expect(result.flags.yes).toBe(true);
  });

  it("parses integer flags", () => {
    const result = parse(["run", "example.com", "-n", "12"]);
    expect(result.flags.steps).toBe(12);
  });

  it("rejects non-integer for int flags", () => {
    const result = parse(["run", "example.com", "-n", "abc"]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("whole number");
  });

  it("parses -- passthrough", () => {
    const result = parse(["run", "--", "--not-a-flag"]);
    expect(result.positionals).toEqual(["--not-a-flag"]);
  });

  it("reports unknown flags", () => {
    const result = parse(["run", "--unknown"]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("unknown option");
  });

  it("suggests similar flags", () => {
    const result = parse(["run", "--persn"]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("did you mean");
  });

  it("parses optional flag with value", () => {
    const result = parse(["run", "--upload=file.pdf"]);
    expect(result.flags.upload).toBe("file.pdf");
  });

  it("parses optional flag without value as true", () => {
    const result = parse(["run", "--upload"]);
    expect(result.flags.upload).toBe(true);
  });

  it("parses optional flag with a space-separated value", () => {
    const result = parse(["run", "--upload", "file.pdf"]);
    expect(result.flags.upload).toBe("file.pdf");
  });

  it("parses optional flag at end of args without value as true", () => {
    const result = parse(["run", "example.com", "-p", "novice", "--upload"]);
    expect(result.flags.upload).toBe(true);
    expect(result.positionals).toEqual(["example.com"]);
  });

  it("doesn't swallow a following flag as the optional flag's value", () => {
    const result = parse(["run", "--upload", "--yes"]);
    expect(result.flags.upload).toBe(true);
    expect(result.flags.yes).toBe(true);
  });

  // Regression: "-5" was read as a flag, so "-n -5" reported `-n expects a value` plus
  // `unknown option "-5" — did you mean "--ci"?`, hiding the actual problem. A negative
  // number has to reach the int coercion for the caller to reject it on its merits.
  it("treats a negative number as a value, not a flag", () => {
    const result = parse(["run", "-n", "-5"]);
    expect(result.flags.steps).toBe(-5);
    expect(result.errors).toEqual([]);
  });

  it("keeps zero rather than dropping it", () => {
    const result = parse(["run", "-n", "0"]);
    expect(result.flags.steps).toBe(0);
  });

  it("still rejects a non-numeric value for an int flag", () => {
    const result = parse(["run", "-n", "lots"]);
    expect(result.flags.steps).toBeUndefined();
    expect(result.errors.join(" ")).toMatch(/whole number/);
  });
});

describe("looksLikeUrl", () => {
  it("matches http URLs", () => {
    expect(looksLikeUrl("http://example.com")).toBe(true);
  });

  it("matches https URLs", () => {
    expect(looksLikeUrl("https://example.com")).toBe(true);
  });

  it("matches domains with dots", () => {
    expect(looksLikeUrl("example.com")).toBe(true);
  });

  it("matches localhost", () => {
    expect(looksLikeUrl("localhost")).toBe(true);
  });

  it("matches ports", () => {
    expect(looksLikeUrl("localhost:3000")).toBe(true);
  });

  it("matches paths", () => {
    expect(looksLikeUrl("example.com/path")).toBe(true);
  });

  it("does not match plain words", () => {
    expect(looksLikeUrl("run")).toBe(false);
  });

  it("does not match a multi-word goal, even one containing dots/slashes", () => {
    // Regression: a sentence full of punctuation (and an email address, itself containing
    // a dot) must never be routed as a URL just because it has a "." or "/" somewhere.
    expect(looksLikeUrl(
      "I want you to login into marine form automation. Search for a candidate with a role " +
      "of ETO with tanker experience and select it and fill out the ratings form. Just check " +
      "if the form is filled, preview the filled form and once everything is done download it. " +
      "use the credentials of mail: testadmin1jul@yopmail.com, pass: test@123. Now type the goal."
    )).toBe(false);
  });

  it("does not match a short goal with a slash, like \"and/or\"", () => {
    expect(looksLikeUrl("check the and/or logic on the pricing page")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it("prepends https:// to a bare host", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
  });

  it("prepends https:// to a bare host:port", () => {
    expect(normalizeUrl("localhost:3000")).toBe("https://localhost:3000");
  });

  it("leaves an explicit https:// URL untouched", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it("leaves an explicit http:// URL untouched", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("does NOT mangle a file:// URL into an https:// one — assertSafeTarget must still see the real scheme", () => {
    expect(normalizeUrl("file:///etc/passwd")).toBe("file:///etc/passwd");
  });

  it("does NOT mangle a javascript: URL", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
  });

  it("does NOT mangle a data: URL", () => {
    expect(normalizeUrl("data:text/html,<script>1</script>")).toBe("data:text/html,<script>1</script>");
  });
});

describe("normalizeUrl + assertSafeTarget (the actual collectInputs pipeline)", () => {
  it("rejects a raw file:// input end-to-end", () => {
    expect(() => assertSafeTarget(normalizeUrl("file:///etc/passwd"))).toThrow(/only http/);
  });

  it("allows a raw bare host:port end-to-end", () => {
    expect(() => assertSafeTarget(normalizeUrl("localhost:3000"))).not.toThrow();
  });
});

describe("assertSafeTarget", () => {
  it("rejects file:// URLs", () => {
    expect(() => assertSafeTarget("file:///etc/passwd")).toThrow(/only http/);
  });

  it("rejects data: URLs", () => {
    expect(() => assertSafeTarget("data:text/html,<script>alert(1)</script>")).toThrow(/only http/);
  });

  it("rejects javascript: URLs", () => {
    expect(() => assertSafeTarget("javascript:alert(1)")).toThrow(/only http/);
  });

  it("rejects the cloud metadata link-local address", () => {
    expect(() => assertSafeTarget("http://169.254.169.254/latest/meta-data/")).toThrow(/link-local/);
  });

  it("rejects other addresses in the 169.254.0.0/16 range", () => {
    expect(() => assertSafeTarget("http://169.254.1.1/")).toThrow(/link-local/);
  });

  it("allows localhost — testing your own dev server is the point of this tool", () => {
    expect(() => assertSafeTarget("http://localhost:3000")).not.toThrow();
  });

  it("allows RFC1918 private addresses", () => {
    expect(() => assertSafeTarget("http://192.168.1.50")).not.toThrow();
    expect(() => assertSafeTarget("http://10.0.0.5")).not.toThrow();
  });

  it("allows ordinary https URLs", () => {
    expect(() => assertSafeTarget("https://example.com")).not.toThrow();
  });

  it("rejects garbage that isn't a URL", () => {
    expect(() => assertSafeTarget("not a url")).toThrow(/isn't a valid URL/);
  });
});

describe("suggest", () => {
  it("suggests close matches", () => {
    const result = suggest("runn", Object.keys(COMMANDS));
    expect(result).toBe("run");
  });

  it("returns null for very different words", () => {
    const result = suggest("xyz123", Object.keys(COMMANDS));
    expect(result).toBeNull();
  });
});

describe("COMMANDS", () => {
  it("has expected commands", () => {
    expect(COMMANDS).toHaveProperty("run");
    expect(COMMANDS).toHaveProperty("glance");
    expect(COMMANDS).toHaveProperty("personas");
    expect(COMMANDS).toHaveProperty("doctor");
    expect(COMMANDS).toHaveProperty("init");
    expect(COMMANDS).toHaveProperty("config");
    expect(COMMANDS).toHaveProperty("help");
  });

  it("each command has a summary and spec", () => {
    for (const [_name, cmd] of Object.entries(COMMANDS)) {
      expect(cmd.summary).toBeTruthy();
      expect(cmd.spec).toBeDefined();
    }
  });
});
