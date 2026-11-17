import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { runEngine } from "./engine.js";
import { defaultConfig } from "./config.js";
import { makeFrontmatterRule } from "./rules/frontmatter.js";
import { tokenBloatRule } from "./rules/token-bloat.js";
import type { ParsedSkill, Report, Rule } from "./types.js";

export interface HostProfile {
  id: string;
  requiredFields: ("name" | "description")[];
  allowedFrontmatterKeys: string[];
  forbiddenFrontmatterKeys: string[];
  maxDescriptionLength: number | null;
  descriptionSuffixField: string | null;
  maxBytes: number | null;
  tokenBudget: number | null;
  discoveryGlobs: string[];
  parseErrorSeverity: "error" | "warning";
  sources: string[];
  notes: string;
}

export interface CompatibilityReport {
  profiles: HostProfile[];
  skills: {
    path: string;
    hosts: { host: string; status: "pass" | "warn" | "fail"; report: Report }[];
  }[];
}

const HOSTS = ["claude-code", "codex", "copilot", "openclaw"] as const;

export function loadHostProfiles(host?: string): HostProfile[] {
  if (host !== undefined && !HOSTS.some((id) => id === host)) {
    throw new Error(`unknown host "${host}" (known: ${HOSTS.join(", ")})`);
  }
  return HOSTS.filter((id) => host === undefined || id === host).map((id) => {
    const value: unknown = JSON.parse(
      readFileSync(new URL(`./profiles/${id}.json`, import.meta.url), "utf8"),
    );
    if (!isHostProfile(value) || value.id !== id) {
      throw new Error(`invalid bundled host profile: ${id}`);
    }
    return value;
  });
}

function isHostProfile(value: unknown): value is HostProfile {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((item) => typeof item === "string");
  const limit = (v: unknown) =>
    v === null || (typeof v === "number" && Number.isSafeInteger(v) && v > 0);
  return typeof p.id === "string" &&
    strings(p.requiredFields) &&
    p.requiredFields.every((f) => f === "name" || f === "description") &&
    strings(p.allowedFrontmatterKeys) && strings(p.forbiddenFrontmatterKeys) &&
    limit(p.maxDescriptionLength) && limit(p.maxBytes) && limit(p.tokenBudget) &&
    (p.descriptionSuffixField === null || typeof p.descriptionSuffixField === "string") &&
    strings(p.discoveryGlobs) && strings(p.sources) && typeof p.notes === "string" &&
    (p.parseErrorSeverity === "error" || p.parseErrorSeverity === "warning");
}

function profileRule(profile: HostProfile): Rule {
  return {
    id: "host-profile",
    description: "Check documented host constraints and portability guidance.",
    defaultSeverity: "warning",
    run(skill, ctx) {
      const findings: Report["findings"] = [];
      const add = (message: string, severity: "error" | "warning" = "warning") =>
        findings.push({
          path: skill.path, ruleId: this.id,
          severity: ctx.severityFor(this, severity), message,
        });
      if (basename(skill.path) !== "SKILL.md") {
        add("host requires the exact filename SKILL.md; rename before installation", "error");
      }
      if (profile.maxBytes !== null && Buffer.byteLength(skill.raw, "utf8") > profile.maxBytes) {
        add(`file exceeds the documented ${profile.maxBytes}-byte rejection limit`, "error");
      }
      if (skill.error) return findings;
      for (const key of Object.keys(skill.frontmatter).sort()) {
        if (profile.forbiddenFrontmatterKeys.includes(key)) {
          add(`frontmatter key \`${key}\` is forbidden by this host`, "error");
        } else if (!profile.allowedFrontmatterKeys.includes(key)) {
          add(`frontmatter key \`${key}\` is not documented for this host; may be ignored`);
        }
      }
      const description = skill.frontmatter.description;
      const suffix = profile.descriptionSuffixField
        ? skill.frontmatter[profile.descriptionSuffixField] : undefined;
      const text = [description, suffix].filter((v) => typeof v === "string").join("\n");
      if (profile.maxDescriptionLength !== null &&
          [...text].length > profile.maxDescriptionLength) {
        add(`description listing exceeds ${profile.maxDescriptionLength} characters; may be truncated or violate spec guidance (not a verified rejection)`);
      }
      return findings;
    },
  };
}

export function checkCompatibility(
  skills: ParsedSkill[],
  profiles = loadHostProfiles(),
): CompatibilityReport {
  return {
    profiles,
    skills: [...skills].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      .map((skill) => ({
        path: skill.path,
        hosts: profiles.map((profile) => {
          const config = defaultConfig();
          const rules = [
            makeFrontmatterRule({
              requiredFields: profile.requiredFields,
              maxDescriptionLength: null,
              parseErrorSeverity: profile.parseErrorSeverity,
            }),
            profileRule(profile),
          ];
          if (profile.tokenBudget !== null) {
            config.tokenBudget = profile.tokenBudget;
            rules.push(tokenBloatRule);
          }
          const report = runEngine([skill], { config, rules });
          return {
            host: profile.id,
            status: report.counts.error > 0 ? "fail" as const
              : report.counts.warning > 0 ? "warn" as const : "pass" as const,
            report,
          };
        }),
      })),
  };
}
