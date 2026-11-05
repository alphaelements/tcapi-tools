#!/usr/bin/env python3
"""Tests for scripts/check_license.py (ST-DCIT-018a).

Run: python3 -m unittest tests/test_check_license.py   (or python3 tests/test_check_license.py)

The unit tests build throw-away trees so each rule is exercised in isolation;
`RealRepoTest` runs the checker against this repository itself, which is the
declaration-consistency gate ST-DCIT-018a asks for.
"""

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "check_license.py"
#: The policy this repository must satisfy (public repo, Apache-2.0 only).
REPO_POLICY = "apache-2.0"

PROPRIETARY_LICENSE = (
    "Copyright (c) 2026 Alpha Elements (alphaelements). All rights reserved.\n\n"
    "This software is proprietary. No license is granted.\n"
)
APACHE_LICENSE = (
    "                              Apache License\n"
    "                        Version 2.0, January 2004\n"
    "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n" + ("x" * 6000) + "\n"
)


def load_module():
    spec = importlib.util.spec_from_file_location("check_license", SCRIPT)
    assert spec is not None and spec.loader is not None, f"cannot load {SCRIPT}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Tree:
    """A throw-away repo tree."""

    def __init__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def cleanup(self):
        self._tmp.cleanup()


def proprietary_tree():
    tree = Tree()
    tree.write("LICENSE", PROPRIETARY_LICENSE)
    tree.write(
        "Cargo.toml",
        '[package]\nname = "a"\nversion = "0.1.0"\nlicense-file = "LICENSE"\npublish = false\n',
    )
    tree.write(
        "sim/Cargo.toml",
        '[package]\nname = "b"\nversion = "0.1.0"\nlicense-file = "../LICENSE"\npublish = false\n',
    )
    tree.write("README.md", "# a\n\n## License\n\nProprietary. All rights reserved.\n")
    return tree


def apache_tree():
    tree = Tree()
    tree.write("LICENSE", APACHE_LICENSE)
    tree.write(
        "Cargo.toml",
        '[workspace]\nmembers = ["sdk"]\n\n[workspace.package]\nlicense = "Apache-2.0"\n',
    )
    tree.write(
        "sdk/Cargo.toml",
        '[package]\nname = "sdk"\nversion = "0.1.0"\nlicense.workspace = true\n',
    )
    tree.write("README.md", "# a\n\n## License\n\nApache-2.0\n")
    return tree


