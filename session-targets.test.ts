import test from "node:test";
import assert from "node:assert/strict";
import { formatSessionTarget, resolveSessionTarget, targetDisplayName } from "./session-targets.ts";

const sessions = [
  { id: "abcdefgh-1111-2222-3333-444444444444", name: "worker" },
  { id: "abcdefgi-1111-2222-3333-444444444444", name: "reviewer" },
  { id: "xyz00000-1111-2222-3333-444444444444", name: "abcdefgh" },
];

test("formatSessionTarget returns the shortest safe prefix across ids and names", () => {
  assert.equal(formatSessionTarget(sessions[0]!, sessions), "abcdefgh-");
  assert.equal(formatSessionTarget(sessions[1]!, sessions), "abcdefgi");
});

test("targetDisplayName adds a safe target when a name collides with another id prefix", () => {
  assert.equal(targetDisplayName(sessions[2]!, sessions), "abcdefgh (xyz00000)");
});

test("resolveSessionTarget rejects too-short id prefixes", () => {
  assert.equal(resolveSessionTarget(sessions, "abcdefg").status, "none");
});

test("resolveSessionTarget resolves safe prefixes and reports name-prefix ambiguity", () => {
  assert.deepEqual(resolveSessionTarget(sessions, "abcdefgi").target, sessions[1]);
  const ambiguous = resolveSessionTarget(sessions, "abcdefgh");
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.matches.map((session) => session.id).sort(), [sessions[0]!.id, sessions[2]!.id].sort());
});
