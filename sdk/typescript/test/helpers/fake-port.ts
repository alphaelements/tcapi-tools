import { EventEmitter } from "node:events";
import type { PortLike } from "../../src/transport.js";

/** In-memory fake serial port: feeds scripted lines, records written commands. */
export class FakePort extends EventEmitter implements PortLike {
  written: string[] = [];
  isOpen = true;
  /** Last DTR level the host set (`undefined` until it sets one). */
  dtr: boolean | undefined;
  /** Make `set()` fail with this error. */
  setError: Error | null = null;
  /** Called with each complete command line written by the host. */
  onCommand: ((cmd: string) => void) | null = null;
  private writeAcc = "";

  write(data: Buffer | string, cb?: (err?: Error | null) => void): boolean {
    this.writeAcc += data.toString();
    let idx: number;
    while ((idx = this.writeAcc.indexOf("\n")) >= 0) {
      const line = this.writeAcc.slice(0, idx).replace(/\r+$/, "");
      this.writeAcc = this.writeAcc.slice(idx + 1);
      this.written.push(line);
      this.onCommand?.(line);
    }
    cb?.(null);
    return true;
  }

  set(options: { dtr?: boolean }, cb?: (err?: Error | null) => void): void {
    if (this.setError === null) this.dtr = options.dtr;
    cb?.(this.setError);
  }

  close(cb?: (err?: Error | null) => void): void {
    this.isOpen = false;
    this.emit("close");
    cb?.(null);
  }

  /** Simulate device -> host lines (each terminated with CR/LF). */
  feed(...lines: string[]): void {
    for (const line of lines) {
      this.emit("data", Buffer.from(`${line}\r\n`));
    }
  }

  /** Simulate device -> host raw bytes (no line ending added). */
  feedRaw(data: string): void {
    this.emit("data", Buffer.from(data));
  }
}
