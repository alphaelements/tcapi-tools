/**
 * High-level typed connection to one Tcapi-DIO device (protocol v2).
 * Mirrors `sdk/rust/src/connection.rs`.
 *
 * Push events are delivered through `on("input-change" | "pattern-done" |
 * "pattern-timeout" | "failsafe")` or `subscribeEvents()`. The SDK owns the device
 * `subscribe` command (R-H4): the subscriber count of the connection going
 * 0 -> 1 sends `subscribe on`, 1 -> 0 sends `subscribe off`, and there is one
 * device subscription per connection fanned out to all subscribers. There is no
 * public `subscribe(bool)`, and `raw()` rejects `subscribe`.
 */

import { EventEmitter } from "node:events";
import {
  discover,
  findByDeviceNumber,
  findByUid,
  selectSoleDevice,
} from "./discovery.js";
import { SdkError } from "./errors.js";
import { Heartbeat } from "./heartbeat.js";
import * as protocol from "./protocol.js";
import { Transport, type PortLike } from "./transport.js";
import {
  type Capabilities,
  type DeviceInfo,
  type EdgeMode,
  type IoState,
  type Pads,
  type PatternMode,
  type PatternStatus,
  type PatternStep,
  type PinMap,
  type PushEvent,
  type ResetInfo,
  type SafetyConfig,
  type SafetyState,
  type TimestampResult,
  type TsStatus,
  type VersionInfo,
  hex8,
} from "./types.js";

export interface ConnectionEvents {
  "input-change": [{ inputs: number; timestampUs: number }];
  "pattern-done": [{ loops: number }];
  "pattern-timeout": [{ loops: number }];
  /**
   * `! FAILSAFE cause=<wdog|usb>`: the failsafe latch was set (a device with
   * `FEAT_WDOG`). The event can be missed; `safety()` is the source of truth.
   */
  failsafe: [{ cause: "wdog" | "usb" }];
  /**
   * A subscription change started by `on` / `off` of "input-change" failed.
   * With no listener Node throws, so the failure is never silent; use
   * `subscribeEvents()` to get the error from a promise instead.
   */
  error: [SdkError];
}

/** Stops one `subscribeEvents()` subscription; calling it again does nothing. */
export type Unsubscribe = () => Promise<void>;

const U32_MAX = 0xffffffff;

/** `0x` + 8 lower-case hex digits, the form of the device's masks. */
function hex32(value: number): string {
  return `0x${hex8(value)}`;
}

export class Connection {
  private readonly transport: Transport;
  private readonly portPath: string;
  /** Untyped on purpose: the typed surface is `on` / `off` / `dispatch`, keyed by `ConnectionEvents`. */
  private readonly emitter = new EventEmitter();
  private readonly subscribers = new Set<(event: PushEvent) => void>();
  /** Subscriber count of the connection: listeners of "input-change" + `subscribeEvents()` callers. */
  private subscriberCount = 0;
  /** Tail of the queue that orders `subscribe on` / `subscribe off` commands. */
  private subscriptionQueue: Promise<void> = Promise.resolve();
  private firmware = "";
  /** Heartbeats started on this connection; `close()` ends them. */
  private readonly heartbeats = new Set<Heartbeat>();

  private constructor(transport: Transport, portPath: string) {
    this.transport = transport;
    this.portPath = portPath;
    transport.on("push-event", (event) => this.dispatch(event));
  }

  /** Open a connection to the device at the given serial port path. */
  static async open(port: string): Promise<Connection> {
    return Connection.handshake(await Transport.open(port), port);
  }

  /** Discover devices and connect to the one with the given UID. */
  static async openByUid(uid: string): Promise<Connection> {
    const device = findByUid(await discover(), uid);
    return Connection.open(device.port);
  }

  /** Discover devices and connect to the one with the given device number. */
  static async openByDeviceNumber(n: number): Promise<Connection> {
    const device = findByDeviceNumber(await discover(), n);
    return Connection.open(device.port);
  }

