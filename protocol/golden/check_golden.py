#!/usr/bin/env python3
"""Structural validator for the v2 golden transcripts (protocol/golden/*.txt).

Usage: check_golden.py [golden_dir]   (default: the directory of this script)
Exit status 0 when every file is well formed and the coverage lists are satisfied.
"""
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent
FILES = ["version-info", "map", "io", "pattern", "timestamp", "sync", "reset", "errors", "boundary", "events"]
ERRORS = ["BAD_PARAM", "BAD_MAP", "BUSY", "FLASH", "TOO_LONG", "NOT_ARMED", "SYNC_STATE",
          "NO_RESOURCE", "NOT_RUNNING", "UNKNOWN_CMD", "LINE_TOO_LONG"]
FORMS = ["version", "caps", "info", "devnum", "ping", "map get", "map set", "map save", "map default",
         "read", "write", "state", "pattern add", "pattern run once", "pattern run loop", "pattern stop",
         "pattern reset", "pattern status", "ts arm", "ts disarm", "ts get", "ts status", "subscribe on",
         "subscribe off", "sync arm", "sync master", "sync start", "sync stop", "sync disarm", "sync count",
         "reset", "bootsel", "help"]
DIRECTIVES = ["in=", "advance", "send_hex", "sync_edge", "fault", "expect_pins"]
TAGS = ["R-T1", "R-T3", "R-T4", "R-T5", "R-E3", "R-M2", "R-M5", "R-PT1", "R-PT3", "R-PT4", "R-PT5"] + \
       [f"R-M1({f})" for f in ["flags", "dir", "pu", "pd", "def", "opol", "ipol", "edge", "pu&pd"]]
EVENTS = ["INPUT", "PATTERN_DONE", "PATTERN_TIMEOUT"]
# Errors the firmware answers that no text request can provoke (binary / HID only).
NON_TEXT_ERRORS = ["BAD_CMD", "TRANSPORT_NOT_SUPPORTED"]
TRANSPORTS = ["CDC text", "CDC binary", "HID"]
FW_COMMIT = re.compile(r"# fw_commit=([0-9a-f]{7,40})(\+wt)?$")

errs = []
ok_forms, seen_err, seen_tags, seen_events, lens = set(), set(), set(), set(), set()
stamps = {}      # file name -> fw_commit stamp
warnings = []
text_all = ""


def err(f, n, m):
    errs.append(f"{f}:{n}: {m}")


