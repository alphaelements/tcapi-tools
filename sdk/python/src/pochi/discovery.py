"""Device discovery: USB enumeration, probing, and selection.
Mirrors ``sdk/rust/src/discovery.rs``."""

from __future__ import annotations

from dataclasses import dataclass, field

from serial.tools import list_ports

from .errors import MultipleDevicesError, NoDeviceError, SdkError
from .protocol import parse_info
from .transport import Transport
from .types import DeviceInfo

_POCHI_VID = 0x2E8A
_POCHI_PID = 0x000A


@dataclass
class ProbeFailure:
    """A port that matched the USB filter but could not be probed."""

    port: str
    error: SdkError


@dataclass
class Discovery:
    """Full discovery outcome, including ports that failed to respond."""

    devices: list[DeviceInfo] = field(default_factory=list)
    #: Matching ports that could not be opened or probed (e.g. held open
    #: by another process). Not fatal for the scan as a whole.
    failures: list[ProbeFailure] = field(default_factory=list)


def matches_pochi(vid: int | None, pid: int | None, product: str | None) -> bool:
    """True if the USB descriptor identifies a Pochi-DIO. The legacy
    "Tachyon" product string is accepted: devices in the field may still
    run pre-rename firmware."""
    if vid != _POCHI_VID or pid != _POCHI_PID:
        return False
    if product is None:
        return False
    return product.startswith(("Pochi", "Tachyon"))


def enumerate_ports() -> list[str]:
    """List serial port paths whose USB descriptors match a Pochi-DIO
    (VID 0x2E8A / PID 0x000A / product "Pochi*", legacy "Tachyon*").
    No ports are opened. Results are sorted by port path: the OS
    enumeration order is unspecified, and callers rely on a deterministic
    device order."""
    return sorted(
        info.device
        for info in list_ports.comports()
        if matches_pochi(info.vid, info.pid, info.product)
    )


def probe(port_path: str) -> DeviceInfo:
    """Probe one port: open it and query ``info`` (best-effort ``version``)."""
    with Transport.open(port_path) as transport:
        uid, device_number = parse_info(transport.command("info"))

        # Version is informational; an old or odd firmware should not make
        # the device invisible to discovery.
        version: str | None
        try:
            version = transport.command("version").split()[0]
        except (SdkError, IndexError):
            version = None

        return DeviceInfo(
            uid=uid, device_number=device_number, port=port_path, version=version
        )


def discover_detailed() -> Discovery:
    """Enumerate and probe all connected Pochi-DIO devices, reporting
    probe failures alongside successes."""
    result = Discovery()
    for port in enumerate_ports():
        try:
            result.devices.append(probe(port))
        except SdkError as error:
            result.failures.append(ProbeFailure(port=port, error=error))
    return result


def discover() -> list[DeviceInfo]:
    """Enumerate and probe all connected Pochi-DIO devices. Convenience
    wrapper over :func:`discover_detailed` (devices only)."""
    return discover_detailed().devices


def find_by_uid(devices: list[DeviceInfo], uid: str) -> DeviceInfo:
    """Find the device with the given UID (case-insensitive)."""
    upper = uid.upper()
    for device in devices:
        if device.uid.upper() == upper:
            return device
    raise NoDeviceError(f"no Pochi-DIO device with UID {uid}")


def find_by_device_number(devices: list[DeviceInfo], n: int) -> DeviceInfo:
    """Find the device with the given device number. Duplicate numbers
    are a user-configuration conflict (MultipleDevicesError)."""
    matches = [d for d in devices if d.device_number == n]
    if not matches:
        raise NoDeviceError(f"no Pochi-DIO device with device number {n}")
    if len(matches) > 1:
        raise MultipleDevicesError(
            f"multiple devices with device number {n}; use UID or port"
        )
    return matches[0]


def select_sole_device(devices: list[DeviceInfo]) -> DeviceInfo:
    """Select the only device, erroring when there are zero or several."""
    if not devices:
        raise NoDeviceError("no Pochi-DIO device found")
    if len(devices) > 1:
        raise MultipleDevicesError(
            f"{len(devices)} Pochi-DIO devices found; specify UID, device number, or port"
        )
    return devices[0]


def find_duplicate_numbers(devices: list[DeviceInfo]) -> list[int]:
    """Device numbers assigned to more than one device."""
    seen: dict[int, int] = {}
    duplicates: list[int] = []
    for device in devices:
        if device.device_number is None:
            continue
        count = seen.get(device.device_number, 0) + 1
        seen[device.device_number] = count
        if count == 2:
            duplicates.append(device.device_number)
    return duplicates
