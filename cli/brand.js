// cli/brand.js — the product's public identity in one place, so the invoked command name,
// the display/brand name, and the npm package name never drift across help text, version
// output, and error hints. User-facing copy should reference these instead of hardcoding.
//
//   BIN   — the executable/command users type            (e.g. `crow doctor`)
//   BRAND — the product name shown in prose and headers   (e.g. "Scarecrow")
//   PKG   — the npm package name                          (for install instructions)

export const BIN = "crow";
export const BRAND = "Scarecrow";
export const PKG = "@dumbduck/scarecrow";
