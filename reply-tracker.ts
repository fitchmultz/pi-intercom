import type { Message, SessionInfo } from "./types.ts";

export interface IntercomContext {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
}

function matchesPendingSender(context: IntercomContext, to: string): boolean {
  const target = to.trim().toLowerCase();
  const senderId = context.from.id.toLowerCase();
  if (senderId === target || senderId.startsWith(target)) {
    return true;
  }

  return context.from.name?.toLowerCase() === target;
}

function resolveBySenderTarget(contexts: IntercomContext[], to: string): IntercomContext[] {
  const target = to.trim().toLowerCase();
  const exactIdMatches = contexts.filter((context) => context.from.id.toLowerCase() === target);
  if (exactIdMatches.length > 0) {
    return exactIdMatches;
  }
  return contexts.filter((context) => matchesPendingSender(context, to));
}

function pendingSenderTarget(context: IntercomContext, contexts: IntercomContext[]): string {
  const normalizedIds = contexts.map((candidate) => candidate.from.id.toLowerCase());
  const normalizedNames = new Set(contexts
    .map((candidate) => candidate.from.name?.toLowerCase())
    .filter((name): name is string => Boolean(name)));
  const id = context.from.id.toLowerCase();
  for (let length = 8; length < context.from.id.length; length += 1) {
    const prefix = id.slice(0, length);
    const uniqueIdPrefix = normalizedIds.filter((candidateId) => candidateId.startsWith(prefix)).length === 1;
    if (uniqueIdPrefix && !normalizedNames.has(prefix)) {
      return context.from.id.slice(0, length);
    }
  }
  return context.from.id;
}

function pendingSenderOptions(contexts: IntercomContext[], allContexts: IntercomContext[] = contexts): string {
  return contexts
    .map((context) => `${context.from.name || context.from.id.slice(0, 8)} (${pendingSenderTarget(context, allContexts)}, replyTo: ${context.message.id})`)
    .join(", ");
}

export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly pendingTurnContexts: IntercomContext[] = [];
  private currentTurnContext: IntercomContext | null = null;

  constructor(private readonly askTimeoutMs = 10 * 60 * 1000) {}

  recordIncomingMessage(from: SessionInfo, message: Message, receivedAt = Date.now()): IntercomContext {
    const context = { from, message, receivedAt };
    if (message.expectsReply) {
      this.pendingAsks.set(message.id, context);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    this.pendingTurnContexts.push(context);
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    this.currentTurnContext = this.pendingTurnContexts.shift() ?? null;
  }

  endTurn(): void {
    this.currentTurnContext = null;
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContext = null;
  }

  resolveReplyTarget(options: { to?: string; replyTo?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);

    const pending = Array.from(this.pendingAsks.values());
    const contexts = this.currentTurnContext
      ? [this.currentTurnContext, ...pending.filter((context) => context.message.id !== this.currentTurnContext?.message.id)]
      : pending;

    if (options.replyTo) {
      const target = contexts.find((context) => context.message.id === options.replyTo);
      if (!target) {
        throw new Error(`No pending ask with replyTo "${options.replyTo}"`);
      }
      if (options.to) {
        const senderMatches = resolveBySenderTarget(contexts, options.to);
        if (!senderMatches.some((context) => context.message.id === target.message.id)) {
          throw new Error(`Pending ask "${options.replyTo}" is not from "${options.to}"`);
        }
      }
      return target;
    }

    if (options.to) {
      const matches = resolveBySenderTarget(contexts, options.to);
      if (matches.length === 1) {
        return matches[0]!;
      }
      if (matches.length > 1) {
        throw new Error(`Multiple pending asks from \"${options.to}\" — use one of these targets or pass replyTo: ${pendingSenderOptions(matches, contexts)}.`);
      }
      throw new Error(`No pending ask from \"${options.to}\"`);
    }

    if (this.currentTurnContext) {
      return this.currentTurnContext;
    }

    if (pending.length === 1) {
      return pending[0]!;
    }

    if (pending.length === 0) {
      throw new Error("No active intercom context to reply to");
    }

    throw new Error("Multiple pending asks — specify `to`");
  }

  markReplied(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = null;
    }
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private pruneExpired(now: number): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (now - context.receivedAt > this.askTimeoutMs) {
        this.pendingAsks.delete(messageId);
      }
    }
  }
}
