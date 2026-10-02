"""Discovery (docs/sdk-api-design.md section 3): USB filter, probing with
``version`` (proto=2 required) then ``info``, selection helpers."""

import pytest

import pochi.discovery as discovery
from pochi.errors import (
    MultipleDevicesError,
    NoDeviceError,
    UnsupportedFirmwareError,
)
from pochi.transport import Transport
from pochi.types import DeviceInfo

from .fake_port import FakePort
from .golden import ReplayPort, find_case


class TestMatchesPochi:
    def test_pochi_product(self):
        assert discovery.matches_pochi(0x2E8A, 0x000A, "Pochi-DIO")
        assert discovery.matches_pochi(0x2E8A, 0x000A, "Pochi")

    def test_missing_product_string_is_accepted_when_vid_pid_match(self):
        # "if the operating system provides a product string, it starts with Pochi"
        assert discovery.matches_pochi(0x2E8A, 0x000A, None)

    @pytest.mark.parametrize(
        "product", ["Tachyon-DIO", "Tachyon", "Debugprobe", "pochi", ""]
    )
    def test_other_product_names_are_rejected(self, product):
        assert not discovery.matches_pochi(0x2E8A, 0x000A, product)

    @pytest.mark.parametrize(
        "vid,pid",
        [(0x2E8A, 0x000C), (0x1234, 0x000A), (None, None), (0x2E8A, None)],
    )
    def test_vid_pid_must_match(self, vid, pid):
        assert not discovery.matches_pochi(vid, pid, "Pochi-DIO")


def patch_transport(monkeypatch, ports: dict[str, FakePort]):
    monkeypatch.setattr(
        Transport,
        "open",
        classmethod(lambda cls, path: Transport(ports[path])),
    )


class TestProbe:
    def test_probe_requires_proto_2_then_reads_info(self, monkeypatch):
        port = ReplayPort(
            find_case("version-info", "info: factory state has no device number")
        )
        patch_transport(monkeypatch, {"/dev/ttyACM0": port})
        info = discovery.probe("/dev/ttyACM0")
        assert info == DeviceInfo(
            uid="0000000000000000",
            device_number=None,
            port="/dev/ttyACM0",
            version="0.1.3",
        )
        assert port.written == ["version", "info"]  # version first (R-U2)
        assert port.closed
        assert port.mismatches == []

    def test_discover_detailed_reports_non_v2_device_as_failure(self, monkeypatch):
        # NEGATIVE: a device that answers `version` with another protocol
        old = FakePort()
        old.on_command = lambda _: old.feed("OK fw=0.1.3 proto=1")
        good = ReplayPort(
            find_case("version-info", "info: factory state has no device number")
        )
        patch_transport(monkeypatch, {"/dev/ttyACM0": old, "/dev/ttyACM1": good})
        monkeypatch.setattr(
            discovery, "enumerate_ports", lambda: ["/dev/ttyACM0", "/dev/ttyACM1"]
        )
        result = discovery.discover_detailed()
        assert [d.port for d in result.devices] == ["/dev/ttyACM1"]
        assert [f.port for f in result.failures] == ["/dev/ttyACM0"]
        assert isinstance(result.failures[0].error, UnsupportedFirmwareError)
        assert old.written == ["version"]  # never asked for `info`
        assert old.closed


class TestSelection:
    DEVICES = [
        DeviceInfo("AAAA", 1, "/dev/ttyACM0", "0.1.3"),
        DeviceInfo("BBBB", 2, "/dev/ttyACM1", "0.1.3"),
        DeviceInfo("CCCC", 2, "/dev/ttyACM2", "0.1.3"),
    ]

    def test_find_by_uid_is_case_insensitive(self):
        assert discovery.find_by_uid(self.DEVICES, "aaaa").port == "/dev/ttyACM0"
        with pytest.raises(NoDeviceError):
            discovery.find_by_uid(self.DEVICES, "ZZZZ")

    def test_find_by_device_number(self):
        assert discovery.find_by_device_number(self.DEVICES, 1).uid == "AAAA"
        with pytest.raises(MultipleDevicesError):
            discovery.find_by_device_number(self.DEVICES, 2)
        with pytest.raises(NoDeviceError):
            discovery.find_by_device_number(self.DEVICES, 9)

    def test_sole_device(self):
        assert discovery.select_sole_device(self.DEVICES[:1]).uid == "AAAA"
        with pytest.raises(NoDeviceError):
            discovery.select_sole_device([])
        with pytest.raises(MultipleDevicesError):
            discovery.select_sole_device(self.DEVICES)

    def test_duplicate_numbers(self):
        assert discovery.find_duplicate_numbers(self.DEVICES) == [2]
