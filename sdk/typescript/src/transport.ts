/**
 * Serial transport: line-oriented command/response exchange with push event
 * multiplexing. Implements the transport contract R-H1 to R-H3 of
 * docs/sdk-api-design.md (R-H4, subscription ownership, lives in
 * connection.ts).
 *
 * - **One command, one response (R-H1).** A response is a single `OK ...` /
 *   `ERR <NAME>` line, or an `OK` header carrying `count=<N>` followed by
 *   exactly N continuation lines. The header decides: there is no per-command
 *   list of counted commands, and no drain-and-discard of "extra" lines.
 * - **Resynchronisation (R-H2).** A timeout, an unparseable line or a short
 *   counted response leaves the connection in `desync`. The next operation
 *   first sends `ping <random u32>` and discards every response line until
 *   `OK pong=<same value>` arrives (push events are routed meanwhile). If that
 *   fails the connection is closed (`Disconnected`).
 * - **DTR (R-H3).** `Transport.open` / `Transport.attach` assert DTR before the
 *   transport is used; the device sends no events without it.
 *
 * Push lines (`! ...`) are routed to the `push-event` event and never queue as
 * responses, so an event arriving mid-command cannot corrupt response parsing.
 */

import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
import { ErrorCode, SdkError } from "./errors.js";
import { okData, parseCountField, parsePushEvent, parseResponse } from "./protocol.js";
import type { PushEvent } from "./types.js";

/** Conventional baud rate. Irrelevant for USB CDC but required by the API. */
export const BAUD_RATE = 115_200;

/** Default time to wait for a command response line (ms). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 2_000;

/** Prefix of a continuation line of a counted response (R-T2). */
const CONTINUATION_PREFIX = "  ";

/**
 * Minimal duplex-port surface the transport needs. Satisfied by
 * `SerialPort` and `SerialPortMock` instances.
 */
export interface PortLike {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  write(data: Buffer | string, cb?: (err?: Error | null) => void): unknown;
  set(options: { dtr?: boolean }, cb?: (err?: Error | null) => void): unknown;
  close(cb?: (err?: Error | null) => void): unknown;
  readonly isOpen?: boolean;
}

interface Waiter {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface TransportEvents {
  "push-event": [PushEvent];
}

/** A complete response: the header line and its continuation lines. */
interface Reply {
  header: string;
  lines: string[];
}

export class Transport extends EventEmitter<TransportEvents> {
  private readonly port: PortLike;
  private acc = "";
  private responses: string[] = [];
  private waiters: Waiter[] = [];
  private disconnected = false;
  /** Why the port went away (a port error's message), kept for every later Disconnected error. */
  private disconnectDetail: string | undefined;
  /** Set by a timeout or framing error; cleared by a successful resync. */
  private desync = false;
  /** Tail of the operation queue: one command is in flight at a time. */
  private queue: Promise<void> = Promise.resolve();
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
  /** Sink for protocol errors that have no caller to report to (unknown events). */
  logError: (message: string) => void = (message) => console.error(message);

  constructor(port: PortLike) {
    super();
    this.port = port;
    port.on("data", (chunk) => this.onData(chunk));
    port.on("close", () => this.onDisconnect());
    port.on("error", (err: Error) => this.onDisconnect(err.message));
  }

