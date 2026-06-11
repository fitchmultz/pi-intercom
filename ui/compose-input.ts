const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const BRACKETED_PASTE_MARKERS = [BRACKETED_PASTE_START, BRACKETED_PASTE_END];

export interface NormalizedComposeInput {
  text: string;
  bracketedPaste: boolean;
}

export class ComposeInputNormalizer {
  private inBracketedPaste = false;
  private pendingMarkerFragment = "";

  normalize(input: string): NormalizedComposeInput {
    let data = this.pendingMarkerFragment + input;
    this.pendingMarkerFragment = "";

    if (this.isPartialMarker(data)) {
      this.pendingMarkerFragment = data;
      return { text: "", bracketedPaste: true };
    }

    const hadMarker = BRACKETED_PASTE_MARKERS.some((marker) => data.includes(marker));
    const bracketedPaste = this.inBracketedPaste || hadMarker;

    if (data.includes(BRACKETED_PASTE_START)) this.inBracketedPaste = true;
    data = data.replaceAll(BRACKETED_PASTE_START, "");
    if (data.includes(BRACKETED_PASTE_END)) this.inBracketedPaste = false;
    data = data.replaceAll(BRACKETED_PASTE_END, "");

    const trailingPartialMarker = this.trailingPartialMarker(data);
    if (trailingPartialMarker) {
      data = data.slice(0, -trailingPartialMarker.length);
      this.pendingMarkerFragment = trailingPartialMarker;
    }

    return { text: data, bracketedPaste };
  }

  reset(): void {
    this.inBracketedPaste = false;
    this.pendingMarkerFragment = "";
  }

  private isPartialMarker(value: string): boolean {
    return BRACKETED_PASTE_MARKERS.some((marker) => marker.startsWith(value))
      && !BRACKETED_PASTE_MARKERS.some((marker) => value.includes(marker));
  }

  private trailingPartialMarker(value: string): string | undefined {
    return BRACKETED_PASTE_MARKERS
      .flatMap((marker) => Array.from({ length: marker.length - 1 }, (_, index) => marker.slice(0, index + 1)))
      .sort((a, b) => b.length - a.length)
      .find((prefix) => value.endsWith(prefix));
  }
}
