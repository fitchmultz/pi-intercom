import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { IntercomClient } from "../broker/client.js";
import type { SessionInfo } from "../types.js";
import { ComposeInputNormalizer } from "./compose-input.js";

const ESC_PENDING_TIMEOUT_MS = 25;

export interface ComposeResult {
  sent: boolean;
  messageId?: string;
  text?: string;
  expectsReply?: boolean;
}

export class ComposeOverlay implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private target: SessionInfo;
  private targetLabel: string;
  private client: IntercomClient;
  private done: (result: ComposeResult) => void;
  private inputBuffer: string = "";
  private mode: "send" | "ask" = "send";
  private normalizer = new ComposeInputNormalizer();
  private pendingEscape: string | null = null;
  private pendingEscapeTimer: NodeJS.Timeout | null = null;
  private completed = false;
  private sending: boolean = false;
  private error: string | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    target: SessionInfo,
    targetLabel: string,
    client: IntercomClient,
    done: (result: ComposeResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.target = target;
    this.targetLabel = targetLabel;
    this.client = client;
    this.done = done;
  }

  invalidate(): void {}

  private finish(result: ComposeResult): void {
    if (this.completed) return;
    this.completed = true;
    this.clearPendingEscape();
    this.normalizer.reset();
    this.done(result);
  }

  private clearPendingEscape(): void {
    if (this.pendingEscapeTimer) {
      clearTimeout(this.pendingEscapeTimer);
      this.pendingEscapeTimer = null;
    }
    this.pendingEscape = null;
  }

  private holdPendingEscape(): void {
    this.pendingEscape = "\x1b";
    this.pendingEscapeTimer = setTimeout(() => {
      if (this.pendingEscape === "\x1b") {
        this.finish({ sent: false });
      }
    }, ESC_PENDING_TIMEOUT_MS);
  }

  handleInput(data: string): void {
    if (this.sending || this.completed) return;

    if (this.pendingEscape) {
      this.clearPendingEscape();
      data = "\x1b" + data;
    } else if (data === "\x1b") {
      this.holdPendingEscape();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish({ sent: false });
      return;
    }

    const normalized = this.normalizer.normalize(data);
    data = normalized.text;
    if (!data) return;

    if (!normalized.bracketedPaste && data === "\t") {
      this.mode = this.mode === "send" ? "ask" : "send";
      this.tui.requestRender();
      return;
    }

    if (data.startsWith("\x1b")) {
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.inputBuffer.length > 0) {
        void this.sendMessage();
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.inputBuffer = [...this.inputBuffer].slice(0, -1).join("");
      this.tui.requestRender();
      return;
    }

    const printable = [...data].filter(c => c >= " " || c === "\n" || c === "\t").join("");
    if (printable) {
      this.inputBuffer += printable;
      this.tui.requestRender();
    }
  }

  private async sendMessage(): Promise<void> {
    this.sending = true;
    this.error = null;
    this.tui.requestRender();

    try {
      const expectsReply = this.mode === "ask";
      const text = this.inputBuffer;
      const result = await this.client.send(this.target.id, {
        text,
        expectsReply,
      });
      
      if (!result.delivered) {
        this.error = result.reason ?? "Message not delivered. Session may not exist or has disconnected.";
        this.sending = false;
        this.tui.requestRender();
        return;
      }
      
      this.finish({
        sent: true,
        messageId: result.id,
        text,
        expectsReply,
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.sending = false;
      this.tui.requestRender();
    }
  }

  private renderInputLines(row: (text?: string) => string, lines: string[]): void {
    const rawLines = this.inputBuffer.split("\n");
    const visibleLines = rawLines.slice(-8);
    visibleLines.forEach((line, index) => {
      const isLast = index === visibleLines.length - 1;
      lines.push(row(`${index === 0 ? " > " : "   "}${line}${isLast ? "█" : ""}`));
    });
  }

  render(width: number): string[] {
    if (width < 3) return [truncateToWidth("Intercom", width)];
    const innerWidth = Math.min(width, 72);
    const contentWidth = Math.max(1, innerWidth - 2);
    const footer = `${this.keybindings.getKeys("tui.select.confirm").join("/")}: ${this.mode === "ask" ? "Ask" : "Send"} • Tab: ${this.mode === "ask" ? "Send mode" : "Ask mode"} • ${this.keybindings.getKeys("tui.select.cancel").join("/")}: Close`;
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines: string[] = [];
    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(row(this.theme.bold(` ${this.mode === "ask" ? "Ask" : "Send"} to: ${this.targetLabel}`)));
    lines.push(row(this.theme.fg("dim", ` ${this.target.cwd} • ${this.target.model}`)));
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row());

    if (this.sending) {
      lines.push(row(this.theme.fg("dim", " Sending...")));
    } else if (this.error) {
      lines.push(row(this.theme.fg("error", ` Error: ${this.error}`)));
      lines.push(row());
      this.renderInputLines(row, lines);
    } else {
      this.renderInputLines(row, lines);
    }

    lines.push(row());
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row(this.theme.fg("dim", ` ${footer}`)));
    lines.push(border(`╰${"─".repeat(contentWidth)}╯`));

    return lines;
  }
}
