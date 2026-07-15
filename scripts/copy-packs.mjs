// Copy bundled data assets (injection packs, etc.) from src/ into dist/ after
// tsc runs. tsc only emits .js/.d.ts, so JSON packs need an explicit copy so
// the published dist/ ships them alongside the compiled loader.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "src/packs");
const to = resolve(root, "dist/packs");

if (!existsSync(from)) {
  console.warn(`[copy-packs] no src/packs directory at ${from}; nothing to copy`);
  process.exit(0);
}

mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`[copy-packs] copied ${from} -> ${to}`);
