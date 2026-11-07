"""A fake device that models the volatile safety state, so ``apply_safety``
can be read back. Its ``safety`` / ``excl get`` / ``rstinfo`` / ``pads``
lines use exactly the shapes of ``protocol/golden/safety.txt`` (a
conformance test in ``test_safety_connection.py`` pins that), and ``ping``
answers ``pong`` like the golden ``ping`` exchange."""

from __future__ import annotations

from .fake_port import FakePort
from .golden import first_response

VERSION_RESPONSE = first_response("version-info", "version")[0]


class SafetyDevice:
    """Replies to the safety commands. ``fail_on`` makes every command that
    starts with it answer ``ERR BAD_PARAM`` (the device refuses it)."""

    def __init__(
        self,
        *,
        groups: list[int] | None = None,
        wdog_ms: int = 0,
        usbsafe: bool = False,
        fail_on: str | None = None,
        lie: bool = False,
        lie_usbsafe: bool = False,
        excl_get_extra: int = 0,
    ) -> None:
        self.groups = list(groups or [])
        self.wdog_ms = wdog_ms
        self.usbsafe = usbsafe
        self.fail_on = fail_on
        #: Report a wrong ``wdog_ms`` and a wrong first group in the read-back.
        self.lie = lie
        #: Report the opposite ``usbsafe`` in ``safety`` only.
        self.lie_usbsafe = lie_usbsafe
        #: ``excl get`` returns this many groups more (positive) or fewer
        #: (negative) than were set, while ``safety`` reports ``excl=`` truthfully.
        self.excl_get_extra = excl_get_extra
        self.port = FakePort()
        self.port.on_command = self._on_command

    # --- the lines ---

    def safety_line(self) -> str:
        return (
            f"OK wdog_ms={self.wdog_ms + int(self.lie)} remaining_ms={self.wdog_ms} "
            f"failsafe=0 cause=none usbsafe={int(self.usbsafe != self.lie_usbsafe)} "
            f"excl={len(self.groups)}"
        )

    def excl_get_lines(self) -> list[str]:
        masks = [
            m ^ 0x100 if self.lie and i == 0 else m for i, m in enumerate(self.groups)
        ]
        if self.excl_get_extra >= 0:
            masks += [0x3] * self.excl_get_extra
        else:
            masks = masks[: max(len(masks) + self.excl_get_extra, 0)]
        return [f"OK count={len(masks)}", *(f"  mask=0x{m:08x}" for m in masks)]

    # --- command handling ---

    def _on_command(self, line: str) -> None:
        port = self.port
        if line == "version":
            port.feed(VERSION_RESPONSE)
            return
        if self.fail_on is not None and line.startswith(self.fail_on):
            port.feed("ERR BAD_PARAM")
            return
        words = line.split()
        if words[:2] == ["excl", "set"]:
            self.groups = [int(w, 16) for w in words[2:]]
            port.feed("OK")
        elif words[:2] == ["excl", "clear"]:
            self.groups = []
            port.feed("OK")
        elif words[:1] == ["usbsafe"]:
            self.usbsafe = words[1] == "on"
            port.feed("OK")
        elif words[:1] == ["wdog"]:
            self.wdog_ms = int(words[1])
            port.feed("OK")
        elif words == ["safety"]:
            port.feed(self.safety_line())
        elif words == ["excl", "get"]:
            port.feed(*self.excl_get_lines())
        elif words[:1] == ["ping"]:
            port.feed(f"OK pong={words[1]}")
        else:
            port.feed("ERR UNKNOWN_CMD")

    @property
    def commands(self) -> list[str]:
        return list(self.port.written)