for name in FILES:
    p = ROOT / f"{name}.txt"
    if not p.exists():
        err(name, 0, "missing file")
        continue
    lines = p.read_text().split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    text_all += "\n".join(lines) + "\n"
    if lines[:2] != ["# proto=2", "# generated_by=hand"]:
        err(name, 1, "bad header")
    m = FW_COMMIT.match(lines[2]) if len(lines) > 2 else None
    if m:
        stamps[name] = m.group(0)[len("# fw_commit="):]
    else:
        err(name, 3, "header lacks '# fw_commit=<sha>' (7-40 lowercase hex digits, optional +wt)")
    pending = None      # (lineno, form) request awaiting header
    unsolicited = False
    cont_left = 0
    expect_len = None
    sync_hex_line = 0
    for i, ln in enumerate(lines, 1):
        if ln == "":
            if pending:
                err(name, i, f"request line {pending[0]} has no response")
            if cont_left:
                err(name, i, "continuation lines missing")
            pending, unsolicited, cont_left, expect_len = None, False, 0, None
            continue
        if ln != ln.rstrip() or "\t" in ln or not ln.isascii():
            err(name, i, "whitespace/non-ascii")
        if ln.startswith("# "):
            m = re.match(r"# len=(\d+)$", ln)
            if m:
                expect_len = int(m.group(1))
            for t in TAGS:
                if t in ln:
                    seen_tags.add(t)
            continue
        if cont_left and not ln.startswith("<   "):
            err(name, i, "expected continuation line")
            cont_left = 0
        if ln.startswith("> "):
            if pending:
                err(name, i, f"request line {pending[0]} has no response")
            body = ln[2:]
            if expect_len is not None:
                if len(body) != expect_len:
                    err(name, i, f"len annotation {expect_len} != {len(body)}")
                lens.add(expect_len)
                expect_len = None
            toks = body.lower().split()
            pending = (i, toks)
        elif ln.startswith("~ "):
            unsolicited = True
            if pending:
                err(name, i, "directive between request and response")
            dtoks = ln[2:].split()
            if not any(dtoks[0].startswith(d) for d in DIRECTIVES):
                err(name, i, f"unknown directive {dtoks[0]}")
            if dtoks[0] == "send_hex":
                if not all(re.fullmatch(r"[0-9a-f]{2}", b) for b in dtoks[1:]) or len(dtoks) < 2:
                    err(name, i, "send_hex needs lowercase hex bytes")
                if dtoks[1] == "00":
                    sync_hex_line = i
            if dtoks[0] == "expect_pins" and not re.fullmatch(r"expect_pins out=0x[0-9a-f]{8}", ln[2:]):
                err(name, i, "bad expect_pins")
        elif ln.startswith("< ! "):
            m = re.match(r"< ! (INPUT in=0x[0-9a-f]{8} t=\d+|PATTERN_DONE loops=\d+|PATTERN_TIMEOUT loops=\d+)$", ln)
            if not m:
                err(name, i, "bad event")
            else:
                seen_events.add(ln.split()[2])
            if pending:
                err(name, i, "event between request and response")
        elif ln.startswith("<   "):
            if cont_left <= 0:
                err(name, i, "unexpected continuation")
            else:
                cont_left -= 1
        elif ln.startswith("< OK") or ln.startswith("< ERR "):
            if sync_hex_line and sync_hex_line == i - 1:
                err(name, i, "response right after send_hex 00 ...: bytes after the sync byte are frame body (R-T5)")
            if not pending and not unsolicited:
                err(name, i, "response without request")
            if ln.startswith("< ERR "):
                e = ln[6:]
                if e not in ERRORS:
                    err(name, i, f"unknown error name {e}")
                seen_err.add(e)
            elif pending:
                toks = pending[1]
                for n in (3, 2, 1):
                    f = " ".join(toks[:n])
                    if f in FORMS:
                        ok_forms.add(f)
                        break
                if toks[:2] == ["pattern", "run"] and len(toks) > 2:
                    ok_forms.add(" ".join(toks[:3]))
                if toks[:1] == ["subscribe"] and len(toks) > 1:
                    ok_forms.add(" ".join(toks[:2]))
            m = re.search(r"\bcount=(\d+)", ln)
            if m and ln.startswith("< OK"):
                cont_left = int(m.group(1))
            pending = None
        else:
            err(name, i, "unrecognised line type")
            continue
        if ln.startswith("<"):
            for k, v in re.findall(r"\b(\w+)=(0x[0-9A-Za-z]+)", ln):
                width = 2 if k == "flags" else 8
                if not re.fullmatch(rf"0x[0-9a-f]{{{width}}}", v):
                    err(name, i, f"R-T3 format {k}={v}")
    if pending:
        err(name, len(lines), "last request has no response")
    if cont_left:
        err(name, len(lines), "continuation lines missing at EOF")

for f in FORMS:
    if f not in ok_forms:
        errs.append(f"coverage: no OK example for '{f}'")
for e in ERRORS:
    if e not in seen_err:
        errs.append(f"coverage: error {e} never produced")
for t in TAGS:
    if t not in seen_tags:
        errs.append(f"coverage: rule tag {t} missing")
for e in EVENTS:
    if e not in seen_events:
        errs.append(f"coverage: event {e} missing")
for n in (256, 257, 300):
    if n not in lens:
        errs.append(f"coverage: # len={n} line missing")