  /** Open the serial port at `path`, assert DTR and wrap it. */
  static open(path: string): Promise<Transport> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate: BAUD_RATE }, (err) => {
        if (err) {
          reject(new SdkError(ErrorCode.Connection, `failed to open ${path}: ${err.message}`));
          return;
        }
        Transport.attach(port).then(resolve, (attachErr: unknown) => {
          port.close(() => reject(attachErr));
        });
      });
    });
  }

  /** Assert DTR on an already-open port and wrap it (R-H3). */
  static attach(port: PortLike): Promise<Transport> {
    return new Promise((resolve, reject) => {
      port.set({ dtr: true }, (err) => {
        if (err) {
          reject(new SdkError(ErrorCode.Connection, `failed to assert DTR: ${err.message}`));
        } else {
          resolve(new Transport(port));
        }
      });
    });
  }

  /**
   * Send a command whose response is a single `OK` line and return its data.
   * A device `ERR` becomes a typed error; a counted response is a parse error.
   */
  command(cmd: string): Promise<string> {
    return this.exclusive(async () => {
      const { header, lines } = await this.exchange(cmd);
      const data = okData(parseResponse(header));
      if (lines.length > 0 || parseCountField(data) !== null) {
        throw SdkError.parse(`unexpected counted response to \`${cmd}\`: ${header}`);
      }
      return data;
    });
  }

  /**
   * Send a command whose response is `OK ... count=N` followed by exactly N
   * continuation lines (`ts get`, `help`). Returns the OK data and the lines.
   */
  commandCounted(cmd: string): Promise<[string, string[]]> {
    return this.exclusive(async () => {
      const { header, lines } = await this.exchange(cmd);
      const data = okData(parseResponse(header));
      if (parseCountField(data) === null) {
        throw SdkError.parse(`missing count= in the response to \`${cmd}\`: ${header}`);
      }
      return [data, lines];
    });
  }

  /**
   * Send an arbitrary command and return every line of the response: the
   * header (`OK ...` / `ERR ...`, as received) and any continuation lines.
   */
  raw(cmd: string): Promise<string[]> {
    return this.exclusive(async () => {
      const { header, lines } = await this.exchange(cmd);
      return [header, ...lines];
    });
  }

  /** Close the underlying port. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.onDisconnect();
      if (this.port.isOpen === false) {
        resolve();
        return;
      }
      this.port.close(() => resolve());
    });
  }

  /** Run `fn` after every earlier operation finished, resynchronising first if needed. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ensureSynced();
      return fn();
    });
    // The queue only orders operations; each caller receives its own result
    // or error through `run`.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Write `cmd` and read exactly one complete response. */
  private async exchange(cmd: string): Promise<Reply> {
    await this.writeLine(cmd);
    const header = await this.recvOrDesync();
    const response = this.classify(header);
    if (response.kind !== "ok") return { header, lines: [] };

    let count: number | null;
    try {
      count = parseCountField(response.data);
    } catch (err) {
      this.desync = true; // the number of lines that follow is unknown
      throw err;
    }
    const lines: string[] = [];
    for (let i = 0; count !== null && i < count; i++) {
      const line = await this.recvOrDesync();
      if (!line.startsWith(CONTINUATION_PREFIX)) {
        this.desync = true;
        throw SdkError.parse(
          `expected continuation line ${i + 1} of ${count} to start with two spaces: ${line}`,
        );
      }
      lines.push(line);
    }
    return { header, lines };
  }

  private classify(line: string): ReturnType<typeof parseResponse> {
    try {
      return parseResponse(line);
    } catch (err) {
      this.desync = true;
      throw err;
    }
  }

  /** Receive one line; a timeout leaves the connection in desync. */
  private async recvOrDesync(): Promise<string> {
    try {
      return await this.recvLine(this.timeoutMs);
    } catch (err) {
      if (err instanceof SdkError && err.code === ErrorCode.Timeout) this.desync = true;
      throw err;
    }
  }

  /**
   * Bring the connection back in step with the device if a previous exchange
   * failed or an unsolicited line is waiting: send `ping <nonce>` and discard
   * every line (stale responses included) until `OK pong=<nonce>`.
   */
  private async ensureSynced(): Promise<void> {
    if (!this.desync && this.responses.length === 0) return;
    const nonce = randomInt(0, 0x1_0000_0000);
    const expected = `OK pong=${nonce}`;
    try {
      await this.writeLine(`ping ${nonce}`);
      for (;;) {
        if ((await this.recvLine(this.timeoutMs)) === expected) break;
      }
    } catch (err) {
      await this.close();
      const reason = err instanceof Error ? err.message : String(err);
      throw SdkError.disconnected(`resynchronisation failed: ${reason}`);
    }
    this.desync = false;
  }

  private onData(chunk: Buffer): void {
    this.acc += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.acc.indexOf("\n")) >= 0) {
      const line = this.acc.slice(0, idx).replace(/\r+$/, "");
      this.acc = this.acc.slice(idx + 1);
      if (line.length === 0) continue;
      if (line.startsWith("! ")) {
        this.dispatchEvent(line.slice(2));
      } else if (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        this.responses.push(line);
      }
    }
  }

  /**
   * Parse and emit one push line. An unknown or malformed event is logged as
   * an error and discarded: it is never delivered to a subscriber and never
   * queued as a response.
   */
  private dispatchEvent(payload: string): void {
    let event: ReturnType<typeof parsePushEvent>;
    try {
      event = parsePushEvent(payload);
    } catch (err) {
      this.logError(
        `discarded malformed event "! ${payload}": ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
    if (event.type === "unknown") {
      this.logError(`discarded unknown event "! ${event.raw}"`);
      return;
    }
    this.emit("push-event", event);
  }

  private onDisconnect(detail?: string): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.disconnectDetail = detail;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(SdkError.disconnected(detail));
    }
  }

  private writeLine(cmd: string): Promise<void> {
    if (this.disconnected) return Promise.reject(SdkError.disconnected(this.disconnectDetail));
    return new Promise((resolve, reject) => {
      this.port.write(`${cmd}\r\n`, (err) => {
        if (err) {
          reject(this.disconnected ? SdkError.disconnected(this.disconnectDetail) : err);
        } else {
          resolve();
        }
      });
    });
  }

  private recvLine(timeoutMs: number): Promise<string> {
    const queued = this.responses.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.disconnected) return Promise.reject(SdkError.disconnected(this.disconnectDetail));
    if (timeoutMs <= 0) return Promise.reject(SdkError.timeout());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(SdkError.timeout());
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}
