import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateHTML, generateJUnit, saveExport, FORMATS } from "../cli/export.js";
import { generateRerunCommand } from "../cli/resume.js";

// A findings.json written by a prompt-injected page: every LLM-derived field
// tries to smuggle markup into the HTML report or break out of the JUnit XML.
const MALICIOUS = {
  url: "https://evil.example/?q=<script>alert(1)</script>",
  persona: "skeptic",
  goal: 'break "the" report ]]><foo>',
  outcome: "gave up / bounced",
  finalUrl: "https://evil.example/done",
  summary: "<img src=x onerror=alert(2)>",
  findings: [
    { severity: '"><script>alert(3)</script>', issue: "inject ]]> here", heuristic: "<b>h</b>", fix: "&'\"<>" },
    { severity: "high", issue: "real ]]> issue", heuristic: "visibility", fix: "fix ]]> it" },
  ],
  a11y: { violations: [{ id: "x", impact: "<script>i</script>", description: "d", nodes: "<u>2</u>" }] },
  routeHistory: [{ url: "javascript:alert(4)", type: "<script>t</script>" }],
};

let dir, findingsPath;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "crow-export-"));
  findingsPath = join(dir, "findings.json");
  writeFileSync(findingsPath, JSON.stringify(MALICIOUS));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("generateHTML escaping", () => {
  it("escapes every injected tag", () => {
    const html = generateHTML(findingsPath);
    expect(html).not.toMatch(/<script>alert|<img\s|<u>2<\/u>|<b>h<\/b>/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("whitelists the severity CSS class", () => {
    const html = generateHTML(findingsPath);
    const classes = html.match(/class="finding severity-[^"]*"/g);
    expect(classes).toEqual(['class="finding severity-unknown"', 'class="finding severity-high"']);
  });

  it("coerces a non-numeric a11y node count", () => {
    const html = generateHTML(findingsPath);
    expect(html).toContain("<td>0</td>");
  });
});

describe("generateJUnit escaping", () => {
  it('a finding containing "]]>" cannot terminate the XML early', () => {
    const xml = generateJUnit(findingsPath);
    expect(xml).not.toContain("]]>");
    expect(xml).toContain("]]&gt;");
  });

  it("counts the session failure plus each high finding", () => {
    const xml = generateJUnit(findingsPath);
    expect(xml).toContain('tests="2" failures="2"');
  });
});

describe("generateJUnit structure and verdict", () => {
  const junitFor = (data) => {
    const p = join(dir, `f-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify({ url: "https://a.com", persona: "novice", goal: "sign up", outcome: "reached the goal", findings: [], ...data }));
    return generateJUnit(p);
  };

  it("has at most one <failure> per testcase and never more failures than tests", () => {
    const xml = junitFor({ wouldCompleteTask: "no", findings: [
      { severity: "high", issue: "a" }, { severity: "high", issue: "b" }, { severity: "low", issue: "c" },
    ] });
    for (const tc of xml.split("<testcase").slice(1)) expect((tc.match(/<failure/g) || []).length).toBeLessThanOrEqual(1);
    expect(xml).toContain('tests="3" failures="3"');
  });

  it("lets the objective check decide completion over the model's verdict", () => {
    expect(junitFor({ wouldCompleteTask: "unsure", assertion: { kind: "text", marker: "Thanks", passed: true } }))
      .toContain('tests="1" failures="0"');
    expect(junitFor({ wouldCompleteTask: "yes", assertion: { kind: "url", marker: "/done", passed: false } }))
      .toContain('tests="1" failures="1"');
  });

  it("glance runs have no completion testcase", () => {
    expect(junitFor({ mode: "glance", wouldCompleteTask: "no" })).toContain('tests="0" failures="0"');
  });
});

describe("generateRerunCommand quoting", () => {
  it("single-quotes url, task, and success", () => {
    const cmd = generateRerunCommand({
      inputs: {
        url: "https://a.com/?q=1&r=2",
        personaKey: "skeptic",
        task: 'sign in as "O\'Brien"; rm -rf /',
        success: "Welcome back",
        provider: "gemini",
        model: "gemini-2.5-flash",
      },
    });
    expect(cmd).toBe(
      "crow run 'https://a.com/?q=1&r=2' --persona skeptic " +
      `--task 'sign in as "O'\\''Brien"; rm -rf /' ` +
      "--provider gemini --model 'gemini-2.5-flash' --success 'Welcome back'"
    );
  });

  it("omits defaults and falsy flags", () => {
    const cmd = generateRerunCommand({ inputs: { url: "https://a.com", steps: 8, device: "desktop", headed: true } });
    expect(cmd).toBe("crow run 'https://a.com'");
  });

  it("keeps a headless run headless (headed is the default)", () => {
    const cmd = generateRerunCommand({ inputs: { url: "https://a.com", headed: false } });
    expect(cmd).toBe("crow run 'https://a.com' --no-headed");
  });

  // Regression: inputs.upload is the *resolved* array, and [] is truthy — so every
  // reconstructed command picked up a bare `--upload`, which means "attach everything in
  // uploads/". Copy-pasting the tool's own suggestion changed what the run did.
  it("omits --upload for a run that uploaded nothing", () => {
    const cmd = generateRerunCommand({ inputs: { url: "https://a.com", upload: [] } });
    expect(cmd).toBe("crow run 'https://a.com'");
  });

  it("names the uploaded files rather than suggesting the whole folder", () => {
    const cmd = generateRerunCommand({
      inputs: { url: "https://a.com", upload: ["/home/u/uploads/id.png", "/home/u/uploads/cv.pdf"] },
    });
    expect(cmd).toBe("crow run 'https://a.com' --upload='id.png,cv.pdf'");
  });
});

describe("saveExport format validation", () => {
  // Regression: `case "json": default:` swallowed every unrecognized format, so
  // `--format pdf` wrote JSON and reported success.
  it("refuses an unsupported format instead of silently writing JSON", () => {
    expect(() => saveExport(findingsPath, "pdf", dir)).toThrow(/unknown export format "pdf"/i);
  });

  it("names the valid formats in the error", () => {
    expect(() => saveExport(findingsPath, "pdf", dir)).toThrow(/html.*junit.*xml.*json/);
  });

  it.each([
    ["html", ".html"],
    ["junit", ".xml"],
    ["xml", ".xml"],
    ["json", ".json"],
  ])("still writes %s", (format, ext) => {
    expect(saveExport(findingsPath, format, dir).endsWith(ext)).toBe(true);
  });

  it("keeps FORMATS in sync with what saveExport accepts", () => {
    for (const f of FORMATS) expect(() => saveExport(findingsPath, f, dir)).not.toThrow();
  });
});