for needle, what in [("count=0", "count=0 response"), ("total=256", "256 steps"),
                     ("~ send_hex 03", "R-T5 binary excursion before sync"), ("~ send_hex 00", "R-T5 negative case after sync"),
                     ("~ expect_pins", "physical pin assertion"), ("pattern add", "pattern add"),
                     ("`pattern load`", "")]:
    if needle == "`pattern load`":
        if "> pattern load" not in text_all:
            errs.append("coverage: deprecated 'pattern load' rejection missing")
        continue
    if needle not in text_all:
        errs.append(f"coverage: {what} missing")
if len(set(stamps.values())) > 1:
    errs.append(f"fw_commit differs between files: {sorted(set(stamps.values()))}")
unstamped = sorted(name for name, stamp in stamps.items() if stamp.endswith("+wt"))
if unstamped:
    warnings.append(f"fw_commit is not stamped yet in {len(unstamped)} file(s) "
                    "(run scripts/stamp-golden-fw-commit.sh in pochi-dio after committing the revision)")


def check_error_table(readme):
    """README 'Error coverage by transport': one row per error, one cell per transport."""
    head = "## Error coverage by transport"
    if head not in readme:
        errs.append(f"README lacks the '{head}' section")
        return
    body = readme.split(head, 1)[1].split("\n## ", 1)[0]
    rows = {}
    for ln in body.split("\n"):
        if not ln.startswith("| `"):
            continue
        cols = [c.strip() for c in ln.strip("|").split("|")]
        if len(cols) != 4:
            errs.append(f"README error table: row needs 4 columns: {ln}")
            continue
        rows[cols[0].strip("`")] = cols[1:]
    for e in sorted(set(ERRORS + NON_TEXT_ERRORS) - set(rows)):
        errs.append(f"README error table: error {e} has no row")
    for e in sorted(set(rows) - set(ERRORS + NON_TEXT_ERRORS)):
        errs.append(f"README error table: row for unknown error {e}")
    for e, cells in rows.items():
        for transport, cell in zip(TRANSPORTS, cells):
            if cell.startswith("golden:"):
                if transport != "CDC text":
                    errs.append(f"README error table: {e}/{transport}: only the CDC text column can cite a transcript")
                    continue
                f = cell[len("golden:"):].strip().strip("`")
                p = ROOT / f"{f}.txt"
                if f not in FILES or not p.exists() or f"< ERR {e}" not in p.read_text().split("\n"):
                    errs.append(f"README error table: {e}/{transport}: {f}.txt has no '< ERR {e}' line")
            elif cell == "probe":
                if transport == "CDC text":
                    errs.append(f"README error table: {e}/{transport}: a text cell cannot be a probe")
            elif cell.startswith("n/a:"):
                if len(cell[len("n/a:"):].strip()) < 10:
                    errs.append(f"README error table: {e}/{transport}: n/a needs a reason")
            else:
                errs.append(f"README error table: {e}/{transport}: unknown cell '{cell}'")
        if e in ERRORS and not cells[0].startswith("golden:"):
            errs.append(f"README error table: text-reachable error {e} lacks a golden cell")
        if e in NON_TEXT_ERRORS and cells[0].startswith("golden:"):
            errs.append(f"README error table: {e} cannot occur in a text transcript")


rd = ROOT / "README.md"
if not rd.exists():
    errs.append("README.md missing")
else:
    r = rd.read_text()
    for needle in ["# proto=2", "# generated_by=hand", "# fw_commit=", "> ", "< OK", "< ERR", "<   ", "< ! ", "~ "]:
        if needle not in r:
            errs.append(f"README lacks '{needle}'")
    check_error_table(r)

for w in warnings:
    print(f"WARNING: {w}")
if errs:
    print("\n".join(errs))
    print(f"FAIL: {len(errs)} problem(s)")
    sys.exit(1)
print(f"OK: {len(FILES)} files, forms={len(ok_forms)}, errors={len(seen_err)}, events={sorted(seen_events)}")
