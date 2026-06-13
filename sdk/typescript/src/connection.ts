/**
 * High-level typed connection to one Pochi-DIO device.
 * Mirrors `sdk/rust/src/connection.rs`; push events are delivered via
 * EventEmitter events ("input-change" / "pattern-done" / "sync-done" /
 * "unknown-event"), emitted automatically as push lines arrive.
 */

import { EventEmitter } from "node:events";
import {
  discover,
  findByDeviceNumber,
  findByUid,
  selectSoleDevice,
} from "./discovery.js";
import * as protocol from "./protocol.js";
import { Transport, type PortLike } from "./transport.js";
import type {
  Capabilities,
  DeviceInfo,
  EdgeMode,
  IoState,
  PatternMode,
  PatternStatus,
  PatternStep,
  PinMap,
  PushEvent,
  TimestampResult,
  VersionInfo,
} from "./types.js";

export interface ConnectionEvents {
  "input-change": [{ inputs: number; timestampUs: number }];
  "pattern-done": [{ loops: number }];
  "sync-done": [{ status: string; devnum: number; timestamp: number }];
  "unknown-event": [{ raw: string }];
}

export class Connection extends EventEmitter<ConnectionEvents> {
  private readonly transport: Transport;
  private readonly portPath: string;

  private constructor(transport: Transport, portPath: string) {
    super();
    this.transport = transport;
    this.portPath = portPath;
    this.transport.on("push-event", (event: PushEvent) => {
      switch (event.type) {
        case "input_change":
          this.emit("input-change", {
            inputs: event.inputs,
            timestampUs: event.timestampUs,
          });
          break;
        case "pattern_done":
          this.emit("pattern-done", { loops: event.loops });
          break;
        case "sync_done":
          this.emit("sync-done", {
            status: event.status,
            devnum: event.devnum,
            timestamp: event.timestamp,
          });
          break;
        case "unknown":
          this.emit("unknown-event", { raw: event.raw });
          break;
      }
    });
  }