class CheckerTestCase(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()
        self.trees = []

    def tearDown(self):
        for tree in self.trees:
            tree.cleanup()

    def make(self, factory):
        tree = factory()
        self.trees.append(tree)
        return tree

    def assertViolation(self, violations, needle):
        self.assertTrue(
            any(needle in v for v in violations),
            f"expected a violation mentioning {needle!r}, got {violations!r}",
        )


class ProprietaryPolicyTest(CheckerTestCase):
    def check(self, tree):
        return self.mod.check(tree.root, "proprietary")

    def test_conforming_tree_is_clean(self):
        self.assertEqual(self.check(self.make(proprietary_tree)), [])

    def test_missing_license_file(self):
        tree = self.make(proprietary_tree)
        (tree.root / "LICENSE").unlink()
        self.assertViolation(self.check(tree), "LICENSE")

    def test_license_without_all_rights_reserved(self):
        tree = self.make(proprietary_tree)
        tree.write("LICENSE", "Copyright Alpha Elements\n")
        self.assertViolation(self.check(tree), "All rights reserved")

    def test_license_that_is_apache_text(self):
        tree = self.make(proprietary_tree)
        tree.write("LICENSE", PROPRIETARY_LICENSE + APACHE_LICENSE)
        self.assertViolation(self.check(tree), "open-source")

    def test_cargo_spdx_license_forbidden(self):
        tree = self.make(proprietary_tree)
        tree.write(
            "Cargo.toml",
            '[package]\nname = "a"\nversion = "0.1.0"\n'
            'license = "MIT OR Apache-2.0"\nlicense-file = "LICENSE"\npublish = false\n',
        )
        self.assertViolation(self.check(tree), "Cargo.toml")

    def test_cargo_missing_license_file(self):
        tree = self.make(proprietary_tree)
        tree.write("sim/Cargo.toml", '[package]\nname = "b"\nversion = "0.1.0"\npublish = false\n')
        self.assertViolation(self.check(tree), "sim/Cargo.toml")

    def test_cargo_license_file_must_resolve(self):
        tree = self.make(proprietary_tree)
        tree.write(
            "sim/Cargo.toml",
            '[package]\nname = "b"\nversion = "0.1.0"\nlicense-file = "LICENSE"\npublish = false\n',
        )
        self.assertViolation(self.check(tree), "does not resolve")

    def test_cargo_must_not_be_publishable(self):
        tree = self.make(proprietary_tree)
        tree.write(
            "Cargo.toml",
            '[package]\nname = "a"\nversion = "0.1.0"\nlicense-file = "LICENSE"\n',
        )
        self.assertViolation(self.check(tree), "publish")

    def test_stray_open_source_license_files(self):
        for name in ("LICENSE-MIT", "LICENSE-APACHE"):
            with self.subTest(name=name):
                tree = self.make(proprietary_tree)
                tree.write(name, "text")
                self.assertViolation(self.check(tree), name)

    def test_readme_claiming_open_source_license(self):
        tree = self.make(proprietary_tree)
        tree.write("README.md", "## License\n\nMIT OR Apache-2.0\n")
        self.assertViolation(self.check(tree), "README.md")

    def test_package_json_open_source_license(self):
        tree = self.make(proprietary_tree)
        tree.write("web/package.json", '{"name": "w", "license": "MIT"}')
        self.assertViolation(self.check(tree), "web/package.json")

    def test_package_json_unlicensed_is_fine(self):
        tree = self.make(proprietary_tree)
        tree.write("web/package.json", '{"name": "w", "license": "UNLICENSED"}')
        self.assertEqual(self.check(tree), [])

    def test_vendored_dirs_are_ignored(self):
        tree = self.make(proprietary_tree)
        tree.write("target/x/Cargo.toml", '[package]\nname = "t"\nlicense = "MIT"\n')
        tree.write("node_modules/p/package.json", '{"license": "MIT"}')
        self.assertEqual(self.check(tree), [])


class ApachePolicyTest(CheckerTestCase):
    def check(self, tree):
        return self.mod.check(tree.root, "apache-2.0")

    def test_conforming_tree_is_clean(self):
        self.assertEqual(self.check(self.make(apache_tree)), [])

    def test_missing_license_file(self):
        tree = self.make(apache_tree)
        (tree.root / "LICENSE").unlink()
        self.assertViolation(self.check(tree), "LICENSE")

    def test_license_not_apache_text(self):
        tree = self.make(apache_tree)
        tree.write("LICENSE", "MIT License\n\nPermission is hereby granted\n")
        self.assertViolation(self.check(tree), "Apache License 2.0")

    def test_dual_license_files_forbidden(self):
        for name in ("LICENSE-MIT", "LICENSE-APACHE"):
            with self.subTest(name=name):
                tree = self.make(apache_tree)
                tree.write(name, "text")
                self.assertViolation(self.check(tree), name)

    def test_workspace_license_dual_forbidden(self):
        tree = self.make(apache_tree)
        tree.write(
            "Cargo.toml",
            '[workspace]\nmembers = ["sdk"]\n\n[workspace.package]\nlicense = "MIT OR Apache-2.0"\n',
        )
        self.assertViolation(self.check(tree), "Cargo.toml")

    def test_cargo_package_without_license(self):
        tree = self.make(apache_tree)
        tree.write("sdk/Cargo.toml", '[package]\nname = "sdk"\nversion = "0.1.0"\n')
        self.assertViolation(self.check(tree), "sdk/Cargo.toml")

    def test_cargo_package_own_apache_license_ok(self):
        tree = self.make(apache_tree)
        tree.write(
            "sdk/Cargo.toml",
            '[package]\nname = "sdk"\nversion = "0.1.0"\nlicense = "Apache-2.0"\n',
        )
        self.assertEqual(self.check(tree), [])

    def test_workspace_inheritance_without_workspace_license(self):
        tree = self.make(apache_tree)
        tree.write("Cargo.toml", '[workspace]\nmembers = ["sdk"]\n')
        self.assertViolation(self.check(tree), "sdk/Cargo.toml")

    def test_package_json_dual_license(self):
        tree = self.make(apache_tree)
        tree.write("ts/package.json", '{"name": "t", "license": "MIT OR Apache-2.0"}')
        self.assertViolation(self.check(tree), "ts/package.json")

    def test_package_json_private_without_license_ok(self):
        tree = self.make(apache_tree)
        tree.write("gui/package.json", '{"name": "g", "private": true}')
        self.assertEqual(self.check(tree), [])

    def test_package_json_public_without_license(self):
        tree = self.make(apache_tree)
        tree.write("ts/package.json", '{"name": "t"}')
        self.assertViolation(self.check(tree), "ts/package.json")

    def test_pyproject_dual_license(self):
        tree = self.make(apache_tree)
        tree.write("py/pyproject.toml", '[project]\nname = "p"\nlicense = "MIT OR Apache-2.0"\n')
        self.assertViolation(self.check(tree), "py/pyproject.toml")

    def test_pyproject_apache_ok(self):
        tree = self.make(apache_tree)
        tree.write("py/pyproject.toml", '[project]\nname = "p"\nlicense = "Apache-2.0"\n')
        self.assertEqual(self.check(tree), [])

    def test_csproj_dual_license(self):
        tree = self.make(apache_tree)
        tree.write(
            "cs/A.csproj",
            "<Project><PropertyGroup>"
            "<PackageLicenseExpression>MIT OR Apache-2.0</PackageLicenseExpression>"
            "</PropertyGroup></Project>",
        )
        self.assertViolation(self.check(tree), "cs/A.csproj")

    def test_csproj_apache_ok(self):
        tree = self.make(apache_tree)
        tree.write(
            "cs/A.csproj",
            "<Project><PropertyGroup>"
            "<PackageLicenseExpression>Apache-2.0</PackageLicenseExpression>"
            "</PropertyGroup></Project>",
        )
        self.assertEqual(self.check(tree), [])

    def test_readme_mentions_mit(self):
        tree = self.make(apache_tree)
        tree.write("README.md", "Licensed under either of Apache-2.0 or MIT License\n")
        self.assertViolation(self.check(tree), "README.md")

    def test_readme_links_removed_license_files(self):
        tree = self.make(apache_tree)
        tree.write("README.md", "See [LICENSE-APACHE](LICENSE-APACHE)\n")
        self.assertViolation(self.check(tree), "README.md")


class CliTest(CheckerTestCase):
    def run_cli(self, tree, policy):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(tree.root), "--policy", policy],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_exit_zero_when_clean(self):
        result = self.run_cli(self.make(proprietary_tree), "proprietary")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_exit_nonzero_and_reports_violation(self):
        tree = self.make(proprietary_tree)
        (tree.root / "LICENSE").unlink()
        result = self.run_cli(tree, "proprietary")
        self.assertEqual(result.returncode, 1)
        self.assertIn("LICENSE", result.stderr)

    def test_unknown_policy_is_usage_error(self):
        result = self.run_cli(self.make(proprietary_tree), "gpl")
        self.assertEqual(result.returncode, 2)


class RealRepoTest(unittest.TestCase):
    def test_this_repository_matches_its_declared_policy(self):
        violations = load_module().check(REPO_ROOT, REPO_POLICY)
        self.assertEqual(violations, [], "\n".join(violations))


if __name__ == "__main__":
    unittest.main()
