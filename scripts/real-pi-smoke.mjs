#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 120_000;
const authAgentDir = process.env.PI_REAL_SMOKE_AUTH_AGENT_DIR
  ?? (process.env.HOME ? join(process.env.HOME, ".pi", "agent") : undefined);

function usage() {
  console.log(`Usage: node scripts/real-pi-smoke.mjs [--llm] [--keep-temp] [--timeout-ms <ms>]\n\nRuns an opt-in real Pi package smoke for this local pi-intercom checkout. By\ndefault it uses an isolated temporary Pi home, installs this checkout by local\npath, and verifies pi list. It does not publish anything.\n\nOptions:\n  --llm             Also run live model-backed intercom status/list prompts\n  --keep-temp       Keep the isolated temporary home for debugging\n  --timeout-ms <ms> Per-command timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})\n  -h, --help        Show this help\n\nEnvironment:\n  PI_REAL_SMOKE_AUTH_AGENT_DIR     Source Pi agent dir for auth.json/models.json during --llm (default: ~/.pi/agent)\n  PI_REAL_SMOKE_MODEL              Model passed to live --llm smoke prompts\n  PI_REAL_SMOKE_PROVIDER           Provider passed to live --llm smoke prompts\n\nExit codes:\n  0  real Pi smoke passed\n  1  install/list/live smoke failed\n  2  invalid arguments`);
}

function parsePositiveInteger(value, source) {
  if (!/^\d+$/.test(value)) throw new Error(`${source} must be a positive integer, got ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${source} must be a positive safe integer, got ${value}`);
  return parsed;
}

function parseArgs(argv) {
  const options = { llm: false, keepTemp: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--llm") {
      options.llm = true;
      continue;
    }
    if (arg === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = argv[index + 1];
      if (!value) throw new Error("--timeout-ms requires a value");
      options.timeoutMs = parsePositiveInteger(value, "--timeout-ms");
      index += 1;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function commandName(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function copyLiveAuth(agentDir) {
  if (!authAgentDir || !existsSync(authAgentDir)) return [];
  mkdirSync(agentDir, { recursive: true });
  const copied = [];
  for (const filename of ["auth.json", "models.json"]) {
    const source = join(authAgentDir, filename);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(agentDir, filename));
    copied.push(filename);
  }
  return copied;
}

function isolatedEnv(root, agentDir) {
  const home = join(root, "home");
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PATH: process.env.PATH ?? "",
    Path: process.env.Path ?? process.env.PATH ?? "",
  };
}

function run(label, command, args, { cwd, env, timeoutMs }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  const output = result.error ? result.error.message : `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${label} timed out after ${timeoutMs}ms\nCommand: ${command} ${args.join(" ")}\n${output}`);
  }
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed with ${result.status ?? "spawn error"}\nCommand: ${command} ${args.join(" ")}\n${output}`);
  }
  return output;
}

function runPi(label, args, options) {
  return run(label, commandName("pi"), args, options);
}

function runLivePrompt(label, prompt, options) {
  const args = ["--print", "--mode", "text", "--session-dir", join(options.root, "sessions"), "--approve"];
  if (process.env.PI_REAL_SMOKE_PROVIDER) args.push("--provider", process.env.PI_REAL_SMOKE_PROVIDER);
  if (process.env.PI_REAL_SMOKE_MODEL) args.push("--model", process.env.PI_REAL_SMOKE_MODEL);
  args.push(prompt);
  return runPi(label, args, options);
}

function requireOutput(label, output, pattern) {
  if (!pattern.test(output)) throw new Error(`${label} did not include expected evidence ${pattern}.\nOutput:\n${output}`);
  const compact = output.trim().split(/\r?\n/).slice(-8).join("\n");
  console.log(`[real-pi-intercom-smoke] ${label} output evidence:\n${compact}`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[real-pi-intercom-smoke] ${error instanceof Error ? error.message : String(error)}`);
    usage();
    process.exit(2);
  }

  const repoRoot = resolve(process.cwd());
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-real-pi-smoke-"));
  const agentDir = join(root, "pi-agent");
  const env = isolatedEnv(root, agentDir);
  const runOptions = { cwd: repoRoot, env, timeoutMs: options.timeoutMs, root };

  try {
    runPi("pi install pi-intercom", ["install", repoRoot, "--approve"], runOptions);
    const list = runPi("pi list", ["list", "--approve"], runOptions);
    if (!list.includes(repoRoot)) throw new Error(`pi list did not include ${repoRoot}:\n${list}`);

    if (options.llm) {
      const copiedAuthFiles = copyLiveAuth(agentDir);
      if (copiedAuthFiles.length > 0) console.log(`[real-pi-intercom-smoke] copied ${copiedAuthFiles.join(" and ")} into isolated Pi agent dir for live provider auth`);
      const statusPrompt = "Call the intercom tool with action status. Then reply with exactly two lines: first 'real-pi-intercom status ok' if the tool output includes 'Connected: Yes', otherwise 'real-pi-intercom status failed'; second line quote the tool output.";
      const listPrompt = "Call the intercom tool with action list. Then reply with exactly two lines: first 'real-pi-intercom list ok' if the tool output includes 'Current session', otherwise 'real-pi-intercom list failed'; second line quote the tool output.";
      requireOutput("real Pi intercom status prompt", runLivePrompt("real Pi intercom status prompt", statusPrompt, runOptions), /real-pi-intercom status ok[\s\S]*Connected: Yes/);
      requireOutput("real Pi intercom list prompt", runLivePrompt("real Pi intercom list prompt", listPrompt, runOptions), /real-pi-intercom list ok[\s\S]*Current session/);
    }

    console.log(`[real-pi-intercom-smoke] installed local package and verified pi list in ${agentDir}`);
    if (!options.llm) console.log("[real-pi-intercom-smoke] live model intercom prompts skipped; pass --llm to exercise status/list tools.");
  } finally {
    if (options.keepTemp) console.log(`[real-pi-intercom-smoke] kept temp root ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[real-pi-intercom-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
