/**
 * A small TOML 1.0 reader for the host-side configuration files
 * (`safety.toml`, docs/config-files.md). The SDK has no TOML dependency, and
 * the config error rules need the **line** of every key and table header,
 * which this reader records on each node.
 *
 * Line rules (they decide what `ConfigError.line` reports):
 *
 * - a `key = value` pair: the line of the key; every value nested in it (array
 *   elements, inline tables and their keys) carries that same line;
 * - a `[table]` / `[[table]]` header: the line of the header (for `[[x]]`, the
 *   array itself carries the line of its first header);
 * - a table created only as the parent of a header path or a dotted key: the
 *   line of the header or key that created it;
 * - inside a `[section]`, keys carry their own line.
 *
 * Values are typed (string, integer, float, boolean, datetime, array, table).
 * Integers are exact (`bigint`, i64 range). Floats and datetimes are
 * recognised and validated but opaque: configuration files only need to tell
 * that a value is not an integer. A syntax error is a `TomlSyntaxError` with
 * the 1-based line it was found on.
 */

export class TomlSyntaxError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = "TomlSyntaxError";
    this.line = line;
  }
}

interface Located {
  /** 1-based line, see the module comment. */
  line: number;
}

export interface TomlString extends Located {
  type: "string";
  value: string;
}
export interface TomlInteger extends Located {
  type: "integer";
  value: bigint;
}
export interface TomlFloat extends Located {
  type: "float";
}
export interface TomlBoolean extends Located {
  type: "boolean";
  value: boolean;
}
export interface TomlDatetime extends Located {
  type: "datetime";
}
export interface TomlArray extends Located {
  type: "array";
  items: TomlNode[];
  /** Created by `[[header]]` (extendable by another `[[header]]`), not by a value. */
  fromHeaders: boolean;
}
export interface TomlTable extends Located {
  type: "table";
  entries: Map<string, TomlNode>;
  /**
   * How the table came to be, which decides whether a later header may reopen
   * it: `header` (`[t]`), `implicit` (only the parent of a deeper path),
   * `dotted` (created by `a.b = 1`) or `inline` (`{ ... }`, closed).
   */
  origin: "header" | "implicit" | "dotted" | "inline";
}

export type TomlNode =
  | TomlString
  | TomlInteger
  | TomlFloat
  | TomlBoolean
  | TomlDatetime
  | TomlArray
  | TomlTable;

const I64_MAX = 9223372036854775807n;
const I64_MIN = -9223372036854775808n;

const BARE_KEY = /[A-Za-z0-9_-]/;
const DATETIME =
  /(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))?)?(?![\w.])|(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?![\w.])/y;
