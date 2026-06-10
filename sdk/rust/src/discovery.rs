//! Device discovery: USB enumeration, probing, and selection.

use serialport::SerialPortType;

use crate::error::{Result, SdkError};
use crate::protocol;
use crate::transport::Transport;
use crate::types::DeviceInfo;

const POCHI_VID: u16 = 0x2E8A;
const POCHI_PID: u16 = 0x000A;

/// A port that matched the USB filter but could not be probed.
#[derive(Debug)]
pub struct ProbeFailure {
    pub port: String,
    pub error: SdkError,
}

/// Full discovery outcome, including ports that failed to respond.
#[derive(Debug, Default)]
pub struct Discovery {
    pub devices: Vec<DeviceInfo>,
    /// Matching ports that could not be opened or probed (e.g. held open
    /// by another process). Not fatal for the scan as a whole.
    pub failures: Vec<ProbeFailure>,
}

/// Return true if the USB descriptor identifies a Pochi-DIO.
///
/// The legacy "Tachyon" product string is accepted: devices in the field
/// may still run pre-rename firmware.
fn matches_pochi(info: &serialport::UsbPortInfo) -> bool {
    info.vid == POCHI_VID
        && info.pid == POCHI_PID
        && info
            .product
            .as_ref()
            .is_some_and(|p| p.starts_with("Pochi") || p.starts_with("Tachyon"))
}

/// List serial port paths whose USB descriptors match a Pochi-DIO
/// (VID 0x2E8A / PID 0x000A / product "Pochi*", legacy "Tachyon*").
/// No ports are opened. Results are sorted by port path: the OS
/// enumeration order is unspecified, and callers rely on a deterministic
/// device order.
pub fn enumerate_ports() -> Result<Vec<String>> {
    let ports = serialport::available_ports()?;
    let mut matched: Vec<String> = ports
        .into_iter()
        .filter_map(|port| match &port.port_type {
            SerialPortType::UsbPort(info) if matches_pochi(info) => Some(port.port_name),
            _ => None,
        })
        .collect();
    matched.sort();
    Ok(matched)
}

/// Probe one port: open it and query `info` (and best-effort `version`).
pub fn probe(port_path: &str) -> Result<DeviceInfo> {
    let mut transport = Transport::open(port_path)?;
    let data = transport.command("info")?;
    let (uid, device_number) = protocol::parse_info(&data)?;

    // Version is informational; an old or odd firmware should not make the
    // device invisible to discovery.
    let version = transport
        .command("version")
        .ok()
        .and_then(|d| d.split_whitespace().next().map(str::to_string));

    Ok(DeviceInfo {
        uid,
        device_number,
        port: port_path.to_string(),
        version,
    })
}

/// Enumerate and probe all connected Pochi-DIO devices, reporting probe
/// failures alongside successes.
pub fn discover_detailed() -> Result<Discovery> {
    let mut result = Discovery::default();
    for port in enumerate_ports()? {
        match probe(&port) {
            Ok(info) => result.devices.push(info),
            Err(error) => result.failures.push(ProbeFailure { port, error }),
        }
    }
    Ok(result)
}

/// Enumerate and probe all connected Pochi-DIO devices.
///
/// Convenience wrapper over [`discover_detailed`] that returns devices
/// only; use the detailed variant to inspect per-port probe failures.
pub fn discover() -> Result<Vec<DeviceInfo>> {
    Ok(discover_detailed()?.devices)
}

/// Find the device with the given UID (case-insensitive).
pub fn find_by_uid(devices: &[DeviceInfo], uid: &str) -> Result<DeviceInfo> {
    let uid_upper = uid.to_uppercase();
    devices
        .iter()
        .find(|d| d.uid.to_uppercase() == uid_upper)
        .cloned()
        .ok_or(SdkError::NoDevice)
}

/// Find the device with the given device number. Duplicate numbers are a
/// user-configuration conflict and reported as `MultipleDevices`.
pub fn find_by_device_number(devices: &[DeviceInfo], n: u8) -> Result<DeviceInfo> {
    let matches: Vec<&DeviceInfo> = devices
        .iter()
        .filter(|d| d.device_number == Some(n))
        .collect();
    match matches.len() {
        0 => Err(SdkError::NoDevice),
        1 => Ok(matches[0].clone()),
        _ => Err(SdkError::MultipleDevices),
    }
}

