//! In-memory fake device for unit tests.
//!
//! The host side is a [`HostReader`] / [`HostWriter`] pair that plugs into
//! `Transport::from_io`; the device side is a thread that feeds every command
//! line to a handler closure and writes back whatever lines it returns.
//! Nothing here touches a PTY or a serial driver, so tests are deterministic
//! on every platform.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// How long either side waits for bytes before reporting "no data yet".
const POLL: Duration = Duration::from_millis(10);

/// Host-side read half: yields bytes the fake device wrote, `TimedOut` when
/// there are none yet, and EOF once the device is gone.
pub(crate) struct HostReader {
    rx: Receiver<Vec<u8>>,
    pending: VecDeque<u8>,
}

impl Read for HostReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.pending.is_empty() {
            match self.rx.recv_timeout(POLL) {
                Ok(bytes) => self.pending.extend(bytes),
                Err(RecvTimeoutError::Timeout) => return Err(io::ErrorKind::TimedOut.into()),
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len());
        for (slot, byte) in buf.iter_mut().zip(self.pending.drain(..n)) {
            *slot = byte;
        }
        Ok(n)
    }
}

/// Host-side write half: delivers bytes to the fake device.
pub(crate) struct HostWriter {
    tx: Sender<Vec<u8>>,
}

impl Write for HostWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.tx
            .send(buf.to_vec())
            .map_err(|_| io::ErrorKind::BrokenPipe)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The scripted device end.
pub(crate) struct FakeDevice {
    to_host: Sender<Vec<u8>>,
    commands: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl FakeDevice {
    /// Start a device. `handler` receives each command line (without the
    /// line ending) and returns the lines to answer with; an empty vector
    /// means silence.
    pub(crate) fn spawn(
        mut handler: impl FnMut(&str) -> Vec<String> + Send + 'static,
    ) -> (HostReader, HostWriter, Self) {
        let (to_host, host_rx) = mpsc::channel::<Vec<u8>>();
        let (host_tx, from_host) = mpsc::channel::<Vec<u8>>();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));

        let thread = std::thread::spawn({
            let to_host = to_host.clone();
            let commands = Arc::clone(&commands);
            let stop = Arc::clone(&stop);
            move || {
                let mut acc: Vec<u8> = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    match from_host.recv_timeout(POLL) {
                        Ok(bytes) => acc.extend(bytes),
                        Err(RecvTimeoutError::Timeout) => continue,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                    while let Some(pos) = acc.iter().position(|&b| b == b'\n') {
                        let raw: Vec<u8> = acc.drain(..=pos).collect();
                        let line = String::from_utf8_lossy(&raw)
                            .trim_end_matches(['\r', '\n'])
                            .to_string();
                        if line.is_empty() {
                            continue;
                        }
                        commands.lock().expect("commands").push(line.clone());
                        let reply: String =
                            handler(&line).iter().map(|l| format!("{l}\r\n")).collect();
                        if !reply.is_empty() {
                            let _ = to_host.send(reply.into_bytes());
                        }
                    }
                }
            }
        });

        let reader = HostReader {
            rx: host_rx,
            pending: VecDeque::new(),
        };
        let writer = HostWriter { tx: host_tx };
        let device = Self {
            to_host,
            commands,
            stop,
            thread: Some(thread),
        };
        (reader, writer, device)
    }

    /// Send an unsolicited line (push event, stale response, garbage).
    pub(crate) fn inject(&self, line: &str) {
        self.inject_raw(format!("{line}\r\n").as_bytes());
    }

    /// Send raw bytes (for partial-line tests).
    pub(crate) fn inject_raw(&self, bytes: &[u8]) {
        self.to_host.send(bytes.to_vec()).expect("host reader gone");
    }

    /// Every command line received so far, in order.
    pub(crate) fn commands(&self) -> Vec<String> {
        self.commands.lock().expect("commands").clone()
    }
}

impl Drop for FakeDevice {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

/// `OK pong=<n>` for a `ping <n>` command, `None` for anything else.
pub(crate) fn pong_for(cmd: &str) -> Option<Vec<String>> {
    cmd.strip_prefix("ping ")
        .map(|n| vec![format!("OK pong={n}")])
}
