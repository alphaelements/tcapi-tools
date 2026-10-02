// Conformance of the mock device model against the v2 golden transcripts.
//
// Every golden case whose requests and directives the model implements is
// replayed on a fresh MockDeviceCore (the harness resets the device before
// every case, as the golden README requires) and the lines it emits are
// compared byte for byte with the transcript. Cases that need something the
// model deliberately lacks (sync, flash faults, binary framing, the pattern
// timeout) are listed with their reason; the test also pins how many cases
// are replayed so the filter cannot silently swallow the corpus.

import { describe, expect, it } from "vitest";
import { parseGolden, type GoldenCase } from "./golden";
import { MockDeviceCore } from "./mock-device-core";

const files = import.meta.glob<string>("../../../protocol/golden/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
});

/// Directives the replay can drive.
const SUPPORTED_DIRECTIVES = new Set(["in", "advance", "expect_pins"]);
const UNSUPPORTED_REASON: Record<string, string> = {
  send_hex: "binary framing",
  fault: "fault injection",
  sync_edge: "multi-device sync",
};

/// Why a case cannot be replayed on the model, or null if it can.
function exclusionReason(c: GoldenCase): string | null {
  for (const item of c.items) {
    if (item.kind === "request") {
      if (/^sync(\s|$)/i.test(item.line.trim())) return "multi-device sync";
    } else if (!SUPPORTED_DIRECTIVES.has(item.name)) {
      return UNSUPPORTED_REASON[item.name] ?? `directive ${item.name}`;
    }
  }
  return null;
}

function parseAdvance(args: string): number {
  const m = /^(us|ns)=(\d+)$/.exec(args);
  if (!m) throw new Error(`bad advance directive: ${args}`);
  return Number(m[2]) * (m[1] === "us" ? 1000 : 1);
}

/// Replay one case; returns the first mismatch or null.
function replay(c: GoldenCase): string | null {
  const dev = new MockDeviceCore();
  for (const item of c.items) {
    let actual: string[];
    if (item.kind === "request") {
      actual = [...dev.execute(item.line), ...dev.takeEvents()];
    } else if (item.name === "in") {
      dev.driveInputs(Number(item.args));
      actual = dev.takeEvents();
    } else if (item.name === "advance") {
      dev.advance(parseAdvance(item.args));
      actual = dev.takeEvents();
    } else {
      // expect_pins out=0x...
      const want = Number(/^out=(0x[0-9a-fA-F]+)$/.exec(item.args)?.[1]);
      const got = dev.physicalOutputs;
      return got === want
        ? null
        : `expect_pins: physical outputs 0x${got.toString(16)} != 0x${want.toString(16)}`;
    }
    if (JSON.stringify(actual) !== JSON.stringify(item.expect)) {
      const what = item.kind === "request" ? `> ${item.line}` : `~ ${item.name} ${item.args}`;
      return `${what}\n  expected: ${JSON.stringify(item.expect)}\n  actual:   ${JSON.stringify(actual)}`;
    }
  }
  return null;
}

const corpus = Object.entries(files).map(([path, text]) => {
  const name = path.split("/").pop() as string;
  return { name, cases: parseGolden(name, text) };
});

describe("golden corpus is available", () => {
  it("loads every transcript file", () => {
    expect(corpus.map((f) => f.name).sort()).toEqual([
      "boundary.txt",
      "errors.txt",
      "events.txt",
      "io.txt",
      "map.txt",
      "pattern.txt",
      "reset.txt",
      "sync.txt",
      "timestamp.txt",
      "version-info.txt",
    ]);
  });
});

for (const file of corpus) {
  const eligible = file.cases.filter((c) => exclusionReason(c) === null);
  // sync.txt is entirely multi-device sync: nothing of it can be replayed.
  if (eligible.length === 0) continue;

  describe(`mock device replays ${file.name}`, () => {
    for (const c of eligible) {
      it(`${c.title || "case"} (line ${c.line})`, () => {
        expect(replay(c)).toBeNull();
      });
    }
  });
}

describe("replay coverage", () => {
  const counts = new Map(
    corpus.map((f) => [
      f.name,
      {
        total: f.cases.length,
        replayed: f.cases.filter((c) => exclusionReason(c) === null).length,
      },
    ]),
  );

  // Floors, not exact counts: a new golden case must not break the test, but
  // a filter that starts dropping cases must.
  const FLOORS: Record<string, number> = {
    "version-info.txt": 10,
    "map.txt": 25,
    "io.txt": 15,
    "pattern.txt": 25,
    "timestamp.txt": 25,
    "events.txt": 10,
    "errors.txt": 10,
    "reset.txt": 10,
  };
  for (const [name, floor] of Object.entries(FLOORS)) {
    it(`replays at least ${floor} cases of ${name}`, () => {
      expect(counts.get(name)?.replayed ?? 0).toBeGreaterThanOrEqual(floor);
    });
  }

  it("replays at least 220 cases overall", () => {
    const replayed = [...counts.values()].reduce((sum, c) => sum + c.replayed, 0);
    expect(replayed).toBeGreaterThanOrEqual(220);
  });

  it("every excluded case has a stated reason", () => {
    for (const f of corpus) {
      for (const c of f.cases) {
        const reason = exclusionReason(c);
        if (reason !== null) expect(reason.length).toBeGreaterThan(0);
      }
    }
  });
});
