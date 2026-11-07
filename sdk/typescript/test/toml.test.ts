/**
 * The TOML reader behind `parseSafety` (the SDK has no TOML dependency). It
 * implements TOML 1.0 values and tables and records the line of every key and
 * header, which the config error rules need. Hand-written inputs: positive
 * cases for each construct, negative cases for malformed text.
 */
import { describe, expect, it } from "vitest";
import { TomlSyntaxError, parseToml, type TomlNode, type TomlTable } from "../src/toml.js";

/** Plain JS value of a node, for compact assertions. */
function plain(node: TomlNode): unknown {
  switch (node.type) {
    case "table":
      return Object.fromEntries([...node.entries].map(([k, v]) => [k, plain(v)]));
    case "array":
      return node.items.map(plain);
    case "integer":
      return node.value;
    case "string":
    case "boolean":
      return node.value;
    default:
      return `<${node.type}>`;
  }
}

function parse(src: string): unknown {
  return plain(parseToml(src));
}

function syntaxError(src: string): TomlSyntaxError {
  try {
    parseToml(src);
  } catch (err) {
    expect(err).toBeInstanceOf(TomlSyntaxError);
    return err as TomlSyntaxError;
  }
  throw new Error(`accepted: ${JSON.stringify(src)}`);
}

function entry(table: TomlTable, key: string): TomlNode {
  const node = table.entries.get(key);
  if (node === undefined) throw new Error(`no key ${key}`);
  return node;
}

describe("values", () => {
  it("integers in every base, with signs and underscores", () => {
    expect(parse("a = 0\nb = +5\nc = -17\nd = 1_000\ne = 0xDEAD_beef\nf = 0o17\ng = 0b101\n")).toEqual({
      a: 0n,
      b: 5n,
      c: -17n,
      d: 1000n,
      e: 0xdeadbeefn,
      f: 15n,
      g: 5n,
    });
  });

  it("the i64 range is exact, beyond it is a syntax error", () => {
    expect(parse("a = 9223372036854775807\nb = -9223372036854775808\n")).toEqual({
      a: 9223372036854775807n,
      b: -9223372036854775808n,
    });
    expect(syntaxError("a = 9223372036854775808\n").message).toMatch(/out of range/);
    expect(syntaxError("a = -9223372036854775809\n").line).toBe(1);
  });

  it("floats, booleans and dates are typed but opaque", () => {
    expect(
      parse(
        "a = 1.5\nb = -2e3\nc = inf\nd = -nan\ne = true\nf = false\ng = 1979-05-27\nh = 07:32:00\ni = 1979-05-27T07:32:00Z\nj = 1979-05-27 07:32:00.5+09:00\n",
      ),
    ).toEqual({
      a: "<float>",
      b: "<float>",
      c: "<float>",
      d: "<float>",
      e: true,
      f: false,
      g: "<datetime>",
      h: "<datetime>",
      i: "<datetime>",
      j: "<datetime>",
    });
  });

  it("strings: basic, literal and multi-line forms", () => {
    expect(
      parse(
        [
          'a = "tab\\there \\u00e9 \\U0001F600 \\"q\\" \\\\"',
          "b = 'C:\\path\\n'",
          'c = """\nfirst\nsecond \\\n   joined"""',
          "d = '''\nraw \\n\nline'''",
          'e = ""',
        ].join("\n"),
      ),
    ).toEqual({
      a: 'tab\there \u00e9 \u{1F600} "q" \\',
      b: "C:\\path\\n",
      c: "first\nsecond joined",
      d: "raw \\n\nline",
      e: "",
    });
  });

  it("arrays: nesting, mixed types, comments, newlines and a trailing comma", () => {
    expect(parse('a = [1, "x", [true, 2.5],]\nb = [\n  # comment\n  "p", # trailing\n  "q",\n]\nc = []\n')).toEqual({
      a: [1n, "x", [true, "<float>"]],
      b: ["p", "q"],
      c: [],
    });
  });

  it("inline tables", () => {
    expect(parse('a = { x = 1, y = { z = "s" }, "q.k" = true }\nb = {}\n')).toEqual({
      a: { x: 1n, y: { z: "s" }, "q.k": true },
      b: {},
    });
  });
});

describe("tables and keys", () => {
  it("sections, nested sections and dotted keys build one tree", () => {
    expect(parse("a.b = 1\n[c]\nd = 2\n[c.e]\nf = 3\n[g.h]\ni = 4\n")).toEqual({
      a: { b: 1n },
      c: { d: 2n, e: { f: 3n } },
      g: { h: { i: 4n } },
    });
  });

  it("arrays of tables, with sub-tables per element", () => {
    expect(parse("[[x]]\na = 1\n[x.sub]\nb = 2\n[[x]]\na = 3\n")).toEqual({
      x: [{ a: 1n, sub: { b: 2n } }, { a: 3n }],
    });
  });

  it("quoted keys and keys with dashes and digits", () => {
    expect(parse('"a b" = 1\n\'c.d\' = 2\ne-f_9 = 3\n"" = 4\n')).toEqual({
      "a b": 1n,
      "c.d": 2n,
      "e-f_9": 3n,
      "": 4n,
    });
  });

  it("a parent table may be defined after its child section", () => {
    expect(parse("[a.b]\nx = 1\n[a]\ny = 2\n")).toEqual({ a: { b: { x: 1n }, y: 2n } });
  });

  it("empty input, comments only, CRLF and a leading BOM", () => {
    expect(parse("")).toEqual({});
    expect(parse("# nothing\n  \n")).toEqual({});
    expect(parse("a = 1\r\n[b]\r\nc = 2\r\n")).toEqual({ a: 1n, b: { c: 2n } });
    expect(parse("\uFEFFa = 1\n")).toEqual({ a: 1n });
  });
});

