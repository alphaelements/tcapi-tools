import { describe, expect, it } from "vitest";
import { parseGolden } from "./golden";

const SAMPLE = [
  "# proto=2",
  "# generated_by=hand",
  "",
  "# --- first case ---",
  "> ts get 2",
  "< OK count=1 overflow=0",
  "<   in=0x00000001 c=5 p=0 s=0",
  "~ advance us=10",
  "~ in=0x00000001",
  "< ! INPUT in=0x00000001 t=10",
  "",
  "# R-T1",
  "> ping 1",
  "< OK pong=1",
].join("\n");

describe("parseGolden", () => {
  const cases = parseGolden("sample.txt", SAMPLE);

  it("splits cases at blank lines and ignores the header block", () => {
    expect(cases).toHaveLength(2);
    expect(cases[0].title).toBe("first case");
    expect(cases[0].line).toBe(5);
  });

  it("attaches response lines, including 3-space continuation lines, to the request", () => {
    const [req] = cases[0].items;
    expect(req).toEqual({
      kind: "request",
      line: "ts get 2",
      expect: ["OK count=1 overflow=0", "  in=0x00000001 c=5 p=0 s=0"],
    });
  });

  it("attaches events to the directive that caused them", () => {
    expect(cases[0].items[1]).toEqual({ kind: "directive", name: "advance", args: "us=10", expect: [] });
    expect(cases[0].items[2]).toEqual({
      kind: "directive",
      name: "in",
      args: "0x00000001",
      expect: ["! INPUT in=0x00000001 t=10"],
    });
  });

  it("rejects an orphan response line", () => {
    expect(() => parseGolden("bad.txt", "< OK")).toThrow(/without a request/);
  });

  it("rejects an unknown line prefix", () => {
    expect(() => parseGolden("bad.txt", "? what")).toThrow(/unrecognized/);
  });
});
