# Updating the Tcapi-DIO Firmware over USB

The firmware is updated with the USB cable only: no debug probe and no toolchain.
The device is put in BOOTSEL mode, a UF2 file is copied to the drive that appears,
and `tcapi version` confirms the new version.

## What a release contains

Every release is one directory, `tcapi-dio-<version>/`:

| File | Purpose |
|---|---|
| `tcapi-dio-<version>-<variant>.uf2` | The firmware image. `<variant>` is `unsigned`, `signed` or `signed-encrypted` (see "Secure boot") |
| `SHA256SUMS` | SHA-256 of every other file in the directory |
| `NOTICE` | What the files are, the version, the licensing statement |
| `LICENSE` | The notice that applies to the firmware itself: the firmware is proprietary (all rights reserved) |
| `THIRD-PARTY-LICENSES.txt` | The open-source components built into the firmware and their license texts. They stay under their own licenses |

Publish the same hashes in the release notes, so that a modified `SHA256SUMS` is
noticed.

## Before you start

- The device is **not running its firmware** while it is in BOOTSEL mode, and the
  pins have the chip's default state (not controlled, not yet measured). Take the
  load off the outputs (relays, actuators) before updating; do not rely on the
  pins during the update.
- Volatile settings (watchdog, exclusive groups, `usbsafe`, patterns, timestamps)
  are gone after the restart. The host re-applies them as after any restart
  (`protocol-reference.md`, "Persistent and volatile settings").
- Note the old version: `tcapi version`. To go back, install the old release's UF2
  with the same steps.

## 1. Check the files

```bash
cd tcapi-dio-<version>
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS
```

Every line must end in `OK`. On Windows (PowerShell):
`Get-FileHash .\tcapi-dio-<version>-<variant>.uf2 -Algorithm SHA256` and compare
the hash with the line in `SHA256SUMS`.

## 2. Enter BOOTSEL mode

Either:

- send the command: `tcapi bootsel` (asks for confirmation; `--yes` skips it). The
  device answers `OK`, disconnects and reappears as a USB drive named `RP2350`; or
- unplug the device, hold the **BOOTSEL** button, plug it in and release the button
  (use this when the firmware does not run).

## 3. Copy the UF2

Copy the file to the `RP2350` drive:

```bash
# Linux: the drive is usually mounted under /media/$USER/RP2350 or /run/media/$USER/RP2350
cp tcapi-dio-<version>-<variant>.uf2 /media/$USER/RP2350/ && sync
```

On Windows and macOS drag the file onto the drive. When the copy is complete the
drive disappears by itself and the device restarts with the new firmware; do not
unplug it before that. If the drive is not mounted automatically on Linux, mount it
by hand (`udisksctl mount -b /dev/disk/by-label/RP2350`).

`picotool load -v -x tcapi-dio-<version>-<variant>.uf2` does the same without a drive
(needs the BOOTSEL rule of the udev file, see the `tcapi-cli` README).

## 4. Check the result

```bash
tcapi list
tcapi version          # OK fw=<version> proto=2
tcapi info             # uid and device number
tcapi map show         # the current map
```

`fw=` must equal the release version. The saved pin map and the device number are
kept in the last flash sector, which is not part of a firmware image; a UF2 writes
only the blocks it contains. Compare `tcapi info` and `tcapi map show` with what you
noted before the update: that the settings survive an update has not yet been verified
on hardware.

If a reply of `tcapi version` shows `proto=` other than 2, the host tools refuse the
device (`unsupported firmware`): update the host tools to the matching release.

## Secure boot

A device whose boot ROM has secure boot enabled starts only a **signed** image:
use the `-signed` file. A `-signed-encrypted` file is for devices provisioned with the
decryption key. An `-unsigned` file is only for devices without secure boot; the boot ROM of a
secure-boot device does not start it. Which file belongs to which device is stated
in the release notes.

## If something goes wrong

| Symptom | What to do |
|---|---|
| No `RP2350` drive after `tcapi bootsel` | Wait a few seconds; mount it by hand (above); use the BOOTSEL button instead |
| The drive appears, but the old version is still reported | The copy was cut short or the file is not a UF2: repeat step 1, then copy again |
| The device does not enumerate after the update | Unplug and re-plug; enter BOOTSEL with the button and install the previous release |
| `sha256sum -c` fails | Do not install. Download the release again |
| Permission denied on `/dev/ttyACM0` | Install the udev rules (`tcapi-cli` README, "Linux Setup") |
