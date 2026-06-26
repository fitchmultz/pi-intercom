import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getPiAgentDir } from "../agent-dir.js";
import { writeMessage, createMessageReader } from "./framing.js";
import { getBrokerSocketPath } from "./paths.js";
import { isMessage } from "../types.js";
import type { SessionInfo, Message, BrokerMessage } from "../types.js";

const INTERCOM_DIR = join(getPiAgentDir(), "intercom");
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");

const REPLACE_DELIVERY_DELAY_MS = 1500;

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

interface PendingReplaceDelivery {
  from: SessionInfo;
  fromId: string;
  toId: string;
  message: Message;
  timer: NodeJS.Timeout;
}

function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const session = value as Record<string, unknown>;

  if (
    typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) {
    return false;
  }

  if (session.name !== undefined && typeof session.name !== "string") {
    return false;
  }

  if (session.status !== undefined && typeof session.status !== "string") {
    return false;
  }

  if (session.lastSeen !== undefined && typeof session.lastSeen !== "number") {
    return false;
  }

  if (session.lastIntercomActivity !== undefined && typeof session.lastIntercomActivity !== "number") {
    return false;
  }

  if (session.pendingAsks !== undefined && typeof session.pendingAsks !== "number") {
    return false;
  }

  return session.acceptsAsks === undefined || typeof session.acceptsAsks === "boolean";
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private pendingReplaceDeliveries = new Map<string, PendingReplaceDelivery>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true });
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.server.listen(SOCKET_PATH, () => {
      writeFileSync(PID_PATH, String(process.pid));
      console.log(`Intercom broker started (pid: ${process.pid})`);
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader((msg) => {
      this.handleMessage(socket, msg, sessionId, (id) => {
        sessionId = id;
      });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    socket.on("close", () => {
      if (sessionId) {
        this.sessions.delete(sessionId);
        this.clearPendingReplaceDeliveries(sessionId);
        this.broadcast({ type: "session_left", sessionId }, sessionId);

        this.scheduleShutdownCheck();
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000);
  }

  private handleMessage(
    socket: net.Socket,
    msg: unknown,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;

    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    if (currentId !== null) {
      this.touchActivity(currentId, false);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }

        if (currentId) {
          throw new Error("Received duplicate register message");
        }
        
        const id = randomUUID();
        setId(id);
        const now = Date.now();
        const info: SessionInfo = {
          ...clientMessage.session,
          id,
          lastSeen: clientMessage.session.lastSeen ?? now,
        };
        this.sessions.set(id, { socket, info });
        
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, { type: "registered", sessionId: id });
        this.broadcast({ type: "session_joined", session: info }, id);
        break;
      }

      case "unregister": {
        if (currentId === null) {
          throw new Error("Received unregister before register");
        }
        const sessionId = currentId;
        this.sessions.delete(sessionId);
        this.clearPendingReplaceDeliveries(sessionId);
        this.broadcast({ type: "session_left", sessionId }, sessionId);
        setId(null);
        this.scheduleShutdownCheck();
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }

        const sessions = Array.from(this.sessions.values()).map(s => s.info);
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "send": {
        const message = clientMessage.message;
        const messageId = isMessage(message) ? message.id : "unknown";

        if (typeof clientMessage.to !== "string" || !isMessage(message)) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId,
            reason: "Invalid message format",
          });
          break;
        }

        if (currentId === null) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: message.id,
            reason: "Sender session not found",
          });
          break;
        }

        const targets = this.findSessions(clientMessage.to);
        if (targets.length === 1) {
          const fromSession = this.sessions.get(currentId);
          if (!fromSession) {
            writeMessage(socket, {
              type: "delivery_failed",
              messageId: message.id,
              reason: "Sender session not found",
            });
            break;
          }
          this.touchActivity(currentId, true);
          if (message.delivery === "queue" && message.queueMode === "replace" && message.threadId) {
            this.queueReplaceDelivery(currentId, targets[0].info.id, fromSession.info, message);
          } else {
            this.deliverMessage(targets[0].info.id, fromSession.info, message);
          }
          writeMessage(socket, { type: "delivered", messageId: message.id });
          break;
        }

        if (targets.length > 1) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: message.id,
            reason: `Multiple sessions named \"${clientMessage.to}\" are connected. Use the session ID instead.`,
          });
          break;
        }

        writeMessage(socket, {
          type: "delivery_failed",
          messageId: message.id,
          reason: "Session not found",
        });
        break;
      }

      case "presence": {
        if (currentId === null) {
          throw new Error("Received presence before register");
        }
        const session = this.sessions.get(currentId);
        if (session) {
          if (clientMessage.name !== undefined) {
            if (typeof clientMessage.name !== "string") {
              throw new Error("Invalid presence name");
            }
            session.info.name = clientMessage.name;
          }
          if (clientMessage.status !== undefined) {
            if (typeof clientMessage.status !== "string") {
              throw new Error("Invalid presence status");
            }
            session.info.status = clientMessage.status;
          }
          if (clientMessage.model !== undefined) {
            if (typeof clientMessage.model !== "string") {
              throw new Error("Invalid presence model");
            }
            session.info.model = clientMessage.model;
          }
          if (clientMessage.pendingAsks !== undefined) {
            if (typeof clientMessage.pendingAsks !== "number" || !Number.isFinite(clientMessage.pendingAsks) || clientMessage.pendingAsks < 0) {
              throw new Error("Invalid presence pendingAsks");
            }
            session.info.pendingAsks = clientMessage.pendingAsks;
          }
          if (clientMessage.acceptsAsks !== undefined) {
            if (typeof clientMessage.acceptsAsks !== "boolean") {
              throw new Error("Invalid presence acceptsAsks");
            }
            session.info.acceptsAsks = clientMessage.acceptsAsks;
          }
          if (clientMessage.lastIntercomActivity !== undefined) {
            if (typeof clientMessage.lastIntercomActivity !== "number" || !Number.isFinite(clientMessage.lastIntercomActivity)) {
              throw new Error("Invalid presence lastIntercomActivity");
            }
            session.info.lastIntercomActivity = clientMessage.lastIntercomActivity;
          }
          const now = Date.now();
          session.info.lastActivity = now;
          session.info.lastSeen = now;
          this.broadcast({ type: "presence_update", session: session.info }, currentId);
        }
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  /** Update liveness/intercom-activity timestamps for a connected session. */
  private touchActivity(sessionId: string, comms: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const now = Date.now();
    session.info.lastSeen = now;
    if (comms) {
      session.info.lastIntercomActivity = now;
    }
  }

  private replaceKey(fromId: string, toId: string, threadId: string): string {
    return `${fromId}\0${toId}\0${threadId}`;
  }

  private queueReplaceDelivery(fromId: string, toId: string, from: SessionInfo, message: Message): void {
    const key = this.replaceKey(fromId, toId, message.threadId ?? "");
    const existing = this.pendingReplaceDeliveries.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pendingReplaceDeliveries.delete(key);
      this.deliverMessage(toId, from, message);
    }, REPLACE_DELIVERY_DELAY_MS);
    timer.unref?.();
    this.pendingReplaceDeliveries.set(key, { from, fromId, toId, message, timer });
  }

  private clearPendingReplaceDeliveries(sessionId: string): void {
    for (const [key, pending] of this.pendingReplaceDeliveries) {
      if (pending.toId === sessionId || (pending.fromId === sessionId && pending.message.expectsReply)) {
        clearTimeout(pending.timer);
        this.pendingReplaceDeliveries.delete(key);
      }
    }
  }

  private deliverMessage(toId: string, from: SessionInfo, message: Message): void {
    const target = this.sessions.get(toId);
    if (!target) {
      return;
    }
    this.touchActivity(toId, true);
    writeMessage(target.socket, {
      type: "message",
      from,
      message,
    });
  }

  private findSessions(nameOrId: string): ConnectedSession[] {
    const byId = this.sessions.get(nameOrId);
    if (byId) {
      return [byId];
    }

    const lowerName = nameOrId.toLowerCase();
    return Array.from(this.sessions.values()).filter(session => session.info.name?.toLowerCase() === lowerName);
  }

  private broadcast(msg: BrokerMessage, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private shutdown(): void {
    console.log("Broker shutting down");
    
    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // The socket may already be gone if shutdown started after a disconnect.
      }
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // The PID file may already be gone if startup never completed.
    }
    this.server.close();
    process.exit(0);
  }
}

new IntercomBroker().start();
