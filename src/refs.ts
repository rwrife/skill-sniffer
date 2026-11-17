import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, sep } from "node:path";
import { parseSkillText } from "./parse.js";
import { localReferences } from "./rules/broken-paths.js";
import type { Finding, ParsedSkill } from "./types.js";

export const DEFAULT_REF_DEPTH = 5;

export interface FollowRefsOptions {
  followRefs?: boolean;
  /** Maximum reference edges from each input file; zero scans only inputs. */
  maxRefDepth?: number;
}

export function validateRefDepth(depth: number): void {
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new Error("--max-ref-depth expects a non-negative safe integer");
  }
}

/** Read bundled references only; never execute files or leave the bundle. */
export function followReferences(
  roots: ParsedSkill[],
  maxDepth: number,
): { files: ParsedSkill[]; referencedPaths: Record<string, string[]>; findings: Finding[] } {
  validateRefDepth(maxDepth);
  const files = new Map(roots.map((skill) => [skill.path, skill]));
  const referencedPaths: Record<string, string[]> = {};
  const findings: Finding[] = [];

  for (const root of roots) {
    const reached = new Set<string>();
    referencedPaths[root.path] = [];
    // Breadth-first traversal makes depth independent of reference order.
    const queue = [{ skill: root, depth: 0 }];
    const seen = new Set<string>();
    let bundle: string;
    try {
      bundle = realpathSync(dirname(root.path));
      seen.add(realpathSync(root.path));
    } catch (err) {
      findings.push(readError(root.path, err));
      continue;
    }
    for (let i = 0; i < queue.length; i++) {
      const { skill, depth } = queue[i];
      for (const ref of localReferences(skill, true)) {
        let sourcePath = ref.path;
        let resolved = false;
        try {
          const path = realpathSync(ref.path);
          resolved = true;
          const rel = relative(bundle, path);
          if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
          if (seen.has(path) || !statSync(path).isFile()) continue;
          seen.add(path);
          if (depth >= maxDepth) {
            findings.push({
              ruleId: "follow-refs",
              severity: "warning",
              message: `maximum reference depth (${maxDepth}) reached; not scanned: \`${ref.ref}\``,
              path: skill.path,
              line: ref.line,
              column: ref.column,
            });
            continue;
          }
          sourcePath = path;
          reached.add(path);
          let child = files.get(path);
          if (!child) {
            const raw = readFileSync(path, "utf8");
            if (raw.includes("\0")) continue; // Binary assets are not text.
            child = extname(path).toLowerCase() === ".md"
              ? parseSkillText(path, raw)
              : { path, format: "unknown", raw, body: raw, frontmatter: {} };
            files.set(path, child);
          }
          queue.push({ skill: child, depth: depth + 1 });
        } catch (err) {
          // Missing references are owned by broken-paths; other I/O failures
          // must not masquerade as a clean scan, even with that rule disabled.
          if (!resolved && err instanceof Error && "code" in err &&
              (err.code === "ENOENT" || err.code === "ENOTDIR")) continue;
          reached.add(sourcePath);
          findings.push(readError(sourcePath, err));
        }
      }
    }
    referencedPaths[root.path] = [...reached];
  }
  const uniqueFindings = [...new Map(findings.map((f) => [JSON.stringify(f), f])).values()];
  return { files: [...files.values()], referencedPaths, findings: uniqueFindings };
}

function readError(path: string, err: unknown): Finding {
  return {
    ruleId: "follow-refs",
    severity: "error",
    path,
    message: `could not inspect referenced file: ${err instanceof Error ? err.message : String(err)}`,
  };
}
