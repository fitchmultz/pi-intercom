import { createHash } from "crypto";
import { join } from "path";
import { homedir, tmpdir } from "os";

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(homeDir)}`;
  }

  const digest = createHash("sha256").update(homeDir).digest("hex").slice(0, 16);
  return join(tmpdir(), `pi-intercom-${digest}.sock`);
}