const DEC_INT = /[+-]?(?:0|[1-9](?:_?\d)*)(?![\w.])/y;
const BASE_INT = /0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)(?![\w.])/y;
const FLOAT =
  /[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?(?![\w.])|[+-]?(?:inf|nan)(?![\w.])/y;

const ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

/** Parse a TOML document into its root table. */
export function parseToml(src: string): TomlTable {
  return new Reader(src).document();
}

class Reader {
  private readonly src: string;
  private pos = 0;
  /** Offsets of every `\n`, to turn a position into a line. */
  private readonly newlines: number[] = [];
  private readonly root: TomlTable = newTable(1, "header");
  private current: TomlTable = this.root;

  constructor(src: string) {
    this.src = src.startsWith("﻿") ? src.slice(1) : src;
    for (let i = 0; i < this.src.length; i++) {
      if (this.src[i] === "\n") this.newlines.push(i);
    }
  }

  // --- diagnostics ---

  private lineAt(pos: number): number {
    // Number of newlines strictly before `pos`, plus one.
    let lo = 0;
    let hi = this.newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.newlines[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  }

  private fail(message: string, pos: number = this.pos): never {
    throw new TomlSyntaxError(message, this.lineAt(Math.min(pos, this.src.length)));
  }

  // --- lexical helpers ---

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  private skipComment(): void {
    if (this.peek() !== "#") return;
    while (!this.eof() && this.peek() !== "\n") {
      const c = this.peek();
      if (c === "\r" && this.peek(1) !== "\n") this.fail("a bare carriage return is not allowed");
      if (isControl(c) && c !== "\t" && c !== "\r") this.fail("control character in a comment");
      this.pos++;
    }
  }

  /** At a line end (`\n` or `\r\n`)? Consumes it. A lone `\r` is an error. */
  private newline(): boolean {
    if (this.peek() === "\n") {
      this.pos++;
      return true;
    }
    if (this.peek() === "\r") {
      if (this.peek(1) !== "\n") this.fail("a bare carriage return is not allowed");
      this.pos += 2;
      return true;
    }
    return false;
  }

  /** Spaces, comments and newlines (between statements and inside arrays). */
  private skipBlank(): void {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (!this.newline()) return;
    }
  }

  // --- document ---

  document(): TomlTable {
    for (;;) {
      this.skipBlank();
      if (this.eof()) return this.root;
      if (this.peek() === "[") this.header();
      else this.keyValue(this.current);
      this.skipSpaces();
      this.skipComment();
      if (!this.eof() && !this.newline()) this.fail("expected a newline after the value");
    }
  }

  // --- keys ---

  private bareOrQuotedKey(): string {
    const c = this.peek();
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    const start = this.pos;
    while (BARE_KEY.test(this.peek())) this.pos++;
    if (this.pos === start) this.fail("expected a key");
    return this.src.slice(start, this.pos);
  }

  private dottedKey(): string[] {
    const parts = [this.bareOrQuotedKey()];
    for (;;) {
      this.skipSpaces();
      if (this.peek() !== ".") return parts;
      this.pos++;
      this.skipSpaces();
      parts.push(this.bareOrQuotedKey());
    }
  }

  // --- headers ---

  private header(): void {
    const line = this.lineAt(this.pos);
    const isArray = this.peek(1) === "[";
    this.pos += isArray ? 2 : 1;
    this.skipSpaces();
    const path = this.dottedKey();
    this.skipSpaces();
    const close = isArray ? "]]" : "]";
    if (!this.src.startsWith(close, this.pos)) this.fail(`expected '${close}' to end the table header`);
    this.pos += close.length;

    // Walk (and create) the parents.
    let table = this.root;
    for (const key of path.slice(0, -1)) {
      table = this.descend(table, key, line);
    }
    const last = path[path.length - 1];
    const existing = table.entries.get(last);
    if (isArray) {
      if (existing === undefined) {
        const fresh = newTable(line, "header");
        table.entries.set(last, { type: "array", items: [fresh], fromHeaders: true, line });
        this.current = fresh;
      } else if (existing.type === "array" && existing.fromHeaders) {
        const fresh = newTable(line, "header");
        existing.items.push(fresh);
        this.current = fresh;
      } else {
        this.fail(`'${last}' is already defined and is not an array of tables`, this.headerPos(line));
      }
      return;
    }
    if (existing === undefined) {
      const fresh = newTable(line, "header");
      table.entries.set(last, fresh);
      this.current = fresh;
    } else if (existing.type === "table" && existing.origin === "implicit") {
      existing.origin = "header";
      existing.line = line;
      this.current = existing;
    } else {
      this.fail(`table '${last}' is defined more than once`, this.headerPos(line));
    }
  }

  /** A position on the header's line, for errors found after the header was read. */
  private headerPos(line: number): number {
    return line - 1 === 0 ? 0 : this.newlines[line - 2] + 1;
  }

  /**
   * The table at `key` inside `table` for walking a path: created as
   * `implicit` when missing, the last element of an array of tables, or an
   * existing table that may still be extended.
   */
  private descend(table: TomlTable, key: string, line: number): TomlTable {
    const existing = table.entries.get(key);
    if (existing === undefined) {
      const fresh = newTable(line, "implicit");
      table.entries.set(key, fresh);
      return fresh;
    }
    if (existing.type === "table") {
      if (existing.origin === "inline" || existing.origin === "dotted") {
        this.fail(`table '${key}' was defined by a value and cannot be extended by a header`, this.headerPos(line));
      }
      return existing;
    }
    if (existing.type === "array" && existing.fromHeaders) {
      return existing.items[existing.items.length - 1] as TomlTable;
    }
    return this.fail(`'${key}' is already defined and is not a table`, this.headerPos(line));
  }

  // --- key = value ---

  private keyValue(into: TomlTable): void {
    const line = this.lineAt(this.pos);
    const path = this.dottedKey();
    this.skipSpaces();
    if (this.peek() !== "=") this.fail("expected '=' after the key");
    this.pos++;
    this.skipSpaces();

    let table = into;
    for (const key of path.slice(0, -1)) {
      const existing = table.entries.get(key);
      if (existing === undefined) {
        const fresh = newTable(line, "dotted");
        table.entries.set(key, fresh);
        table = fresh;
      } else if (existing.type === "table" && existing.origin === "dotted") {
        table = existing;
      } else {
        this.fail(`'${key}' is already defined and cannot be extended by a dotted key`);
      }
    }
    const last = path[path.length - 1];
    if (table.entries.has(last)) this.fail(`duplicate key '${last}'`);
    table.entries.set(last, this.value(line));
  }

  // --- values ---

  /** `line` is the line of the enclosing key; every nested node inherits it. */
  private value(line: number): TomlNode {
    const c = this.peek();
    if (c === "" || c === "\n" || c === "\r" || c === "#") this.fail("expected a value");
    if (c === '"') {
      const value = this.src.startsWith('"""', this.pos) ? this.multilineBasic() : this.basicString();
      return { type: "string", value, line };
    }
    if (c === "'") {
      const value = this.src.startsWith("'''", this.pos) ? this.multilineLiteral() : this.literalString();
      return { type: "string", value, line };
    }
    if (c === "[") return this.array(line);
    if (c === "{") return this.inlineTable(line);
    if (this.matchWord("true")) return { type: "boolean", value: true, line };
    if (this.matchWord("false")) return { type: "boolean", value: false, line };
    return this.scalar(line);
  }

  private matchWord(word: string): boolean {
    if (!this.src.startsWith(word, this.pos)) return false;
    if (/[\w-]/.test(this.src[this.pos + word.length] ?? "")) return false;
    this.pos += word.length;
    return true;
  }

  private sticky(re: RegExp): RegExpExecArray | null {
    re.lastIndex = this.pos;
    return re.exec(this.src);
  }

  /** Numbers and dates. */
  private scalar(line: number): TomlNode {
    const start = this.pos;
    const date = this.sticky(DATETIME);
    if (date !== null) {
      checkDatetime(date, (m) => this.fail(m, start));
      this.pos += date[0].length;
      return { type: "datetime", line };
    }
    const base = this.sticky(BASE_INT);
    if (base !== null) {
      this.pos += base[0].length;
      return this.integer(BigInt(base[0].replace(/_/g, "")), start, line);
    }
    const dec = this.sticky(DEC_INT);
    if (dec !== null) {
      this.pos += dec[0].length;
      return this.integer(BigInt(dec[0].replace(/_/g, "")), start, line);
    }
    const float = this.sticky(FLOAT);
    if (float !== null) {
      this.pos += float[0].length;
      return { type: "float", line };
    }
    return this.fail(`invalid value '${this.token()}'`, start);
  }

  private integer(value: bigint, start: number, line: number): TomlInteger {
    if (value > I64_MAX || value < I64_MIN) this.fail("integer out of range (64-bit signed)", start);
    return { type: "integer", value, line };
  }

  /** The text up to the next delimiter, for error messages. */
  private token(): string {
    const m = /[^\s,\]}#]*/y;
    m.lastIndex = this.pos;
    return (m.exec(this.src)?.[0] ?? "").slice(0, 40);
  }

  private array(line: number): TomlArray {
    this.pos++; // [
    const items: TomlNode[] = [];
    for (;;) {
      this.skipBlank();
      if (this.eof()) this.fail("unterminated array");
      if (this.peek() === "]") {
        this.pos++;
        return { type: "array", items, fromHeaders: false, line };
      }
      items.push(this.value(line));
      this.skipBlank();
      if (this.peek() === ",") {
        this.pos++;
      } else if (this.peek() !== "]") {
        this.fail(this.eof() ? "unterminated array" : "expected ',' or ']' in an array");
      }
    }
  }

  private inlineTable(line: number): TomlTable {
    this.pos++; // {
    const table = newTable(line, "inline");
    this.skipSpaces();
    if (this.peek() === "}") {
      this.pos++;
      return table;
    }
    for (;;) {
      this.skipSpaces();
      this.inlineKeyValue(table, line);
      this.skipSpaces();
      if (this.peek() === ",") {
        this.pos++;
      } else if (this.peek() === "}") {
        this.pos++;
        return table;
      } else {
        this.fail("expected ',' or '}' in an inline table");
      }
    }
  }

  /** A `key = value` of an inline table: nested nodes inherit the line of the enclosing key. */
  private inlineKeyValue(into: TomlTable, line: number): void {
    const path = this.dottedKey();
    this.skipSpaces();
    if (this.peek() !== "=") this.fail("expected '=' after the key");
    this.pos++;
    this.skipSpaces();
    let table = into;
    for (const key of path.slice(0, -1)) {
      const existing = table.entries.get(key);
      if (existing === undefined) {
        const fresh = newTable(line, "dotted");
        table.entries.set(key, fresh);
        table = fresh;
      } else if (existing.type === "table" && existing.origin === "dotted") {
        table = existing;
      } else {
        this.fail(`'${key}' is already defined and cannot be extended by a dotted key`);
      }
    }
    const last = path[path.length - 1];
    if (table.entries.has(last)) this.fail(`duplicate key '${last}'`);
    table.entries.set(last, this.value(line));
  }

  // --- strings ---

  private basicString(): string {
    const start = this.pos;
    this.pos++; // "
    let out = "";
    for (;;) {
      const c = this.peek();
      if (c === "" || c === "\n" || c === "\r") this.fail("unterminated string", start);
      this.pos++;
      if (c === '"') return out;
      if (c === "\\") out += this.escape(false);
      else out += this.plainChar(c);
    }
  }

  private literalString(): string {
    const start = this.pos;
    this.pos++; // '
    let out = "";
    for (;;) {
      const c = this.peek();
      if (c === "" || c === "\n" || c === "\r") this.fail("unterminated string", start);
      this.pos++;
      if (c === "'") return out;
      out += this.plainChar(c);
    }
  }

  private multilineBasic(): string {
    const start = this.pos;
    this.pos += 3;
    this.newline(); // a newline right after the opening quotes is trimmed
    let out = "";
    for (;;) {
      if (this.eof()) this.fail("unterminated multi-line string", start);
      if (this.src.startsWith('"""', this.pos)) {
        this.pos += 3;
        // Up to two further quotes belong to the string.
        while (this.peek() === '"') {
          if (this.src.startsWith('"""', this.pos)) this.fail("too many quotes at the end of a string", start);
          out += '"';
          this.pos++;
        }
        return out;
      }
      const c = this.peek();
      this.pos++;
      if (c === "\\") out += this.escape(true);
      else if (c === "\r" && this.peek() === "\n") {
        this.pos++;
        out += "\n";
      } else out += this.plainChar(c, true);
    }
  }

  private multilineLiteral(): string {
    const start = this.pos;
    this.pos += 3;
    this.newline();
    let out = "";
    for (;;) {
      if (this.eof()) this.fail("unterminated multi-line string", start);
      if (this.src.startsWith("'''", this.pos)) {
        this.pos += 3;
        while (this.peek() === "'") {
          if (this.src.startsWith("'''", this.pos)) this.fail("too many quotes at the end of a string", start);
          out += "'";
          this.pos++;
        }
        return out;
      }
      const c = this.peek();
      this.pos++;
      if (c === "\r" && this.peek() === "\n") {
        this.pos++;
        out += "\n";
      } else out += this.plainChar(c, true);
    }
  }

  private plainChar(c: string, multiline = false): string {
    if (c === "\n" && multiline) return c;
    if (c === "\t") return c;
    if (isControl(c)) this.fail("control character in a string", this.pos - 1);
    return c;
  }

  /** After a backslash. In a multi-line string, `\` + whitespace + newline trims the whitespace that follows. */
  private escape(multiline: boolean): string {
    const at = this.pos - 1;
    const c = this.peek();
    this.pos++;
    const simple = ESCAPES[c];
    if (simple !== undefined) return simple;
    if (c === "u" || c === "U") {
      const width = c === "u" ? 4 : 8;
      const hex = this.src.slice(this.pos, this.pos + width);
      if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) this.fail("invalid unicode escape", at);
      const code = parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        this.fail("unicode escape is not a scalar value", at);
      }
      this.pos += width;
      return String.fromCodePoint(code);
    }
    if (multiline && (c === " " || c === "\t" || c === "\n" || c === "\r")) {
      this.pos--;
      const rest = /[ \t]*\r?\n[ \t\r\n]*/y;
      rest.lastIndex = this.pos;
      const m = rest.exec(this.src);
      if (m !== null) {
        this.pos += m[0].length;
        return "";
      }
    }
    return this.fail(`invalid escape sequence '\\${c}'`, at);
  }
}

function newTable(line: number, origin: TomlTable["origin"]): TomlTable {
  return { type: "table", entries: new Map(), line, origin };
}

function isControl(c: string): boolean {
  const code = c.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** Calendar and clock ranges of a matched date / time (the regex only checks the shape). */
function checkDatetime(m: RegExpExecArray, fail: (message: string) => never): void {
  if (m[1] !== undefined) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const daysInMonth = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) fail("invalid date");
    if (m[4] !== undefined) checkClock(Number(m[4]), Number(m[5]), Number(m[6]), fail);
    if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) fail("invalid time zone offset");
  } else {
    checkClock(Number(m[9]), Number(m[10]), Number(m[11]), fail);
  }
}

function checkClock(h: number, min: number, s: number, fail: (message: string) => never): void {
  if (h > 23 || min > 59 || s > 60) fail("invalid time");
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
