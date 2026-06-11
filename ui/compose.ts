import type { Component, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { IntercomClient } from "../broker/client.js";
import type { SessionInfo } from "../types.js";

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

  handleInput(data: string): void {
    if (this.sending) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ sent: false });
      return;
    }

    if (data === "\t") {
      this.mode = this.mode === "send" ? "ask" : "send";
      this.tui.requestRender();
      return;
    }

    if (data.startsWith("\x1b")) {
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.inputBuffer.trim()) {
        this.sendMessage();
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
      
      this.done({
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
    const innerWidth = Math.max(24, Math.min(width - 2, 72));
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