/// Select the only device, erroring when there are zero or several.
pub fn select_sole_device(devices: &[DeviceInfo]) -> Result<DeviceInfo> {
    match devices.len() {
        0 => Err(SdkError::NoDevice),
        1 => Ok(devices[0].clone()),
        _ => Err(SdkError::MultipleDevices),
    }
}

/// Device numbers assigned to more than one device.
pub fn find_duplicate_numbers(devices: &[DeviceInfo]) -> Vec<u8> {
    let mut seen = std::collections::HashMap::new();
    let mut duplicates = Vec::new();
    for dev in devices {
        if let Some(num) = dev.device_number {
            let count = seen.entry(num).or_insert(0u32);
            *count += 1;
            if *count == 2 {
                duplicates.push(num);
            }
        }
    }
    duplicates
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(uid: &str, devnum: Option<u8>, port: &str) -> DeviceInfo {
        DeviceInfo {
            uid: uid.to_string(),
            device_number: devnum,
            port: port.to_string(),
            version: Some("v0.1.0".to_string()),
        }
    }

    #[test]
    fn usb_filter_accepts_pochi_and_tachyon() {
        let info = |vid, pid, product: Option<&str>| serialport::UsbPortInfo {
            vid,
            pid,
            serial_number: None,
            manufacturer: None,
            product: product.map(str::to_string),
        };
        assert!(matches_pochi(&info(0x2E8A, 0x000A, Some("Pochi-DIO"))));
        assert!(matches_pochi(&info(0x2E8A, 0x000A, Some("Tachyon-DIO"))));
        // Debugprobe: same VID, different PID — must NOT match.
        assert!(!matches_pochi(&info(0x2E8A, 0x000C, Some("Debugprobe"))));
        assert!(!matches_pochi(&info(0x2E8A, 0x000A, Some("Other"))));
        assert!(!matches_pochi(&info(0x2E8A, 0x000A, None)));
        assert!(!matches_pochi(&info(0x1234, 0x000A, Some("Pochi-DIO"))));
    }

    #[test]
    fn by_uid_case_insensitive() {
        let devices = vec![dev("AABB", Some(1), "/dev/ttyACM0")];
        assert_eq!(find_by_uid(&devices, "aabb").unwrap().uid, "AABB");
        assert!(matches!(
            find_by_uid(&devices, "CCDD"),
            Err(SdkError::NoDevice)
        ));
    }

    #[test]
    fn by_device_number() {
        let devices = vec![
            dev("AABB", Some(1), "/dev/ttyACM0"),
            dev("CCDD", Some(2), "/dev/ttyACM1"),
        ];
        assert_eq!(find_by_device_number(&devices, 2).unwrap().uid, "CCDD");
        assert!(matches!(
            find_by_device_number(&devices, 9),
            Err(SdkError::NoDevice)
        ));
    }

    #[test]
    fn by_device_number_duplicate_conflict() {
        let devices = vec![
            dev("AABB", Some(1), "/dev/ttyACM0"),
            dev("CCDD", Some(1), "/dev/ttyACM1"),
        ];
        assert!(matches!(
            find_by_device_number(&devices, 1),
            Err(SdkError::MultipleDevices)
        ));
    }

    #[test]
    fn sole_device_selection() {
        assert!(matches!(select_sole_device(&[]), Err(SdkError::NoDevice)));
        let one = vec![dev("AABB", None, "/dev/ttyACM0")];
        assert_eq!(select_sole_device(&one).unwrap().uid, "AABB");
        let two = vec![
            dev("AABB", Some(1), "/dev/ttyACM0"),
            dev("CCDD", Some(2), "/dev/ttyACM1"),
        ];
        assert!(matches!(
            select_sole_device(&two),
            Err(SdkError::MultipleDevices)
        ));
    }

    #[test]
    fn duplicate_numbers_detected() {
        let devices = vec![
            dev("A", Some(1), "a"),
            dev("B", Some(1), "b"),
            dev("C", Some(2), "c"),
            dev("D", None, "d"),
        ];
        assert_eq!(find_duplicate_numbers(&devices), vec![1]);
        assert!(find_duplicate_numbers(&devices[2..]).is_empty());
    }
}
