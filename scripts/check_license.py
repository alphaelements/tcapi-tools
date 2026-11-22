#!/usr/bin/env python3
"""Check that a repository's license declarations match its license policy (ST-DCIT-018a).

Two policies exist in the Tcapi family:

  proprietary  -- closed-source firmware repos (tcapi-dio, incl. sim/).
                  LICENSE is an "All rights reserved" notice; Cargo packages use
                  `license-file` (pointing at that LICENSE) plus `publish = false`
                  and carry no SPDX `license`; no open-source license text or
                  claim appears anywhere in the declarations.
  apache-2.0   -- public repos (tcapi-cli, tcapi-tools). LICENSE is the full
                  Apache-2.0 text; every manifest that declares a license
                  declares exactly `Apache-2.0` (no `MIT OR Apache-2.0`);
                  LICENSE-MIT / LICENSE-APACHE are gone.

The dependency-license allow list (cargo-deny, "MIT/Apache-2.0 only") is a
separate rule about third-party crates and is deliberately not touched here.

Usage: check_license.py --policy {proprietary,apache-2.0} [--root DIR]
Exit status: 0 = consistent, 1 = violations (listed on stderr), 2 = usage error.
"""

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

POLICIES = ("proprietary", "apache-2.0")
APACHE_ID = "Apache-2.0"
#: Directories that hold vendored / generated manifests, never ours.
SKIP_DIRS = frozenset(
    {".git", "target", "node_modules", "dist", "bin", "obj", ".venv", "tmp", "wiki", "__pycache__"}
)
#: Per-license files of the old dual-license layout; neither policy keeps them.
STRAY_LICENSE_FILES = ("LICENSE-MIT", "LICENSE-APACHE", "LICENSE-APACHE-2.0", "LICENSE.md", "LICENSE.txt")
#: Proprietary licenses an npm / Python manifest may declare.
PROPRIETARY_IDS = ("UNLICENSED", "LicenseRef-Proprietary")
OPEN_SOURCE_TEXT = re.compile(r"Apache License|Permission is hereby granted|MIT License")
OPEN_SOURCE_CLAIM = re.compile(r"\bMIT\b|Apache")
STRAY_LICENSE_LINK = re.compile(r"LICENSE-(MIT|APACHE)")
CSPROJ_LICENSE = re.compile(r"<PackageLicenseExpression>\s*([^<]*?)\s*</PackageLicenseExpression>")


def manifests(root: Path):
    """Yield (path, kind) for every license-bearing manifest under root."""
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if any(part in SKIP_DIRS for part in rel.parts[:-1]) or not path.is_file():
            continue
        if path.name == "Cargo.toml":
            yield path, "cargo"
        elif path.name == "pyproject.toml":
            yield path, "pyproject"
        elif path.name == "package.json":
            yield path, "npm"
        elif path.suffix == ".csproj":
            yield path, "csproj"


def workspace_license(root: Path, manifest: Path):
    """The `[workspace.package] license` an inheriting member resolves to, or None."""
    directory = manifest.parent.parent
    while True:
        candidate = directory / "Cargo.toml"
        if candidate.is_file():
            data = tomllib.loads(candidate.read_text(encoding="utf-8"))
            if "workspace" in data:
                return data["workspace"].get("package", {}).get("license")
        if directory == root or root not in directory.parents:
            return None
        directory = directory.parent


def check_apache_manifest(root, path, kind, rel):
    out = []
    text = path.read_text(encoding="utf-8")
    if kind in ("cargo", "pyproject"):
        data = tomllib.loads(text)
        if kind == "cargo":
            ws_license = data.get("workspace", {}).get("package", {}).get("license")
            if ws_license is not None and ws_license != APACHE_ID:
                out.append(f"{rel}: [workspace.package] license is {ws_license!r}, expected {APACHE_ID!r}")
            package = data.get("package")
            if package is None:
                return out
            declared = package.get("license")
            if isinstance(declared, dict) and declared.get("workspace") is True:
                resolved = workspace_license(root, path)
                if resolved != APACHE_ID:
                    out.append(
                        f"{rel}: inherits license from the workspace, which declares {resolved!r}, "
                        f"expected {APACHE_ID!r}"
                    )
                return out
        else:
            package = data.get("project")
            if package is None:
                return out
            declared = package.get("license")
        if declared is None:
            out.append(f"{rel}: no license declared, expected {APACHE_ID!r}")
        elif declared != APACHE_ID:
            out.append(f"{rel}: license is {declared!r}, expected {APACHE_ID!r}")
    elif kind == "npm":
        data = json.loads(text)
        declared = data.get("license")
        if declared is None:
            if data.get("private") is not True:
                out.append(f"{rel}: public package declares no license, expected {APACHE_ID!r}")
        elif declared != APACHE_ID:
            out.append(f"{rel}: license is {declared!r}, expected {APACHE_ID!r}")
    else:
        match = CSPROJ_LICENSE.search(text)
        if match and match.group(1) != APACHE_ID:
            out.append(f"{rel}: PackageLicenseExpression is {match.group(1)!r}, expected {APACHE_ID!r}")
    return out