describe("lines", () => {
  const root = parseToml(
    [
      "version = 2", // 1
      "", // 2
      "[watchdog]", // 3
      "timeout_ms = 5", // 4
      "[[exclusive]]", // 5
      "pins = [", // 6
      '  "GP1",', // 7
      "]", // 8
      "[[exclusive]]", // 9
      "x.y = 1", // 10
    ].join("\n"),
  );

  it("a key carries the line of the key, a header the line of the header", () => {
    expect(entry(root, "version").line).toBe(1);
    const watchdog = entry(root, "watchdog") as TomlTable;
    expect(watchdog.line).toBe(3);
    expect(entry(watchdog, "timeout_ms").line).toBe(4);
  });

  it("array-of-tables entries are on their header; their keys on their own line", () => {
    const list = entry(root, "exclusive");
    if (list.type !== "array") throw new Error("array expected");
    expect(list.items.map((i) => i.line)).toEqual([5, 9]);
    const first = list.items[0] as TomlTable;
    expect(entry(first, "pins").line).toBe(6);
    const second = list.items[1] as TomlTable;
    expect(entry(second, "x").line).toBe(10);
  });

  it("values nested in an array or inline table carry the line of their key", () => {
    const src = "k = [\n  1,\n  { a = 2 },\n]\nt = { u = { v = 3 } }\n";
    const doc = parseToml(src);
    const k = entry(doc, "k");
    if (k.type !== "array") throw new Error("array expected");
    expect(k.line).toBe(1);
    expect(k.items.map((i) => i.line)).toEqual([1, 1]);
    const t = entry(doc, "t") as TomlTable;
    expect(t.line).toBe(5);
    expect((entry(t, "u") as TomlTable).line).toBe(5);
  });

  it("a table created only by a path keeps the line that created it", () => {
    const doc = parseToml("\n\n[a.b]\nx = 1\n");
    expect(entry(doc, "a").line).toBe(3);
  });
});

describe("syntax errors (all reported with the line they are on)", () => {
  it.each([
    ["an unterminated header", "version = 2\n[watchdog\ntimeout_ms = 800\n", 2],
    ["a missing value", "a = \n", 1],
    ["no equals sign", "a 1\n", 1],
    ["a missing key", "= 1\n", 1],
    ["trailing garbage after a value", "a = 1 2\n", 1],
    ["a repeated key", "a = 1\nb = 2\na = 3\n", 3],
    ["a repeated key through a dotted key", "a.b = 1\na.b = 2\n", 2],
    ["a key that is also a table", "a = 1\n[a]\n", 2],
    ["a table defined twice", "[a]\nx = 1\n[a]\n", 3],
    ["a dotted-key table reopened by a header", "a.b = 1\n[a]\n", 2],
    ["an inline table extended by a header", "a = { x = 1 }\n[a.y]\n", 2],
    ["a static array extended by [[ ]]", "a = [{ x = 1 }]\n[[a]]\n", 2],
    ["an array of tables reopened as a table", "[[a]]\n[a]\n", 2],
    ["an unterminated string", 'a = "abc\n', 1],
    ["an unterminated multi-line string", 'a = """abc\n\n', 1],
    ["a newline in an inline table", "a = { x = 1,\n y = 2 }\n", 1],
    ["a trailing comma in an inline table", "a = { x = 1, }\n", 1],
    ["an unterminated array", "a = [1, 2\n", 2],
    ["a missing comma in an array", "a = [1 2]\n", 1],
    ["a leading zero", "a = 012\n", 1],
    ["a double underscore", "a = 1__0\n", 1],
    ["a trailing underscore", "a = 10_\n", 1],
    ["a bare word value", "a = yes\n", 1],
    ["a bad escape", 'a = "\\q"\n', 1],
    ["a bad unicode escape", 'a = "\\uD800"\n', 1],
    ["a control character in a string", 'a = "x\u0001y"\n', 1],
    ["a lone carriage return", "a = 1\rb = 2\n", 1],
    ["an empty bare key part", "a..b = 1\n", 1],
    ["an empty header", "[]\n", 1],
    ["a second value on the header line", "[a] b = 1\n", 1],
    ["an invalid date", "a = 1979-13-45\n", 1],
  ])("%s", (_name, src, line) => {
    expect(syntaxError(src).line).toBe(line);
  });

  it("the message is the parser's, without a prefix", () => {
    expect(syntaxError("a = \n").message).not.toMatch(/^toml syntax/);
    expect(syntaxError("a = \n").message.length).toBeGreaterThan(0);
  });
});
