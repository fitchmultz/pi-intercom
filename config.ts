import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getPiAgentDir } from "./agent-dir.js";

const IntercomConfigSchema = Type.Object({
  brokerCommand: Type.String(),
  brokerArgs: Type.Array(Type.String()),
  confirmSend: Type.Boolean(),
  status: Type.Optional(Type.String()),
  enabled: Type.Boolean(),
  replyHint: Type.Boolean(),
  askTimeoutMs: Type.Number({ minimum: 1000 }),
  sendTimeoutMs: Type.Number({ minimum: 500 }),
  listTimeoutMs: Type.Number({ minimum: 500 }),
});

export type IntercomConfig = Static<typeof IntercomConfigSchema>;

function getConfigPath(): string {
  return join(getPiAgentDir(), "intercom", "config.json");
}

const defaults: IntercomConfig = {
  brokerCommand: "npx",
  brokerArgs: ["--no-install", "tsx"],
  confirmSend: false,
  enabled: true,
  replyHint: true,
  askTimeoutMs: 2 * 60 * 1000,
  sendTimeoutMs: 8000,
  listTimeoutMs: 5000,
};

export function loadConfig(): IntercomConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { ...defaults };
  }
  
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }

    const configured = { ...defaults, ...parsed } as Record<string, unknown>;
    const config = Object.fromEntries(Object.keys(IntercomConfigSchema.properties)
      .filter((key) => Object.hasOwn(configured, key))
      .map((key) => [key, configured[key]])) as IntercomConfig;
    const errors = Value.Errors(IntercomConfigSchema, config);
    if (errors.length > 0) {
      throw new Error(errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; "));
    }
    config.brokerCommand = config.brokerCommand.trim();
    if (!config.brokerCommand) {
      throw new Error(`"brokerCommand" must not be empty`);
    }
    return config;
  } catch (error) {
    console.error(`Failed to load intercom config at ${configPath}:`, error);
    return { ...defaults };
  }
}
