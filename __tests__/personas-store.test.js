import { describe, it, expect } from "vitest";
import { isBuiltin, allPersonas } from "../cli/personas-store.js";

describe("personas-store", () => {
  describe("isBuiltin", () => {
    it("returns true for built-in personas", () => {
      expect(isBuiltin("novice")).toBe(true);
      expect(isBuiltin("power")).toBe(true);
      expect(isBuiltin("skeptic")).toBe(true);
    });

    it("returns false for non-existent personas", () => {
      expect(isBuiltin("nonexistent")).toBe(false);
    });
  });

  describe("allPersonas", () => {
    it("includes built-in personas", () => {
      const personas = allPersonas();
      expect(personas).toHaveProperty("novice");
      expect(personas).toHaveProperty("power");
      expect(personas).toHaveProperty("skeptic");
    });

    it("returns an object", () => {
      const personas = allPersonas();
      expect(typeof personas).toBe("object");
      expect(personas).not.toBeNull();
    });
  });
});