  /** Discover devices and connect to the sole connected device. */
  static async openSoleDevice(): Promise<Connection> {
    const device = selectSoleDevice(await discover());
    return Connection.open(device.port);
  }

  /** Wrap an already-open port (mock tests, custom transports): asserts DTR and checks `version`. */
  static async fromPort(port: PortLike): Promise<Connection> {
    return Connection.handshake(await Transport.attach(port), "");
  }

  /** Issue `version`; anything but `proto=2` is UnsupportedFirmware and closes the port. */
  private static async handshake(transport: Transport, portPath: string): Promise<Connection> {
    const connection = new Connection(transport, portPath);
    try {
      protocol.assertSupportedProtocol(await connection.version());
    } catch (err) {
      await transport.close();
      throw err;
    }
    return connection;
  }

  /** Set the command response timeout in milliseconds (default 2000). */
  setTimeout(timeoutMs: number): void {
    this.transport.timeoutMs = timeoutMs;
  }

  /** Replace the sink for protocol errors without a caller (unknown events); default `console.error`. */
  set logError(sink: (message: string) => void) {
    this.transport.logError = sink;
  }

  // --- device information ---

  /** `version` — firmware and protocol version. */
  async version(): Promise<VersionInfo> {
    const v = protocol.parseVersion(await this.transport.command("version"));
    this.firmware = `${v.major}.${v.minor}.${v.patch}`;
    return v;
  }

  /** `caps` — device capabilities. */
  async caps(): Promise<Capabilities> {
    return protocol.parseCaps(await this.transport.command("caps"));
  }

  /** `info` — device identification (UID, device number); `version` is the `fw=` value seen at open. */
  async info(): Promise<DeviceInfo> {
    const { uid, deviceNumber } = protocol.parseInfo(await this.transport.command("info"));
    return { uid, deviceNumber, port: this.portPath, version: this.firmware };
  }

