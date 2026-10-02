/**
 * Conformance against the v2 golden transcripts (`protocol/golden/*.txt`),
 * the single source of truth for the wire format shared with the firmware,
 * the simulator and every other SDK (docs/sdk-api-design.md section 8).
 *
 * 1. Transport replay: every transcript case is played by a fake device
 *    generated from the file; the transport must send exactly the recorded
 *    requests, read exactly the recorded responses (counted ones included) and
 *    deliver exactly the recorded events.
 * 2. Parser replay: every response line goes through the typed parsers, and
 *    typed values re-encode to the recorded text.
 */
import { describe, expect, it } from "vitest";
import * as protocol from "../src/protocol.js";
import { Transport } from "../src/transport.js";
import {
  patternStepToText,
  pinMapToSetArgs,
  type PatternStep,
  type PushEvent,
} from "../src/types.js";
import { GOLDEN_FILES, GoldenPort, loadGolden } from "./helpers/golden.js";

describe("golden transcripts: transport replay", () => {
  for (const file of GOLDEN_FILES) {
    describe(`${file}.txt`, () => {
      const cases = loadGolden(file).filter((c) => !c.hasSendHex);

      it("has cases to replay", () => {
        expect(cases.length).toBeGreaterThan(0);
      });

      it.each(cases.map((c) => [`line ${c.line}: ${c.title}`, c] as const))("%s", async (_name, c) => {
        const port = new GoldenPort(c.items);
        const transport = new Transport(port);
        transport.timeoutMs = 2000;
        const events: PushEvent[] = [];
        transport.on("push-event", (ev) => events.push(ev));
        port.start();

        for (const item of c.items) {
          if (item.kind !== "request") continue;
          expect(await transport.raw(item.text), `golden line ${item.line}`).toEqual(item.response);
        }

        const expected: PushEvent[] = [];
        for (const item of c.items) {
          if (item.kind !== "event") continue;
          const ev = protocol.parsePushEvent(item.wire.slice(2));
          if (ev.type === "unknown") throw new Error(`unknown event in transcript: ${item.wire}`);
          expected.push(ev);
        }
        expect(events).toEqual(expected);
        expect(port.remainingRequests()).toBe(0);
      });
    });
  }
});

/** Normalised request form: lower-cased command words, arguments dropped. */
function formOf(request: string): string {
  const words = request.split(/\s+/).filter((w) => w !== "").map((w) => w.toLowerCase());
  const [first, second] = words;
  if (["map", "pattern", "ts", "sync", "subscribe"].includes(first ?? "")) {
    return second === undefined ? first : `${first} ${second}`;
  }
  return first ?? "";
}

const BARE_OK_FORMS = new Set([
  "devnum",
  "map set",
  "map save",
  "map default",
  "write",
  "pattern run",
  "pattern stop",
  "pattern reset",
  "ts arm",
  "ts disarm",
  "subscribe on",
  "subscribe off",
  "sync arm",
  "sync master",
  "sync start",
  "sync stop",
  "sync disarm",
  "reset",
  "bootsel",
]);

/** Parse one OK response of the given form; `lines` are the continuation wire lines. */
function checkOk(form: string, data: string, lines: string[]): void {
  switch (form) {
    case "version":
      expect(protocol.parseVersion(data).protocolVersion).toBe(2);
      return;
    case "caps": {
      const c = protocol.parseCaps(data);
      expect(c).toMatchObject({ dio: 25, tsResNs: 40, tickNs: 200, patternMax: 256, ring: 256 });
      expect(c.features).toBe(3);
      expect(c.out + c.in).toBe(c.dio);
      return;
    }
    case "info":
      expect(protocol.parseInfo(data).uid).toBe("0000000000000000");
      return;
    case "ping":
      protocol.parsePong(data);
      return;
    case "read":
      protocol.parseRead(data);
      return;
    case "state":
      protocol.parseState(data);
      return;
    case "map get":
      // R-M3: the payload pastes back into `map set` unchanged.
      expect(pinMapToSetArgs(protocol.parseMap(data))).toBe(data.replace(/^v=2 /, ""));
      return;
    case "pattern add":
      protocol.parsePatternTotal(data);
      return;
    case "pattern status": {
      const s = protocol.parsePatternStatus(data);
      expect(s.total).toBeLessThanOrEqual(256);
      if (s.state === "idle") expect(s.total).toBe(0);
      return;
    }
    case "ts get": {
      const { count } = protocol.parseTsGetHeader(data);
      expect(lines).toHaveLength(count);
      for (const line of lines) {
        expect(protocol.parseTsEventLine(line).rawPhase).toBeLessThanOrEqual(24);
      }
      return;
    }
    case "ts status":
      protocol.parseTsStatus(data);
      return;
    case "sync count":
      protocol.parseSyncCount(data);
      return;
    case "help":
      expect(lines).toHaveLength(protocol.parseCountField(data) ?? -1);
      return;
    default:
      if (BARE_OK_FORMS.has(form)) {
        expect(data, `bare OK expected for \`${form}\``).toBe("");
        return;
      }
      throw new Error(`golden response for unhandled request form \`${form}\`: OK ${data}`);
  }
}

