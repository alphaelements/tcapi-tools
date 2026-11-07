"""The declared safety settings of a ``safety.toml`` and how they are
applied (docs/config-files.md section 7, DD-16). Mirrors ``SafetyConfig`` of
``sdk/rust/src/types.rs``; reading the file is :mod:`pochi.config`, applying
it is :meth:`pochi.Connection.apply_safety`."""

from __future__ import annotations

from dataclasses import dataclass, field

from . import protocol
from .types import SafetyState


@dataclass
class SafetyConfig:
    """What the device must look like after ``apply_safety``. The all-off
    default is the content of a file with only ``version = 2``."""

    #: ``watchdog.timeout_ms``: ``0`` = disabled, otherwise ``100..=10000``.
    watchdog_ms: int = 0
    #: ``usb.safe``: ``usbsafe on`` when true.
    usbsafe: bool = False
    #: One pin mask per ``[[exclusive]]``, in file order (at most 16, each a
    #: subset of ``VALID_DIO_MASK`` with at least 2 bits).
    groups: list[int] = field(default_factory=list)

    def commands(self) -> list[str]:
        """The commands that make the device equal to this configuration, in
        the DD-16 order: ``excl set <masks>`` (or ``excl clear`` when there
        are no groups), ``usbsafe on|off``, ``wdog <ms>``.

        ``excl set`` replaces all groups atomically, so ``excl clear`` is
        sent only when there are no groups and never before an ``excl set``.
        The watchdog goes last so it cannot trip while the rest is still
        being sent. A value the device would refuse is an
        :class:`~pochi.errors.InvalidArgumentError` and nothing is
        produced."""
        excl = protocol.excl_set_command(self.groups) if self.groups else "excl clear"
        return [
            excl,
            protocol.usbsafe_command(self.usbsafe),
            protocol.wdog_command(self.watchdog_ms),
        ]

    def differences(self, state: SafetyState, groups: list[int]) -> list[str]:
        """Compare the read-back (``safety`` and ``excl get``) with this
        configuration: ``wdog_ms``, ``usbsafe``, the group count and the
        masks in file order. The latch (``failsafe`` / ``cause``) and
        ``remaining_ms`` are not part of the file and are not compared.
        Returns one text per difference (empty when equal)."""
        diffs: list[str] = []
        if state.wdog_ms != self.watchdog_ms:
            diffs.append(f"wdog_ms is {state.wdog_ms}, expected {self.watchdog_ms}")
        if state.usbsafe != self.usbsafe:
            diffs.append(
                f"usbsafe is {int(state.usbsafe)}, expected {int(self.usbsafe)}"
            )
        if state.excl != len(self.groups):
            diffs.append(f"excl is {state.excl}, expected {len(self.groups)}")
        if len(groups) != len(self.groups):
            diffs.append(
                f"excl get returned {len(groups)} groups, expected {len(self.groups)}"
            )
        for i, (got, want) in enumerate(zip(groups, self.groups, strict=False)):
            if got != want:
                diffs.append(f"group {i} is {got:#010x}, expected {want:#010x}")
        return diffs
