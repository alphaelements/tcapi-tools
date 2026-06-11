/**
 * Serial transport: line-oriented command/response exchange with push
 * event multiplexing. Mirrors `sdk/rust/src/transport.rs`.
 *
 * Incoming data is split into lines and routed: push lines (`! ...`)
 * are emitted as events, everything else feeds the response queue, so a
 * push event arriving mid-command never corrupts response parsing.
 *
 * Two read disciplines exist and must stay separate:
 * - `command` — exactly one response line (`OK`/`ERR`).
 * - `commandCounted` — `OK count=N` followed by exactly N data lines
 *   (only `ts get`). Using a counted read on a single-line command
 *   (e.g. `sync count`) would hang until timeout; using a plain read on
 *   `ts get` would leave N lines behind. Never unify them.
 */

import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
import { ErrorCode, SdkError } from "./errors.js";
import { okData, parseCountField, parsePushEvent, parseResponse } from "./protocol.js";
import type { PushEvent } from "./types.js";

/** Conventional baud rate. Irrelevant for USB CDC but required by the API. */
export const BAUD_RATE = 115_200;

/** Default time to wait for a command response (ms). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 2_000;

/**
 * Minimal duplex-port surface the transport needs. Satisfied by
 * `SerialPort` and `SerialPortMock` instances.
 */
export interface PortLike {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  write(data: Buffer | string, cb?: (err?: Error | null) => void): unknown;
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

export class Transport extends EventEmitter<TransportEvents> {
  private readonly port: PortLike;
  private acc = "";
  private responses: string[] = [];
  private waiters: Waiter[] = [];
  private disconnected = false;
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;

  constructor(port: PortLike) {
    super();
    this.port = port;
    port.on("data", (chunk) => this.onData(chunk));
    port.on("close", () => this.onDisconnect());
    port.on("error", () => this.onDisconnect());
  }

  /** Open the serial port at `path` and wrap it. */
  static open(path: string): Promise<Transport> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate: BAUD_RATE }, (err) => {
        if (err) {
          reject(new SdkError(ErrorCode.Connection, `failed to open ${path}: ${err.message}`));
        } else {
          resolve(new Transport(port));
        }
      });
    });
  }

  /** Send a command expecting a single `OK`/`ERR` response line. */
  async command(cmd: string): Promise<string> {
    this.drainStaleResponses();
    await this.writeLine(cmd);
    const line = await this.recvResponse(this.timeoutMs);
    return okData(parseResponse(line));
  }

  /**
   * Send a command whose response is `OK count=N` followed by exactly N
   * data lines (`ts get` only). Returns the OK data and the N lines.
   */
  async commandCounted(cmd: string): Promise<[string, string[]]> {
    this.drainStaleResponses();
    await this.writeLine(cmd);

    const first = await this.recvResponse(this.timeoutMs);
    const data = okData(parseResponse(first));
    const count = parseCountField(data);

    // Per-line budget: large captures (e.g. ts get on a full ring) stream
    // many data lines and the USB CDC scheduler may pace them slower than a
    // single command-level timeout allows. Reset the budget for each line so
    // a slow stream does not trip the same timeout that bounds the OK line.
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(await this.recvResponse(this.timeoutMs));
    }
    return [data, lines];
  }

  /**
   * Send an arbitrary command and return the raw first response line
   * (`OK ...` / `ERR ...` as received, unparsed). Stale extra lines are
   * discarded before the next command.
   */
  async raw(cmd: string): Promise<string> {
    this.drainStaleResponses();
    await this.writeLine(cmd);
    return this.recvResponse(this.timeoutMs);
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

  private dispatchEvent(payload: string): void {
    // A malformed known-type event is delivered as `unknown` rather than
    // dropped: losing the line silently would hide firmware mismatches.
    let event: PushEvent;
    try {
      event = parsePushEvent(payload);
    } catch (err) {
      event = {
        type: "unknown",
        raw: `${payload} (parse error: ${err instanceof Error ? err.message : err})`,
      };
    }
    this.emit("push-event", event);
  }

  private onDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(SdkError.disconnected());
    }
  }

  private writeLine(cmd: string): Promise<void> {
    if (this.disconnected) return Promise.reject(SdkError.disconnected());
    return new Promise((resolve, reject) => {
      this.port.write(`${cmd}\r\n`, (err) => {
        if (err) {
          reject(this.disconnected ? SdkError.disconnected() : err);
        } else {
          resolve();
        }
      });
    });
  }

  private recvResponse(timeoutMs: number): Promise<string> {
    const queued = this.responses.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.disconnected) return Promise.reject(SdkError.disconnected());
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

  /**
   * Discard response lines left over from a previous timed-out or raw
   * exchange so they cannot be mistaken for the next response.
   */
  private drainStaleResponses(): void {
    this.responses.length = 0;
  }
}
