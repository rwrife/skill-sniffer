/**
 * skill-sniffer 🐕👃
 * Public entry point for the package API.
 *
 * For M1 this just re-exports the CLI runner and version helpers.
 * Later milestones will surface discover/parse/engine/score here.
 */

export { run } from "./cli.js";
export { getVersion } from "./version.js";
