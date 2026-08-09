import { describe, it, expect } from "vitest";
import { PERSONAS } from "../personas.js";

describe("PERSONAS", () => {
  it("has built-in personas", () => {
    expect(PERSONAS).toHaveProperty("novice");
    expect(PERSONAS).toHaveProperty("power");
    expect(PERSONAS).toHaveProperty("skeptic");
    expect(PERSONAS).toHaveProperty("rushed");
    expect(PERSONAS).toHaveProperty("access");
    expect(Object.keys(PERSONAS)).toHaveLength(5);
  });

  it("each persona has name and description", () => {
    for (const [_key, persona] of Object.entries(PERSONAS)) {
      expect(persona.name).toBeTruthy();
      expect(typeof persona.name).toBe("string");
      expect(persona.description).toBeTruthy();
      expect(typeof persona.description).toBe("string");
    }
  });

  it("persona descriptions are substantial", () => {
    for (const [_key, persona] of Object.entries(PERSONAS)) {
      expect(persona.description.length).toBeGreaterThan(50);
    }
  });
});