/** Hex number in the SDK's own spelling: no leading zeros. */
const MIN_HEX = "0x(?:0|[1-9a-f][0-9a-f]*)";

const CANONICAL_MAP_SET = new RegExp(
  `^map set flags=0x[0-9a-f]{2}${["dir", "pu", "pd", "def", "opol", "ipol", "edge"]
    .map((k) => ` ${k}=0x[0-9a-f]{8}`)
    .join("")}$`,
);

/** Builders must reproduce the canonical requests the transcripts record as accepted. */
function checkBuilder(request: string): void {
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^write (${MIN_HEX}) (${MIN_HEX})$`).exec(request))) {
    expect(protocol.writeCommand(Number(m[1]), Number(m[2]))).toBe(request);
  } else if ((m = new RegExp(`^ts arm (${MIN_HEX}) (rising|falling|both)$`).exec(request))) {
    expect(protocol.tsArmCommand(Number(m[1]), m[2] as "rising" | "falling" | "both")).toBe(
      request,
    );
  } else if ((m = /^ts get (\d+)$/.exec(request))) {
    expect(protocol.tsGetCommand(Number(m[1]))).toBe(request);
  } else if (request === "pattern run once") {
    expect(protocol.patternRunCommand("once", 1)).toBe(request);
  } else if ((m = /^pattern run loop (\d+)$/.exec(request))) {
    expect(protocol.patternRunCommand("loop", Number(m[1]))).toBe(request);
  } else if (CANONICAL_MAP_SET.test(request)) {
    // Canonical form only: the device also accepts decimal / upper-case numbers
    // and an optional leading `v=2`.
    const args = request.slice("map set ".length);
    expect(pinMapToSetArgs(protocol.parseMap(`v=2 ${args}`))).toBe(args);
  } else if (request.startsWith("pattern add ")) {
    for (const token of request.slice("pattern add ".length).split(" ")) {
      if (!/^0x[0-9a-f]+:[1-9]\d*$/.test(token)) continue; // non-canonical step spelling
      const [bits, ticks] = token.split(":");
      const step: PatternStep = { outBits: Number(bits), holdTicks: Number(ticks) };
      expect(patternStepToText(step)).toBe(token);
    }
  }
}

describe("golden transcripts: parser replay", () => {
  it("every OK / ERR / event line parses and re-encodes", () => {
    const forms = new Set<string>();
    const events = new Set<string>();
    const errors = new Set<string>();
    let okLines = 0;

    for (const file of GOLDEN_FILES) {
      for (const c of loadGolden(file)) {
        for (const item of c.items) {
          const ctx = `${file}.txt:${item.line}`;
          if (item.kind === "event") {
            const ev = protocol.parsePushEvent(item.wire.slice(2));
            expect(ev.type, ctx).not.toBe("unknown");
            events.add(ev.type);
            continue;
          }
          if (item.kind === "directive") {
            // Responses to raw `~ send_hex` bytes: parse only, there is no request form.
            for (const line of item.response) {
              const resp = protocol.parseResponse(line);
              if (resp.kind === "err") errors.add(resp.code);
            }
            continue;
          }
          if (item.kind !== "request") continue;

          const [header, ...cont] = item.response;
          const resp = protocol.parseResponse(header);
          if (resp.kind === "err") {
            expect(() => protocol.okData(resp), ctx).toThrow();
            errors.add(resp.code);
            continue;
          }
          expect(resp.kind, ctx).toBe("ok");
          if (resp.kind !== "ok") continue;
          checkOk(formOf(item.text), resp.data, cont);
          checkBuilder(item.text);
          forms.add(formOf(item.text));
          okLines++;
        }
      }
    }

    expect(okLines).toBeGreaterThan(500);
    for (const form of ["version", "caps", "info", "ping", "read", "state", "map get", "map set",
      "pattern add", "pattern status", "ts get", "ts status", "sync count", "help"]) {
      expect(forms, `no golden example for \`${form}\``).toContain(form);
    }
    expect([...events].sort()).toEqual(["input_change", "pattern_done", "pattern_timeout"]);
    for (const name of ["BAD_PARAM", "BAD_MAP", "BUSY", "FLASH", "TOO_LONG", "NOT_ARMED",
      "SYNC_STATE", "NO_RESOURCE", "NOT_RUNNING", "UNKNOWN_CMD", "LINE_TOO_LONG"]) {
      expect(errors, `no golden example for ERR ${name}`).toContain(name);
    }
  });
});