def check_proprietary_manifest(root, path, kind, rel):
    out = []
    text = path.read_text(encoding="utf-8")
    if kind == "cargo":
        package = tomllib.loads(text).get("package")
        if package is None:
            return out
        if "license" in package:
            out.append(f"{rel}: declares SPDX license {package['license']!r}; use license-file only")
        license_file = package.get("license-file")
        if license_file is None:
            out.append(f"{rel}: missing license-file (must point at the repository LICENSE)")
        elif (path.parent / license_file).resolve() != (root / "LICENSE").resolve():
            out.append(f"{rel}: license-file {license_file!r} does not resolve to the repository LICENSE")
        if package.get("publish") not in (False, []):
            out.append(f"{rel}: proprietary crate must set publish = false")
    elif kind in ("pyproject", "npm"):
        data = tomllib.loads(text).get("project", {}) if kind == "pyproject" else json.loads(text)
        declared = data.get("license")
        if declared is not None and declared not in PROPRIETARY_IDS:
            out.append(f"{rel}: license is {declared!r}, expected one of {PROPRIETARY_IDS}")
    else:
        match = CSPROJ_LICENSE.search(text)
        if match and match.group(1) not in PROPRIETARY_IDS:
            out.append(f"{rel}: PackageLicenseExpression is {match.group(1)!r}, expected one of {PROPRIETARY_IDS}")
    return out


def check_license_file(root: Path, policy: str):
    path = root / "LICENSE"
    if not path.is_file():
        return ["LICENSE: file is missing"]
    text = path.read_text(encoding="utf-8")
    if policy == "proprietary":
        out = []
        if "all rights reserved" not in text.lower():
            out.append("LICENSE: must state 'All rights reserved'")
        if OPEN_SOURCE_TEXT.search(text):
            out.append("LICENSE: contains open-source license text; tcapi-dio is proprietary")
        return out
    required = ("Apache License", "Version 2.0, January 2004", "TERMS AND CONDITIONS FOR USE, REPRODUCTION")
    if not all(marker in text for marker in required) or len(text) < 5000:
        return ["LICENSE: is not the full Apache License 2.0 text"]
    return []


def check_stray_license_references(root: Path):
    """README.md and docs/**/*.md must not point at the removed dual-license files."""
    docs = sorted((root / "docs").rglob("*.md")) if (root / "docs").is_dir() else []
    out = []
    for path in [root / "README.md", *docs]:
        if path.is_file() and STRAY_LICENSE_LINK.search(path.read_text(encoding="utf-8")):
            rel = path.relative_to(root).as_posix()
            out.append(f"{rel}: references LICENSE-MIT / LICENSE-APACHE, which do not exist; refer to LICENSE")
    return out


def check_readme(root: Path, policy: str):
    path = root / "README.md"
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8")
    out = []
    pattern = OPEN_SOURCE_CLAIM if policy == "proprietary" else re.compile(r"\bMIT\b")
    if pattern.search(text):
        out.append(f"README.md: license text conflicts with the {policy} policy")
    return out


def check(root, policy: str):
    """Return the list of human-readable violations (empty = consistent)."""
    if policy not in POLICIES:
        raise ValueError(f"unknown policy {policy!r}; expected one of {POLICIES}")
    root = Path(root).resolve()
    violations = check_license_file(root, policy)
    for name in STRAY_LICENSE_FILES:
        if (root / name).exists():
            violations.append(f"{name}: stray license file; only LICENSE is kept")
    manifest_check = check_apache_manifest if policy == "apache-2.0" else check_proprietary_manifest
    for path, kind in manifests(root):
        violations.extend(manifest_check(root, path, kind, path.relative_to(root).as_posix()))
    violations.extend(check_stray_license_references(root))
    violations.extend(check_readme(root, policy))
    return violations


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--policy", required=True, choices=POLICIES)
    parser.add_argument("--root", default=Path(__file__).resolve().parent.parent, type=Path)
    args = parser.parse_args(argv)
    violations = check(args.root, args.policy)
    for violation in violations:
        print(f"license-check: {violation}", file=sys.stderr)
    if violations:
        return 1
    print(f"license-check: ok ({args.policy})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
