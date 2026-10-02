// ============================================================
// golden.ts — reader for the protocol golden transcripts
//
// `protocol/golden/*.txt` (see protocol/golden/README.md) is the reference
// record of the v2 text protocol. This parser turns a file into test cases
// of request / directive items with the lines each of them must produce.
// Used by the mock device conformance test.
// ============================================================

/// One step of a case. `expect` are the wire lines (without the `< ` prefix)
/// the device must emit right after this step, in order.
export type GoldenItem =
  | { kind: "request"; line: string; expect: string[] }
  | { kind: "directive"; name: string; args: string; expect: string[] };

export interface GoldenCase {
  file: string;
  /// 1-based line of the case's first item in the file.
  line: number;
  /// The `# ---` comment that introduces the case, if any.
  title: string;
  items: GoldenItem[];
}

/// Parse the text of one golden file. Blank lines end a case; comment-only
/// blocks (the header) are not cases.
export function parseGolden(file: string, text: string): GoldenCase[] {
  const cases: GoldenCase[] = [];
  let current: GoldenCase | null = null;
  let title = "";
  let last: GoldenItem | null = null;

  const lines = text.split("\n");
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (raw === "") {
      current = null;
      last = null;
      title = "";
      return;
    }
    if (raw.startsWith("# ---")) {
      title = raw.slice(2).replace(/^-+\s*/, "").replace(/\s*-+$/, "");
      return;
    }
    if (raw.startsWith("#")) return;

    const start = (item: GoldenItem) => {
      if (!current) {
        current = { file, line: lineNo, title, items: [] };
        cases.push(current);
      }
      current.items.push(item);
      last = item;
    };

    if (raw.startsWith("> ")) {
      start({ kind: "request", line: raw.slice(2), expect: [] });
    } else if (raw.startsWith("~ ")) {
      const body = raw.slice(2);
      const sp = body.indexOf(" ");
      const name = sp < 0 ? body : body.slice(0, sp);
      const args = sp < 0 ? "" : body.slice(sp + 1);
      // `~ in=0x..` has no separate name: the key is the directive.
      const eq = name.indexOf("=");
      if (eq >= 0) start({ kind: "directive", name: name.slice(0, eq), args: body.slice(eq + 1), expect: [] });
      else start({ kind: "directive", name, args, expect: [] });
    } else if (raw.startsWith("<")) {
      if (!last) throw new Error(`${file}:${lineNo}: response line without a request`);
      (last as GoldenItem).expect.push(raw.slice(2));
    } else {
      throw new Error(`${file}:${lineNo}: unrecognized golden line: ${raw}`);
    }
  });
  return cases;
}
