#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node scripts/package-smoke.mjs\n\nVerifies this local pi-intercom fork package shape without publishing.\n\nChecks:\n  - npm pack --dry-run includes runtime Pi resources\n  - package.json pi manifest points at extension and skills\n  - index.ts loads through tsx and exports a registration function\n\nExit codes:\n  0  smoke passed\n  1  package shape or extension load check failed`);
  process.exit(0);
}

function fail(message) {
  console.error(`[package-smoke] ${message}`);
  process.exit(1);
}

function commandName(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function run(command, args) {
  const result = spawnSync(commandName(command), args, {
    cwd: process.cwd(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`failed to start ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.stdout.write(result.stdout ?? "");
    fail(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result.stdout;
}

function assertPackedFile(files, path) {
  if (!files.some((file) => file.path === path)) fail(`npm pack output is missing ${path}`);
}

const packOutput = run("npm", ["pack", "--dry-run", "--json"]);
let packs;
try {
  packs = JSON.parse(packOutput);
} catch (error) {
  fail(`npm pack --json returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
const pack = Array.isArray(packs) ? packs[0] : undefined;
if (!pack || !Array.isArray(pack.files)) fail("npm pack --json did not report a file list");

for (const path of [
  "package.json",
  "README.md",
  "LICENSE",
  "index.ts",
  "agent-dir.ts",
  "config.ts",
  "broker/client.ts",
  "broker/spawn.ts",
  "ui/session-list.ts",
  "skills/pi-intercom/SKILL.md",
  "scripts/real-pi-smoke.mjs",
]) {
  assertPackedFile(pack.files, path);
}

const packageJson = JSON.parse(run("node", ["-e", "process.stdout.write(JSON.stringify(require('./package.json')))" ]));
if (!packageJson.pi?.extensions?.includes("./index.ts")) fail("package.json pi.extensions must include ./index.ts");
if (!packageJson.pi?.skills?.includes("./skills")) fail("package.json pi.skills must include ./skills");

run("node", ["--import", "tsx", "-e", "const mod = await import('./index.ts'); if (typeof (mod.default ?? mod) !== 'function') process.exit(1);"]);

console.log(`[package-smoke] ${pack.name}@${pack.version}: ${pack.files.length} files packed; extension entrypoint loaded`);
