/**
 * Replays the golden safety exchanges (`protocol/golden/*.txt`) through the
 * typed `Connection` methods (mirrors `sdk/rust/src/golden_api.rs`, restricted
 * to the safety commands).
 *
 * For every `>` request a safety method can express, the method is called
 * against a fake device that answers with the transcript's recorded response,
 * and the test checks that
 *
 * - the method put the same command on the wire (modulo spelling: case and
 *   number base), and
 * - the typed result agrees with the response (`OK` resolves, `ERR NAME`
 *   rejects with a typed SdkError).
 *
 * A request the SDK refuses locally (`InvalidArgument`, nothing sent) is
 * accepted only where the transcript records an `ERR` answer. Requests no
 * typed method can express (malformed text, other commands) are skipped; the
 * test fails if a safety method is never exercised.
 */
import { describe, expect, it } from "vitest";
import { Connection } from "../src/connection.js";
import { ErrorCode, SdkError } from "../src/errors.js";
import { FakePort } from "./helpers/fake-port.js";
import { GOLDEN_FILES, goldenCase, goldenResponse, loadGolden } from "./helpers/golden.js";

interface Exchange {
  at: string;
  request: string;
  response: string[];
}

function exchanges(): Exchange[] {
  const out: Exchange[] = [];
  for (const file of GOLDEN_FILES) {
    for (const c of loadGolden(file)) {
      if (c.hasSendHex) continue;
      for (const item of c.items) {
        if (item.kind !== "request" || item.response.length === 0) continue;
        out.push({ at: `${file}.txt:${item.line}`, request: item.text, response: item.response });
      }
    }
  }
  return out;
}

/** A number as the transcripts spell it (decimal or `0x` hex), or `undefined`. */
function num(token: string): number | undefined {
  if (/^0[xX][0-9a-fA-F]+$/.test(token) || /^\d+$/.test(token)) return Number(token);
  return undefined;
}

/** Spelling-independent form of a command line: lower case, numbers in decimal. */
function canon(line: string): string {
  return line
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")
    .map((w) => num(w)?.toString() ?? w)
    .join(" ");
}

type Call = [method: string, run: () => Promise<unknown>];

/** The safety method that expresses `request`, or `undefined`. */
function dispatch(conn: Connection, request: string): Call | undefined {
  const words = request.trim().toLowerCase().split(/\s+/);
  const nums = (tokens: string[]): number[] | undefined => {
    const values = tokens.map(num);
    return values.every((v) => v !== undefined) ? (values as number[]) : undefined;
  };
  const [a, b, ...rest] = words;
  if (a === "wdog" && b !== undefined && rest.length === 0) {
    const ms = num(b);
    return ms === undefined ? undefined : ["wdog", () => conn.wdog(ms)];
  }
  if (a === "safety" && b === undefined) return ["safety", () => conn.safety()];
  if (a === "failsafe" && b === "clear" && rest.length === 0) return ["failsafeClear", () => conn.failsafeClear()];
  if (a === "outputs" && b === "reset" && rest.length === 0) return ["outputsReset", () => conn.outputsReset()];
  if (a === "excl" && b === "set") {
    const masks = nums(rest);
    return masks === undefined ? undefined : ["exclSet", () => conn.exclSet(masks)];
  }
  if (a === "excl" && b === "clear" && rest.length === 0) return ["exclClear", () => conn.exclClear()];
  if (a === "excl" && b === "get" && rest.length === 0) return ["exclGet", () => conn.exclGet()];
  if (a === "usbsafe" && (b === "on" || b === "off") && rest.length === 0) {
    return ["usbsafe", () => conn.usbsafe(b === "on")];
  }
  if (a === "rstinfo" && b === undefined) return ["rstinfo", () => conn.rstinfo()];
  if (a === "pads" && b === undefined) return ["pads", () => conn.pads()];
  return undefined;
}

const HANDSHAKE = goldenResponse(goldenCase("version-info", "version"), "version");

async function rig(response: string[]): Promise<{ conn: Connection; port: FakePort }> {
  const port = new FakePort();
  port.onCommand = (cmd) => port.feed(...(cmd === "version" ? HANDSHAKE : response));
  const conn = await Connection.fromPort(port);
  conn.setTimeout(500);
  return { conn, port };
}

describe("golden safety exchanges through the typed Connection methods", () => {
  it("every expressible request agrees with its recorded response", async () => {
    const exercised = new Set<string>();
    for (const ex of exchanges()) {
      const { conn, port } = await rig(ex.response);
      const call = dispatch(conn, ex.request);
      if (call === undefined) {
        await conn.close();
        continue;
      }
      const [method, run] = call;
      const header = ex.response[0];
      const ctx = `${ex.at} \`${ex.request}\` -> ${header}`;
      const outcome = await run().then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      const sent = port.written.slice(1); // after the `version` handshake
      if (!outcome.ok && outcome.err instanceof SdkError && outcome.err.code === ErrorCode.InvalidArgument) {
        // Refused locally: nothing was sent, and the device refused it as well.
        expect(sent, ctx).toEqual([]);
        expect(header.startsWith("ERR "), ctx).toBe(true);
        exercised.add(`${method} (refused)`);
        await conn.close();
        continue;
      }
      expect(sent.map(canon), ctx).toEqual([canon(ex.request)]);
      if (header.startsWith("OK")) {
        expect(outcome.ok, `${ctx}: ${outcome.ok ? "" : String(outcome.err)}`).toBe(true);
      } else {
        expect(outcome.ok, ctx).toBe(false);
        const err = (outcome as { err: unknown }).err;
        expect(err, ctx).toBeInstanceOf(SdkError);
        expect([ErrorCode.UnknownDevice, ErrorCode.Parse], ctx).not.toContain((err as SdkError).code);
      }
      exercised.add(method);
      await conn.close();
    }
    for (const method of [
      "wdog",
      "safety",
      "failsafeClear",
      "outputsReset",
      "exclSet",
      "exclClear",
      "exclGet",
      "usbsafe",
      "rstinfo",
      "pads",
    ]) {
      expect(exercised, `golden never exercised ${method}`).toContain(method);
    }
    // Both the accepting and the refusing paths of the validated commands are covered.
    expect(exercised).toContain("wdog (refused)");
  });
});