  /** `devnum <n>` — set the device number (0-254; 255 unassigns). */
  async setDeviceNumber(n: number): Promise<void> {
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw SdkError.invalidArgument(`device number ${n} is outside 0-255`);
    }
    await this.transport.command(`devnum ${n}`);
  }

  /** `ping <value>` — returns the echoed value; a different `pong` is a parse error. */
  async ping(value: number): Promise<number> {
    if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
      throw SdkError.invalidArgument(`ping value ${value} is not an unsigned 32-bit integer`);
    }
    const pong = protocol.parsePong(await this.transport.command(`ping ${value}`));
    if (pong !== value) throw SdkError.parse(`ping ${value} was answered with pong=${pong}`);
    return pong;
  }

  // --- digital I/O ---

  /** `read` — current input levels (physical GP bits). */
  async read(): Promise<number> {
    return protocol.parseRead(await this.transport.command("read"));
  }

  /** `write <values> <mask>` — set outputs (only masked bits change). */
  async write(values: number, mask: number): Promise<void> {
    await this.transport.command(protocol.writeCommand(values, mask));
  }

  /** `state` — input and output levels. */
  async state(): Promise<IoState> {
    return protocol.parseState(await this.transport.command("state"));
  }

  // --- pin map ---

  /** `map get` — the current pin map (validated). */
  async mapGet(): Promise<PinMap> {
    return protocol.parseMap(await this.transport.command("map get"));
  }

  /**
   * `map set` — validates the map first. Fails with Busy while a pattern is
   * running; on success the device returns the pattern engine to idle (loaded
   * steps are gone) and disarms the timestamp recorder.
   */
  async mapSet(map: PinMap): Promise<void> {
    await this.transport.command(protocol.mapSetCommand(map));
  }

  /** `map save` — persist the current map to flash. */
  async mapSave(): Promise<void> {
    await this.transport.command("map save");
  }

  /** `map default` — reset to the default map (Busy while a pattern runs). */
  async mapDefault(): Promise<void> {
    await this.transport.command("map default");
  }

  // --- pattern ---

  /**
   * One `pattern add` line (atomic on the device); returns the new total.
   * The steps must fit one 256-byte line — use `patternLoad` for more.
   */
  async patternAdd(steps: readonly PatternStep[]): Promise<number> {
    const lines = protocol.patternAddCommands(steps);
    if (lines.length > 1) {
      throw SdkError.invalidArgument(
        `${steps.length} steps do not fit one ${protocol.MAX_LINE_BYTES}-byte pattern add line; use patternLoad`,
      );
    }
    return protocol.parsePatternTotal(await this.transport.command(lines[0]));
  }

  /**
   * `pattern reset`, then `pattern add` in as many chunks as needed (each at
   * most 256 bytes). Every step is validated before anything is sent. Returns
   * the final total.
   */
  async patternLoad(steps: readonly PatternStep[]): Promise<number> {
    const lines = protocol.patternAddCommands(steps);
    await this.patternReset();
    let total = 0;
    for (const line of lines) {
      total = protocol.parsePatternTotal(await this.transport.command(line));
    }
    return total;
  }

  /**
   * `pattern run` — `once` plays one pass (the repeat is ignored); `loop`
   * needs a repeat of 1-65535. Completion arrives as a `pattern-done` event.
   */
  async patternRun(mode: PatternMode, repeat = 1): Promise<void> {
    await this.transport.command(protocol.patternRunCommand(mode, repeat));
  }

  /** `pattern stop` — NotRunning when nothing runs; loaded steps stay. */
  async patternStop(): Promise<void> {
    await this.transport.command("pattern stop");
  }

  /** `pattern status`. */
  async patternStatus(): Promise<PatternStatus> {
    return protocol.parsePatternStatus(await this.transport.command("pattern status"));
  }

  /** `pattern reset` — abort any run, clear the buffer, return to idle. USB stays up. */
  async patternReset(): Promise<void> {
    await this.transport.command("pattern reset");
  }

  // --- reset ---

  /**
   * `reset` — reboot the device. The USB port re-enumerates, so this
   * connection must be closed and the device opened again.
   */
  async reset(): Promise<void> {
    await this.transport.command("reset");
  }

  /**
   * `bootsel` — reboot into BOOTSEL mass-storage mode for UF2 reflash. Like
   * `reset`, the connection must be closed afterwards.
   */
  async bootsel(): Promise<void> {
    await this.transport.command("bootsel");
  }

  // --- timestamp ---

  /** `ts arm <mask> <mode>` — a non-zero mask within the input pins. */
  async tsArm(mask: number, mode: EdgeMode): Promise<void> {
    await this.transport.command(protocol.tsArmCommand(mask, mode));
  }

  /**
   * `ts get <max>` — `maxEvents` is 1-85. Reads the counted response. Events
   * carry no nanosecond value: use `timestampNs(event, caps.tsResNs)` or the
   * reconcile API.
   */
  async tsGet(maxEvents: number): Promise<TimestampResult> {
    const [data, lines] = await this.transport.commandCounted(protocol.tsGetCommand(maxEvents));
    const { count, overflow } = protocol.parseTsGetHeader(data);
    if (lines.length !== count) {
      throw SdkError.parse(`ts get header says count=${count} but ${lines.length} lines followed`);
    }
    return { events: lines.map((line) => protocol.parseTsEventLine(line)), overflow };
  }

  /** `ts status`. */
  async tsStatus(): Promise<TsStatus> {
    return protocol.parseTsStatus(await this.transport.command("ts status"));
  }

  /** `ts disarm` — disarm capture and discard buffered events. */
  async tsDisarm(): Promise<void> {
    await this.transport.command("ts disarm");
  }

  // --- events ---

  /**
   * Receive every push event. The first subscriber of the connection turns the
   * device subscription on; the returned function removes this subscriber and,
   * for the last one, turns it off. Rejects (and counts nothing) if the device
   * refuses `subscribe on`.
   */
  async subscribeEvents(listener: (event: PushEvent) => void): Promise<Unsubscribe> {
    // Registered before `subscribe on` is acknowledged: the device may push an
    // event right behind the OK.
    this.subscribers.add(listener);
    try {
      await this.acquire();
    } catch (err) {
      this.subscribers.delete(listener);
      throw err;
    }
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      this.subscribers.delete(listener);
      await this.release();
    };
  }

  /**
   * Listen to an event. Adding the first "input-change" listener turns the
   * device subscription on, removing the last one turns it off; a failure of
   * that background command is emitted as "error". Use `subscriptionSettled()`
   * to wait for it.
   */
  on<K extends keyof ConnectionEvents>(
    event: K,
    listener: (...args: ConnectionEvents[K]) => void,
  ): this {
    this.emitter.on(event, listener);
    if (event === "input-change") {
      // A listener whose `subscribe on` failed is dropped again, so its later
      // removal does not release a subscription it never held.
      this.runSubscriptionChange(
        () => this.acquire(),
        () => this.emitter.off(event, listener),
      );
    }
    return this;
  }

  /** Remove a listener added with `on` (see there for "input-change"). */
  off<K extends keyof ConnectionEvents>(
    event: K,
    listener: (...args: ConnectionEvents[K]) => void,
  ): this {
    const before = this.emitter.listenerCount(event);
    this.emitter.off(event, listener);
    if (event === "input-change" && this.emitter.listenerCount(event) < before) {
      this.runSubscriptionChange(() => this.release());
    }
    return this;
  }

  /** Resolves when every pending `subscribe on` / `subscribe off` has finished. */
  async subscriptionSettled(): Promise<void> {
    await this.subscriptionQueue;
  }

  // --- sync ---

  /** `sync arm` — prepare as slave. */
  async syncArm(): Promise<void> {
    await this.transport.command("sync arm");
  }

  /** `sync master` — prepare as master. */
  async syncMaster(): Promise<void> {
    await this.transport.command("sync master");
  }

  /** `sync start` — start the sync pulse and clock (master only). */
  async syncStart(): Promise<void> {
    await this.transport.command("sync start");
  }

  /** `sync stop` — stop the clock (master only). */
  async syncStop(): Promise<void> {
    await this.transport.command("sync stop");
  }

  /** `sync count` — a single `OK clocks=<n>` line, never a counted response. */
  async syncCount(): Promise<number> {
    return protocol.parseSyncCount(await this.transport.command("sync count"));
  }

  /** `sync disarm` — release the sync state (OK in any state). */
  async syncDisarm(): Promise<void> {
    await this.transport.command("sync disarm");
  }

  // --- safety functions ---

  /**
   * `wdog <ms>` — enable (100-10000) or disable (0) the watchdog. CDC only.
   * The watchdog is off after every restart; whoever enables it must keep a
   * heartbeat going (`startHeartbeat`).
   */
  async wdog(ms: number): Promise<void> {
    await this.transport.command(protocol.wdogCommand(ms));
  }

  /**
   * `safety` — the safety state (watchdog, failsafe latch, `usbsafe`, number
   * of exclusive groups). The source of truth for `! FAILSAFE`.
   */
  async safety(): Promise<SafetyState> {
    return protocol.parseSafety(await this.transport.command("safety"));
  }

  /**
   * `failsafe clear` — release the failsafe latch (CDC only). The outputs stay
   * where they are and the watchdog timer restarts.
   */
  async failsafeClear(): Promise<void> {
    await this.transport.command("failsafe clear");
  }

  /**
   * `outputs reset` — put every output at its `def` (the safe state) and stop
   * a running pattern. Always succeeds on the device, also with the latch set.
   */
  async outputsReset(): Promise<void> {
    await this.transport.command("outputs reset");
  }

  /**
   * `excl set <mask>...` — replace all exclusive groups atomically (1-16 masks
   * of at least 2 output pins; CDC only). A violated state is `Exclusive`; a
   * mask with a non-output pin is `BadParam` (the device knows the map).
   */
  async exclSet(masks: readonly number[]): Promise<void> {
    await this.transport.command(protocol.exclSetCommand(masks));
  }

  /** `excl clear` — remove all exclusive groups (CDC only). */
  async exclClear(): Promise<void> {
    await this.transport.command("excl clear");
  }

  /** `excl get` — the masks of the exclusive groups in the order they were set (counted response). */
  async exclGet(): Promise<number[]> {
    const [header, lines] = await this.transport.commandCounted("excl get");
    return protocol.parseExclGet(header, lines);
  }

  /** `usbsafe on|off` — failsafe when the USB link is lost (CDC only). */
  async usbsafe(on: boolean): Promise<void> {
    await this.transport.command(protocol.usbsafeCommand(on));
  }

  /** `rstinfo` — cause and time of the last restart. */
  async rstinfo(): Promise<ResetInfo> {
    return protocol.parseRstinfo(await this.transport.command("rstinfo"));
  }

  /** `pads` — the recorded outputs and the level read back from the pads. */
  async pads(): Promise<Pads> {
    return protocol.parsePads(await this.transport.command("pads"));
  }

  /**
   * Make the device equal to a `safety.toml` (config-files.md section 7, DD-16)
   * and check the result.
   *
   * The commands go out in this order and nothing else: `excl set <masks>` when
   * the configuration has groups, `excl clear` only when it has none,
   * `usbsafe on|off`, `wdog <ms>` (last, so the watchdog cannot trip while the
   * rest is being sent). `excl clear` is never sent before `excl set`: `excl
   * set` replaces atomically, and a failed `excl set` after a clear would leave
   * the device with less protection than before.
   *
   * A value the device would refuse is `InvalidArgument` and nothing is sent.
   * The first error answered by the device stops the apply: later commands are
   * not sent, no read-back is attempted, and the error keeps its code
   * (`BadParam`, `Busy`, ...). Accepted commands stay in effect (no rollback);
   * call `safety()` and `exclGet()` to see what is set. Applying needs the pins
   * of the groups to be outputs already: apply `map.toml` first.
   *
   * After the last command, `safety` and `excl get` are read back and must equal
   * the configuration (`wdog_ms`, `usbsafe`, number and masks of the groups); a
   * difference is `SafetyMismatch`. Returns the `safety` state that was read,
   * which also shows a failsafe latch that was set before (the latch is not part
   * of the file).
   *
   * With a watchdog configured, start the heartbeat afterwards.
   */
  async applySafety(config: SafetyConfig): Promise<SafetyState> {
    for (const command of protocol.safetyConfigCommands(config)) {
      await this.transport.command(command);
    }
    const state = await this.safety();
    const groups = await this.exclGet();
    const diffs: string[] = [];
    if (state.wdogMs !== config.watchdogMs) {
      diffs.push(`wdog_ms is ${state.wdogMs}, expected ${config.watchdogMs}`);
    }
    if (state.usbsafe !== config.usbsafe) {
      diffs.push(`usbsafe is ${state.usbsafe ? 1 : 0}, expected ${config.usbsafe ? 1 : 0}`);
    }
    if (state.excl !== config.groups.length) {
      diffs.push(`excl is ${state.excl}, expected ${config.groups.length}`);
    }
    if (groups.length !== config.groups.length) {
      diffs.push(`excl get returned ${groups.length} groups, expected ${config.groups.length}`);
    }
    groups.forEach((got, i) => {
      const want = config.groups[i];
      if (want !== undefined && got !== want) {
        diffs.push(`group ${i} is ${hex32(got)}, expected ${hex32(want)}`);
      }
    });
    if (diffs.length > 0) throw SdkError.safetyMismatch(diffs.join("; "));
    return state;
  }

  /**
   * Start the watchdog heartbeat: `ping` every `timeoutMs / 4` (at most 1 s) so
   * the device keeps seeing `OK` answers. `timeoutMs` is the value given to
   * `wdog()` (100-10000). See `Heartbeat` for the rules (serialised with every
   * other command, one failure is reported and not retried, closing the
   * connection or the heartbeat changes no output).
   */
  startHeartbeat(timeoutMs: number): Heartbeat {
    const heartbeat = new Heartbeat(timeoutMs, (value) => this.ping(value));
    this.heartbeats.add(heartbeat);
    heartbeat.once("end", () => this.heartbeats.delete(heartbeat));
    return heartbeat;
  }

  // --- escape hatch ---

  /**
   * Send arbitrary protocol text and return **every** line of the response
   * (the header and, for a counted response, all continuation lines; an `ERR`
   * is returned as a line). A line over 256 bytes is rejected locally, and so
   * is `subscribe`: the SDK owns the subscription.
   */
  async raw(command: string): Promise<string[]> {
    if (/[\r\n]/.test(command)) {
      throw SdkError.invalidArgument("a command must be a single line");
    }
    if (Buffer.byteLength(command, "utf8") > protocol.MAX_LINE_BYTES) {
      throw SdkError.invalidArgument(`command line exceeds ${protocol.MAX_LINE_BYTES} bytes`);
    }
    if (command.trim().split(/\s+/)[0].toLowerCase() === "subscribe") {
      throw SdkError.invalidArgument("subscribe is owned by the SDK; use subscribeEvents()");
    }
    return this.transport.raw(command);
  }

  /**
   * Close the connection. Heartbeats started on it end silently first; closing
   * sends no command and changes no output.
   */
  async close(): Promise<void> {
    // `stop()` ends each heartbeat at once; the transport then closes under any
    // ping still in flight, whose failure is no longer reported.
    const stopped = [...this.heartbeats].map((heartbeat) => heartbeat.stop());
    await this.transport.close();
    await Promise.all(stopped);
  }

  // --- subscription refcount ---

  /** Count one more subscriber; the 0 -> 1 transition sends `subscribe on`. */
  private acquire(): Promise<void> {
    return this.serialiseSubscription(async () => {
      if (this.subscriberCount === 0) await this.transport.command("subscribe on");
      this.subscriberCount++;
    });
  }

  /** Drop one subscriber; the 1 -> 0 transition sends `subscribe off`. */
  private release(): Promise<void> {
    return this.serialiseSubscription(async () => {
      this.subscriberCount--;
      if (this.subscriberCount === 0) await this.transport.command("subscribe off");
    });
  }

  private serialiseSubscription(fn: () => Promise<void>): Promise<void> {
    const run = this.subscriptionQueue.then(fn);
    // The queue only orders the commands; the caller gets the error through `run`.
    this.subscriptionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Run a subscription change started by a synchronous `on` / `off`; failures become "error" events. */
  private runSubscriptionChange(change: () => Promise<void>, undo?: () => void): void {
    change().catch((err: unknown) => {
      undo?.();
      this.emitter.emit(
        "error",
        err instanceof SdkError ? err : SdkError.disconnected(String(err)),
      );
    });
  }

  private dispatch(event: PushEvent): void {
    switch (event.type) {
      case "input_change":
        this.emitter.emit("input-change", { inputs: event.inputs, timestampUs: event.timestampUs });
        break;
      case "pattern_done":
        this.emitter.emit("pattern-done", { loops: event.loops });
        break;
      case "pattern_timeout":
        this.emitter.emit("pattern-timeout", { loops: event.loops });
        break;
      case "failsafe":
        this.emitter.emit("failsafe", { cause: event.cause });
        break;
    }
    for (const subscriber of [...this.subscribers]) subscriber(event);
  }
}
