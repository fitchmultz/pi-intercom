---
name: pi-intercom
description: "Coordinate local Pi sessions with pi-intercom: list peers, send updates, ask blocking questions, reply to inbound asks, use contact_supervisor, or handle pi-subagents escalations. Do not use for generic chat, remote/cross-machine messaging, unrelated repos, routine subagent completion, or work this session can finish."
---

# Pi Intercom

## Goal

Coordinate named Pi sessions on the same machine with the least context loss and the fewest interruptions.

## Source of truth

- `intercom({ action: "list" })` is the source of truth for targetable sessions. It shows only intercom-connected sessions, not every Pi process, with live ask capability, busy/idle/unknown state, recent intercom activity, and delivery guidance. The current-session row is not targetable; choose a peer from Other sessions.
- Tool behavior comes from this package's `index.ts` and `README.md`; inspect them if examples drift.
- Pi CLI flags for local peer sessions are `--name`, `--extension`, and `--skill`.

## Use when

- Delegating a bounded task to another already-running Pi session.
- Sending findings, code snippets, file context, progress, or blockers to a specific session.
- Asking a peer for a decision or clarification you need before continuing.
- Replying to an inbound intercom ask.
- Handling a formatted `pi-subagents` supervisor escalation.

## Do not use when

- The current session can finish the work directly.
- The target is remote or on another machine; pi-intercom is local IPC only.
- The task is unrelated to the recipient's repo or role.
- A normal `subagent` run is enough and no visible peer conversation is needed.
- The message would expose secrets, tokens, passwords, private data, or unrelated user context without explicit approval.

## Default workflow

1. Decide whether a peer is actually needed. If not, keep working locally.
2. Discover targets before sending:

```typescript
intercom({ action: "list" })
```

3. Pick the displayed name or target ID exactly. If names collide, use the target shown by `list`. Never message the current session.
4. Choose the lightest action:

| Action | Use for | Effect |
| --- | --- | --- |
| `send` | Context drops, progress, non-blocking notices | Wakes idle recipients and returns after broker acceptance; use `delivery:"queue"` for active-recipient follow-up, `delivery:"steer"` only for urgent course correction, and passive delivery only for human-visible breadcrumbs |
| `ask` | Decisions, clarifications, ACKs needed now | Wakes/queues the recipient and waits up to `askTimeoutMs` (default 2 minutes); default asks to peers reporting `accepts_asks:false` return `delivered:true`, `replied:false`, `reason:"peer_idle"`, while explicit `delivery:"queue"`/`"steer"` asks still wait for a reply; not passive |
| `reply` | Answering an inbound ask | Uses the active ask, or the single pending ask |
| `pending` | Multiple or delayed inbound asks | Lists unresolved asks so you can disambiguate |
| `status` | Troubleshooting connection state | Shows connection, active session count, and the same live recipient capability/guidance rows as `list` |

5. Write compact messages with objective, scope, relevant files, stop boundary, and expected reply.
6. For long work, use `send` for checkpoints the recipient agent should see, and use `ask` when a reply is required. Trust the `list`/`status` guidance rows: if the recipient is active, use `delivery:"queue"` for normal follow-up and `delivery:"steer"` only when its current path is likely wrong. Avoid passive delivery unless the note is only for the human transcript.
7. After tool results, continue from the reply or error. Do not assume delivery after a failed result.

## Common calls

List and troubleshoot:

```typescript
intercom({ action: "list" })
intercom({ action: "status" })
```

Delegate work and wake the worker:

```typescript
intercom({
  action: "ask",
  to: "worker",
  message: "Task: inspect src/api/client.ts for retry bugs. Reply ACK, ask if blocked, and stop before changing public error shapes."
})
```

Send non-blocking context:

```typescript
intercom({
  action: "send",
  to: "planner",
  message: "Progress: retry bug is in fetchWithTimeout, not the API client. Continuing there."
})
```

Queue or replace updates for a peer:

