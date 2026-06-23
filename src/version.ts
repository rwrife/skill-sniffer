import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Resolve the package version from package.json at runtime.
 *
 * The compiled CLI lives in dist/ and the bin entry lives in bin/, so we walk
 * up from this module to find the nearest package.json. We try a couple of
 * candidate locations so this works both from src (vitest) and dist (built).
 */
export function getVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "package.json"), // dist/version.js -> package.json
    join(here, "..", "..", "package.json"), // src/version.ts -> package.json
  ];

  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const pkg = JSON.parse(raw) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // try next candidate
    }
  }

  return "0.0.0";
}
