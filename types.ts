export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  /** Last time the broker observed any activity from this session (liveness). */
  lastSeen?: number;
  /** Last time this session exchanged an intercom message (send/receive). */
  lastIntercomActivity?: number;
  /** Number of inbound asks this session still owes a reply to. */
  pendingAsks?: number;
  /** Whether this session is currently willing/able to answer asks. */
  acceptsAsks?: boolean;
}

export function isSessionInfo(value: unknown): value is SessionInfo;
export function isSessionInfo(value: unknown, requireId: false): value is Omit<SessionInfo, "id">;
export function isSessionInfo(value: unknown, requireId = true): value is SessionInfo | Omit<SessionInfo, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return (!requireId || typeof session.id === "string")
    && typeof session.cwd === "string"
    && typeof session.model === "string"
    && typeof session.pid === "number"
    && typeof session.startedAt === "number"
    && typeof session.lastActivity === "number"
    && (session.name === undefined || typeof session.name === "string")
    && (session.status === undefined || typeof session.status === "string")
    && (session.lastSeen === undefined || typeof session.lastSeen === "number")
    && (session.lastIntercomActivity === undefined || typeof session.lastIntercomActivity === "number")
    && (session.pendingAsks === undefined || typeof session.pendingAsks === "number")
    && (session.acceptsAsks === undefined || typeof session.acceptsAsks === "boolean");
}

export type MessageDelivery = "queue" | "steer" | "passive";
export type QueueMode = "stack" | "replace";

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  /** Explicit active-recipient behavior. Omit for backwards-compatible auto delivery. */
  delivery?: MessageDelivery;
  /** For delivery="queue": stack normally, or replace older undelivered messages in the same thread. */
  queueMode?: QueueMode;
  /** Stable topic key for queueMode="replace". */
  threadId?: string;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const attachment = value as Record<string, unknown>;

  if (
    attachment.type !== "file"
    && attachment.type !== "snippet"
    && attachment.type !== "context"
  ) {
    return false;
  }

  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }

  return attachment.language === undefined || typeof attachment.language === "string";
}

export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (Object.hasOwn(message, "passive")) {
    return false;
  }

  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }

  if (message.replyTo !== undefined && typeof message.replyTo !== "string") {
    return false;
  }

  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") {
    return false;
  }

  if (
    message.delivery !== undefined
    && message.delivery !== "queue"
    && message.delivery !== "steer"
    && message.delivery !== "passive"
  ) {
    return false;
  }

  if (
    message.queueMode !== undefined
    && message.queueMode !== "stack"
    && message.queueMode !== "replace"
  ) {
    return false;
  }

  if (message.threadId !== undefined && (typeof message.threadId !== "string" || message.threadId.trim() === "")) {
    return false;
  }

  if (message.delivery === "passive" && message.expectsReply === true) {
    return false;
  }

  if (message.queueMode !== undefined && message.delivery !== "queue") {
    return false;
  }

  if (message.queueMode === "replace" && typeof message.threadId !== "string") {
    return false;
  }

  if (message.threadId !== undefined && message.queueMode !== "replace") {
    return false;
  }

  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }

  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string") {
    return false;
  }

  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

export type ClientMessage =
  | { type: "register"; session: Omit<SessionInfo, "id"> }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "presence"; name?: string; status?: string; model?: string; pendingAsks?: number; acceptsAsks?: boolean; lastIntercomActivity?: number };

export type BrokerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_queued"; messageId: string; reason: string }
  | { type: "delivery_failed"; messageId: string; reason: string };
