/**
 * Loader for the v2 golden transcripts (`protocol/golden/*.txt`) and a fake
 * serial port that replays one transcript case as the device.
 *
 * Every fake device in the SDK tests is generated from these files, so the
 * wire text the tests exercise is the text the firmware produces
 * (docs/sdk-api-design.md section 8).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakePort } from "./fake-port.js";

export const GOLDEN_FILES = [
  "version-info",
  "map",
  "io",
  "pattern",
  "timestamp",
  "sync",
  "reset",
  "errors",
  "boundary",
  "events",
  "safety",
] as const;

export type GoldenFile = (typeof GOLDEN_FILES)[number];

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../protocol/golden");

export type GoldenItem =
  /** `response` holds the wire lines: the header, then any continuation lines. */
  | { kind: "request"; text: string; response: string[]; line: number }
  /** An asynchronous event as it appears on the wire (`! NAME ...`). */
  | { kind: "event"; wire: string; line: number }
  /**
   * A harness directive. `response` is only filled for `~ send_hex`, whose raw
   * bytes the device answers (or not) without a `>` request line.
   */
  | { kind: "directive"; text: string; response: string[]; line: number };

export interface GoldenCase {
  file: GoldenFile;
  /** First `# --- title ---` comment of the case ("" if it has none). */
  title: string;
  items: GoldenItem[];
  /** The case sends raw bytes (`~ send_hex`) that a text-mode host cannot produce. */
  hasSendHex: boolean;
  /** 1-based line of the first non-comment line. */
  line: number;
}

/** Parse the text of one transcript into its test cases. */
export function parseGolden(file: GoldenFile, text: string): GoldenCase[] {
  const cases: GoldenCase[] = [];
  let current: GoldenCase | null = null;
  let title = "";
  let request: Extract<GoldenItem, { response: string[] }> | null = null;

  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (line.trim() === "") {
      current = null;
      request = null;
      title = "";
      return;
    }
    if (line.startsWith("#")) {
      const m = /^# --- (.*?) ---$/.exec(line);
      if (m && title === "") title = m[1];
      return;
    }
    if (current === null) {
      current = { file, title, items: [], hasSendHex: false, line: lineNo };
      cases.push(current);
    }
    if (line.startsWith("> ")) {
      request = { kind: "request", text: line.slice(2), response: [], line: lineNo };
      current.items.push(request);
    } else if (line.startsWith("< ! ")) {
      request = null;
      current.items.push({ kind: "event", wire: line.slice(2), line: lineNo });
    } else if (line.startsWith("< ")) {
      if (request === null) throw new Error(`${file}.txt:${lineNo}: response without request`);
      request.response.push(line.slice(2));
    } else if (line.startsWith("~ ")) {
      const directive: GoldenItem = {
        kind: "directive",
        text: line.slice(2),
        response: [],
        line: lineNo,
      };
      current.items.push(directive);
      if (line.startsWith("~ send_hex")) {
        current.hasSendHex = true;
        request = directive;
      } else {
        request = null;
      }
    } else {
      throw new Error(`${file}.txt:${lineNo}: unrecognised golden line: ${line}`);
    }
  });
  return cases;
}

const cache = new Map<GoldenFile, GoldenCase[]>();

/** All cases of one golden file. */
export function loadGolden(file: GoldenFile): GoldenCase[] {
  let cases = cache.get(file);
  if (cases === undefined) {
    cases = parseGolden(file, readFileSync(join(GOLDEN_DIR, `${file}.txt`), "utf8"));
    cache.set(file, cases);
  }
  return cases;
}

/** The single case of `file` whose title is `needle`, or else contains it. */
export function goldenCase(file: GoldenFile, needle: string): GoldenCase {
  const cases = loadGolden(file);
  const exact = cases.filter((c) => c.title === needle);
  const found = exact.length > 0 ? exact : cases.filter((c) => c.title.includes(needle));
  if (found.length !== 1) {
    throw new Error(`${file}.txt: ${found.length} cases match "${needle}" (expected 1)`);
  }
  return found[0];
}

/** Wire response lines (header, then continuation lines) of `request` in a case. */
export function goldenResponse(c: GoldenCase, request: string): string[] {
  const item = c.items.find((i) => i.kind === "request" && i.text === request);
  if (item === undefined || item.kind !== "request") {
    throw new Error(`${c.file}.txt case "${c.title}": no request "${request}"`);
  }
  return item.response;
}

/** The golden `version` exchange, used as the open handshake of every Connection. */
export function handshakeItems(): GoldenItem[] {
  return [goldenRequest("version-info", "version", "version")];
}

/** The first request `text` of the case titled `needle` as a standalone item. */
export function goldenRequest(file: GoldenFile, needle: string, text: string): GoldenItem {
  const c = goldenCase(file, needle);
  const item = c.items.find((i) => i.kind === "request" && i.text === text);
  if (item === undefined) throw new Error(`${file}.txt "${needle}": no request "${text}"`);
  return item;
}

/**
 * Fake serial port that plays the device side of a transcript: each host
 * line must equal the next `>` request, the recorded response lines are fed
 * back, and events that follow in the transcript are emitted right after.
 */
export class GoldenPort extends FakePort {
  private cursor = 0;

  constructor(private readonly items: readonly GoldenItem[]) {
    super();
    this.onCommand = (cmd) => this.answer(cmd);
  }

  /**
   * Emit the events that precede the first request. Call after the host has
   * attached its listeners, or those events are lost.
   */
  start(): this {
    this.pump();
    return this;
  }

  /** Requests of the transcript the host has not sent yet. */
  remainingRequests(): number {
    return this.items.slice(this.cursor).filter((i) => i.kind === "request").length;
  }

  private answer(cmd: string): void {
    const item = this.items[this.cursor];
    if (item === undefined || item.kind !== "request") {
      throw new Error(`unexpected request "${cmd}": transcript has nothing more to answer`);
    }
    if (item.text !== cmd) {
      throw new Error(
        `request mismatch at golden line ${item.line}: expected "${item.text}", host sent "${cmd}"`,
      );
    }
    this.cursor++;
    this.feed(...item.response);
    this.pump();
  }

  /** Skip directives and emit events until the next request. */
  private pump(): void {
    for (;;) {
      const item = this.items[this.cursor];
      if (item === undefined || item.kind === "request") return;
      this.cursor++;
      if (item.kind === "event") this.feed(item.wire);
    }
  }
}