```typescript
intercom({
  action: "send",
  to: "worker",
  delivery: "queue",
  queueMode: "replace",
  threadId: "retry-plan",
  message: "Updated plan: ignore api/client.ts; inspect fetchWithTimeout instead."
})
```

Reply to the ask that triggered the current turn:

```typescript
intercom({ action: "reply", message: "Use exponential backoff, max 3 retries." })
```

Disambiguate delayed or multiple pending asks:

```typescript
intercom({ action: "pending" })
intercom({ action: "reply", to: "worker", message: "Use the stable API." })
```

Send attachments only when the recipient needs the extra context:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Relevant helper:",
  attachments: [{
    type: "snippet",
    name: "retry.ts",
    language: "typescript",
    content: "export function shouldRetry(status: number) { return status >= 500; }"
  }]
})
```

## Supervisor escalations from pi-subagents

When a delegated child can reach the orchestrator, `pi-subagents` may provide a child-only `contact_supervisor` tool. Use it from the child when it is present; normal sessions use `intercom`. Do not assume `contact_supervisor` exists unless the tool is present.

Child-side rule: use `contact_supervisor` for `need_decision`, `interview_request`, or meaningful `progress_update`. Do not use it for routine completion; return final results through `pi-subagents`.

If you are the supervisor and receive a formatted message from a subagent, answer with `reply`:

```typescript
intercom({ action: "reply", message: "Use the stable v2 API and keep the public error shape unchanged." })
```

Escalation meanings:

| Type | Meaning | Supervisor response |
| --- | --- | --- |
| `need_decision` | Child is blocked or needs approval | Reply promptly with a clear decision |
| `interview_request` | Child needs multiple structured answers | Reply with JSON using the requested ids |
| `progress_update` | Child reports plan-changing progress | Read it; reply only if redirecting |

For interview requests, reply with plain JSON or a fenced JSON block:

```json
{
  "responses": [
    { "id": "api", "value": "Stable API" },
    { "id": "constraints", "value": "Keep the public error shape unchanged." }
  ]
}
```

`info` questions are context only and do not need response entries. Do not use supervisor contact for routine completion; child agents should return final results through `pi-subagents`.

If a subagent status line advertises an intercom target, trust it only when that target appears in `intercom({ action: "list" })`. If absent, use normal subagent controls (`status`, `resume`, `nudge`, result artifacts); the child may be Claude Code-backed or already exited and have no child-side `contact_supervisor`. From a parent session, prefer `subagent({ action: "nudge", id, message })` for a non-blocking live child ping; use direct `intercom({ action: "ask", to, delivery: "steer", message })` when you need to wait for a listed child reply.

## Optional visible peer sessions

Read `references/peer-sessions.md` before starting a new visible peer session. Spawn one only when all are true:

- No connected peer from `intercom({ action: "list" })` already fits.
- The user benefits from watching or resuming a long-lived peer conversation.
- The peer works in the same repo or an intentional reference repo.
- You can run a smoke ask before delegating real work.

## Failure handling

- No other sessions: do not invent a target. Start a peer only if the optional visible-peer rule holds.
- `Session not found`: run `list`, choose the exact displayed target, then retry if still useful.
- `Already waiting for a reply`: wait for the current ask, use `send` for non-blocking context, or continue local work.
- Multiple pending asks: run `pending`, then `reply` with `to` or `replyTo`.
- Ask timeout: summarize the blocked decision and continue only with safe local work.
- Busy non-interactive recipient auto-reply: it cannot respond while running; use subagent controls or wait.

## Completion evidence

A good intercom-assisted turn ends with:

- Target came from `list` or from the active inbound ask.
- Action matched intent: `send` for non-blocking/wake, `ask` for blocking, `reply` for inbound, `delivery:"queue"` for normal active-recipient follow-up, `delivery:"steer"` for urgent course correction, and passive delivery only when deliberately not waking the model.
- Delivery result or failure was handled.
- Any spawned peer was smoke-tested and either still needed or cleaned up.
