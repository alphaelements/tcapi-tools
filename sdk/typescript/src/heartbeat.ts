/**
 * Watchdog heartbeat helper (protocol-reference.md section 4, "Safety").
 * Mirrors `sdk/rust/src/heartbeat.rs`.
 *
 * The device trips its watchdog when it sees no `OK` answer for the timeout
 * given to `wdog`. Whoever enables the watchdog must keep the device busy:
 * `Connection.startHeartbeat` sends `ping <n>` periodically. The rules, shared
 * by every SDK (docs/sdk-api-design.md, "Heartbeat"):
 *
 * - **Period** = `timeout / 4`, at most 1 s (`heartbeatPeriodMs`). The first
 *   ping is sent one period after the start.
 * - **Serialised.** A heartbeat ping is a normal command exchange on the
 *   connection's command queue, so it is never written between another command
 *   and its response, nor inside a counted response.
 * - **A failure is reported once and not retried.** The first failed ping
 *   (timeout, `ERR`, wrong `pong`, disconnect) is delivered through the `error`
 *   event (only if a listener is attached; it never throws), `failure` and
 *   `waitFailure`, and the heartbeat ends. It does not send another ping and
 *   does not repair the connection: the device trips its watchdog, which is the
 *   safe outcome.
 * - **Closing changes nothing.** Stopping the heartbeat and closing the
 *   connection send no command and change no output; closing ends the
 *   heartbeat silently (not a failure).
 */

import { EventEmitter } from "node:events";
import { ErrorCode, SdkError } from "./errors.js";
import { WDOG_MAX_MS, WDOG_MIN_MS } from "./types.js";

/** Longest heartbeat period in milliseconds. */
const MAX_PERIOD_MS = 1000;

/**
 * The heartbeat period for a watchdog timeout: `timeout / 4`, at most 1 s.
 * `timeoutMs` must be a value `wdog` accepts for an enabled watchdog
 * (100-10000); `0` (disabled) needs no heartbeat and is refused.
 */
export function heartbeatPeriodMs(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < WDOG_MIN_MS || timeoutMs > WDOG_MAX_MS) {
    throw SdkError.invalidArgument(
      `heartbeat needs an enabled watchdog timeout between ${WDOG_MIN_MS} and ${WDOG_MAX_MS} ms, got ${timeoutMs}`,
    );
  }
  return Math.min(Math.floor(timeoutMs / 4), MAX_PERIOD_MS);
}

export interface HeartbeatEvents {
  /** The ping that ended the heartbeat failed. Emitted once, and only if a listener is attached. */
  error: [SdkError];
  /** The heartbeat ended (stopped, failed, or its connection was closed). Emitted once. */
  end: [];
}

/** One heartbeat ping: resolves when the device answered it, rejects on any failure. */
export type PingFn = (value: number) => Promise<unknown>;

const U32_RANGE = 0x1_0000_0000;

/**
 * A running heartbeat. Create it with `Connection.startHeartbeat`. `stop()`
 * (or closing the connection) ends it; that sends nothing to the device, so the
 * watchdog trips `timeout` after the last answered command unless something
 * else keeps it fed.
 */
export class Heartbeat extends EventEmitter<HeartbeatEvents> {
  /** The interval between pings in milliseconds. */
  readonly periodMs: number;
  private readonly ping: PingFn;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  private running = true;
  private counter = 0;
  private failed: SdkError | undefined;
  private failureWaiters: Array<(err: SdkError | undefined) => void> = [];

  /** @internal use `Connection.startHeartbeat`. */
  constructor(timeoutMs: number, ping: PingFn) {
    super();
    this.periodMs = heartbeatPeriodMs(timeoutMs);
    this.ping = ping;
    this.schedule();
  }

  /** True while pings are being sent (false after a failure and after `stop()`). */
  get isRunning(): boolean {
    return this.running;
  }

  /** The failure that ended the heartbeat, if any. */
  get failure(): SdkError | undefined {
    return this.failed;
  }

  /**
   * Wait up to `timeoutMs` for the failure that ends the heartbeat; resolves
   * `undefined` when none happens in time (or the heartbeat was stopped).
   */
  waitFailure(timeoutMs: number): Promise<SdkError | undefined> {
    if (this.failed !== undefined) return Promise.resolve(this.failed);
    if (!this.running) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter = (err: SdkError | undefined): void => {
        clearTimeout(timer);
        resolve(err);
      };
      const timer = setTimeout(() => {
        this.failureWaiters = this.failureWaiters.filter((w) => w !== waiter);
        resolve(undefined);
      }, timeoutMs);
      this.failureWaiters.push(waiter);
    });
  }

  /**
   * Stop sending pings and wait for an exchange in progress to finish (at most
   * one command timeout). Sends nothing to the device; a ping still in flight
   * is not reported as a failure. Calling it again does nothing.
   */
  async stop(): Promise<void> {
    this.end();
    await this.inflight;
  }

  private end(): void {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const waiter of this.failureWaiters.splice(0)) waiter(this.failed);
    this.emit("end");
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inflight = this.tick();
    }, this.periodMs);
  }

  private async tick(): Promise<void> {
    const value = this.counter;
    this.counter = (this.counter + 1) % U32_RANGE;
    try {
      await this.ping(value);
    } catch (err) {
      // After `stop()` (or a close) the heartbeat has ended: nobody is left to be told.
      if (this.running) this.fail(toSdkError(err));
      return;
    }
    if (this.running) this.schedule();
  }

  private fail(err: SdkError): void {
    this.failed = err;
    this.end();
    // `error` without a listener would throw out of a timer; the failure stays
    // available through `failure` / `waitFailure` instead.
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }
}

function toSdkError(err: unknown): SdkError {
  if (err instanceof SdkError) return err;
  return new SdkError(ErrorCode.Io, `heartbeat ping failed: ${err instanceof Error ? err.message : String(err)}`);
}