  /** Open a connection to the device at the given serial port path. */
  static async open(port: string): Promise<Connection> {
    return new Connection(await Transport.open(port), port);
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

  /** Wrap an already-open port (mock tests, custom transports). */
  static fromPort(port: PortLike): Connection {
    return new Connection(new Transport(port), "");
  }

  /** Set the command response timeout in milliseconds (default 2000). */
  setTimeout(timeoutMs: number): void {
    this.transport.timeoutMs = timeoutMs;
  }

  // --- device information ---

  /** `version` — firmware and protocol version. */
  async version(): Promise<VersionInfo> {
    return protocol.parseVersion(await this.transport.command("version"));
  }

  /**
   * `caps` — device capabilities (protocol version filled in from
   * `version`). Fails with UnsupportedFirmware on pre-Phase 9.6 FW.
   */
  async caps(): Promise<Capabilities> {
    const caps = protocol.parseCaps(await this.transport.command("caps"));
    caps.protocolVersion = (await this.version()).protocolVersion;
    return caps;
  }

  /** `info` — device identification (UID, device number). */
  async info(): Promise<DeviceInfo> {
    const { uid, deviceNumber } = protocol.parseInfo(
      await this.transport.command("info"),
    );
    return { uid, deviceNumber, port: this.portPath, version: null };
  }

  /** `devnum <n>` — set the device number (0-254; 255 unassigns). */
  async setDeviceNumber(n: number): Promise<void> {
    await this.transport.command(`devnum ${n}`);
  }

  // --- digital I/O ---

  /** `read` — current input values. */
  async read(): Promise<number> {
    return protocol.parseRead(await this.transport.command("read"));
  }

  /** `write <values> <mask>` — set outputs (only masked bits change). */
  async write(values: number, mask: number): Promise<void> {
    await this.transport.command(
      `write 0x${(values >>> 0).toString(16)} 0x${(mask >>> 0).toString(16)}`,
    );
  }

  /** `state` — complete I/O state. */
  async state(): Promise<IoState> {
    return protocol.parseState(await this.transport.command("state"));
  }

  // --- pin map ---

  /** `map get` — current pin map. */
  async mapGet(): Promise<PinMap> {
    return protocol.parseMap(await this.transport.command("map get"));
  }

  /** `map set` from a typed PinMap (extended fields zero). */
  async mapSet(map: PinMap): Promise<void> {
    await this.mapSetHex(protocol.mapToHex(map));
  }

  /** `map set <hex>` — raw 48-char hex map. */
  async mapSetHex(hex: string): Promise<void> {
    await this.transport.command(`map set ${hex}`);
  }

  /** `map save` — persist the current map to flash. */
  async mapSave(): Promise<void> {
    await this.transport.command("map save");
  }

  /** `map default` — reset to the default map (all inputs, pull-down). */
  async mapDefault(): Promise<void> {
    await this.transport.command("map default");
  }

  // --- pattern ---

  /** `pattern load` from typed steps. Returns the accepted step count. */
  async patternLoad(steps: PatternStep[]): Promise<number> {
    return this.patternLoadHex(protocol.patternToHex(steps));
  }

  /** `pattern load <hex>` — raw count-prefixed step data. */
  async patternLoadHex(hex: string): Promise<number> {
    return protocol.parseAccepted(
      await this.transport.command(`pattern load ${hex}`),
    );
  }

  /**
   * `pattern run <mode> <repeat>` — start playback. Note: `loop` with
   * repeat=0 is rejected by the firmware (no infinite mode).
   */
  async patternRun(mode: PatternMode, repeat: number): Promise<void> {
    await this.transport.command(protocol.patternRunCommand(mode, repeat));
  }

  /** `pattern stop` — stop playback immediately. */
  async patternStop(): Promise<void> {
    await this.transport.command("pattern stop");
  }

  /** `pattern status` — current playback status. */
  async patternStatus(): Promise<PatternStatus> {
    return protocol.parsePatternStatus(
      await this.transport.command("pattern status"),
    );
  }

  /**
   * `pattern reset` — pattern engine soft reset (FW v0.1.3+, `FEAT_RESET`).
   * Stops the state machine, clears the loaded pattern buffer, and returns
   * the engine to `Idle`. USB stays up; the connection remains usable.
   */
  async patternReset(): Promise<void> {
    await this.transport.command("pattern reset");
  }

  // --- reset ---

  /**
   * `reset` — full chip soft reset (FW v0.1.3+, `FEAT_RESET`).
   *
   * The device responds `OK`, drains its CDC TX ring for ~50 ms, then calls
   * `SCB::sys_reset()`. The USB port re-enumerates, so the caller must
   * close this connection and rediscover the device afterwards.
   */
  async systemReset(): Promise<void> {
    await this.transport.command("reset");
  }

  /**
   * `bootsel` — reboot into BOOTSEL mass-storage mode for UF2 reflash
   * (FW v0.1.3+, `FEAT_RESET`).
   *
   * Like `systemReset`, the device re-enumerates afterwards (as a USB
   * mass-storage device). Callers must close this connection.
   */
  async bootselReset(): Promise<void> {
    await this.transport.command("bootsel");
  }

  // --- timestamp ---

  /** `ts arm <mask> <mode>` — arm timestamp capture. */
  async tsArm(mask: number, mode: EdgeMode): Promise<void> {
    await this.transport.command(protocol.tsArmCommand(mask, mode));
  }

  /**
   * `ts get <max>` — retrieve captured events (counted multi-line read).
   * `timestampNs` is the host-computed as-is value; apply the reconcile
   * module for straddle correction across events.
   *
   * The returned `overflow` is `true` if the FW reported a ring overflow
   * since the last `ts get` (FW v0.1.2+). `maxEvents` is clamped FW-side:
   * as of FW v0.1.2 a single response carries at most 85 events, so
   * draining a full 256-event ring may need multiple calls.
   */
  async tsGet(maxEvents: number): Promise<TimestampResult> {
    const [data, lines] = await this.transport.commandCounted(
      `ts get ${maxEvents}`,
    );
    const { overflow } = protocol.parseCountOverflowField(data);
    return {
      events: lines.map((line) => protocol.parseTsEventLine(line)),
      reconciled: false,
      overflow,
    };
  }

  /** `ts disarm` — disarm capture and discard buffered events. */
  async tsDisarm(): Promise<void> {
    await this.transport.command("ts disarm");
  }

  // --- events ---

  /** `subscribe on|off` — toggle input change push notifications. */
  async subscribe(enable: boolean): Promise<void> {
    await this.transport.command(`subscribe ${enable ? "on" : "off"}`);
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

  /** `sync start` — start sync pulse + 1 MHz clock (master only). */
  async syncStart(): Promise<void> {
    await this.transport.command("sync start");
  }

  /** `sync stop` — stop clock output (master only). */
  async syncStop(): Promise<void> {
    await this.transport.command("sync stop");
  }

  /**
   * `sync count` — current sync clock count. Single-line response
   * (`OK count=N`, no data lines) — plain read path, never counted.
   */
  async syncCount(): Promise<number> {
    return protocol.parseSyncCount(await this.transport.command("sync count"));
  }

  /** `sync disarm` — release sync state (safe in any state). */
  async syncDisarm(): Promise<void> {
    await this.transport.command("sync disarm");
  }

  // --- escape hatch ---

  /** Send an arbitrary command, returning the raw response line. */
  async raw(command: string): Promise<string> {
    return this.transport.raw(command);
  }

  /** Close the connection. */
  async close(): Promise<void> {
    await this.transport.close();
  }
}
