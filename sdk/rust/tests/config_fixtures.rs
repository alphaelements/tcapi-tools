//! The SDK's `config` parsers against every shared fixture in
//! `docs/fixtures/` (R-TOML1/R-TOML2): the evaluated masks / steps, the exact
//! error message and the reported line must equal the fixture's `# expected*`
//! comments.

use std::fs;
use std::path::PathBuf;

use tcapi_sdk::config::{
    load_map, load_pattern, load_safety, parse_map, parse_pattern, parse_safety, ConfigError,
};
use tcapi_sdk::{PatternStep, PinMap, SafetyConfig, SdkError, VALID_DIO_MASK};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/fixtures")
}

fn fixture_names() -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(fixtures_dir())
        .expect("docs/fixtures must exist")
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".toml"))
        .collect();
    names.sort();
    assert!(names.len() >= 50, "fixture set looks truncated");
    names
}

fn annotations(src: &str, key: &str) -> Vec<String> {
    let prefix = format!("# {key}:");
    src.lines()
        .filter_map(|l| l.strip_prefix(&prefix))
        .map(|v| v.trim().to_string())
        .collect()
}

/// `dir=0x... pull_up=0x... ...` in the fixture's `# expected:` order.
fn map_summary(m: &PinMap) -> String {
    format!(
        "dir=0x{:08x} pull_up=0x{:08x} pull_down=0x{:08x} out_default=0x{:08x} \
         out_polarity=0x{:08x} in_polarity=0x{:08x} edge=0x{:08x}",
        m.direction, m.pull_up, m.pull_down, m.out_default, m.out_polarity, m.in_polarity, m.edge
    )
}

/// `watchdog_ms=800 usbsafe=1 groups=0x0000000c,0x00000018` in the fixture's
/// `# expected:` form.
fn safety_summary(c: &SafetyConfig) -> String {
    let groups = if c.groups.is_empty() {
        "none".to_string()
    } else {
        let masks: Vec<_> = c.groups.iter().map(|m| format!("0x{m:08x}")).collect();
        masks.join(",")
    };
    format!(
        "watchdog_ms={} usbsafe={} groups={groups}",
        c.watchdog_ms,
        u8::from(c.usbsafe)
    )
}

fn step_summary(s: &PatternStep) -> String {
    format!("out_bits=0x{:08x} hold_ticks={}", s.out_bits, s.hold_ticks)
}

fn expect_error(name: &str, src: &str, err: &ConfigError) {
    let exact = annotations(src, "expected_error");
    let prefix = annotations(src, "expected_error_prefix");
    assert_eq!(
        exact.len() + prefix.len(),
        1,
        "{name}: one error annotation only"
    );
    match (exact.first(), prefix.first()) {
        (Some(e), _) => assert_eq!(&err.message, e, "{name}"),
        (_, Some(p)) => assert!(
            err.message.starts_with(p.as_str()),
            "{name}: {}",
            err.message
        ),
        _ => unreachable!(),
    }
    let want: usize = annotations(src, "expected_line")[0].parse().unwrap();
    assert_eq!(err.line, want, "{name}: line");
    assert_eq!(err.file, name);
    assert_eq!(
        err.to_string(),
        format!("{name}:{}: {}", err.line, err.message)
    );
}

#[test]
fn every_fixture_gives_the_documented_result() {
    let mut valid = 0;
    let mut invalid = 0;
    for name in &fixture_names() {
        let src = fs::read_to_string(fixtures_dir().join(name)).unwrap();
        let has_error = !annotations(&src, "expected_error").is_empty()
            || !annotations(&src, "expected_error_prefix").is_empty();
        if name.starts_with("map-") {
            match parse_map(&src, name) {
                Ok(map) => {
                    assert!(!has_error, "{name}: expected an error, parsing succeeded");
                    let expected = annotations(&src, "expected");
                    assert_eq!(expected, [map_summary(&map)], "{name}");
                    // Every accepted file is a map the device accepts.
                    map.validate().unwrap_or_else(|e| panic!("{name}: {e}"));
                    assert_eq!(map.flags, 0, "{name}");
                    valid += 1;
                }
                Err(err) => {
                    assert!(has_error, "{name}: unexpected error {err}");
                    expect_error(name, &src, &err);
                    invalid += 1;
                }
            }
        } else if name.starts_with("safety-") {
            match parse_safety(&src, name) {
                Ok(cfg) => {
                    assert!(!has_error, "{name}: expected an error, parsing succeeded");
                    assert_eq!(
                        annotations(&src, "expected"),
                        [safety_summary(&cfg)],
                        "{name}"
                    );
                    // DD-16: the apply order of the evaluated file.
                    assert_eq!(
                        cfg.commands().unwrap(),
                        annotations(&src, "expected_command"),
                        "{name}: apply commands"
                    );
                    valid += 1;
                }
                Err(err) => {
                    assert!(has_error, "{name}: unexpected error {err}");
                    expect_error(name, &src, &err);
                    invalid += 1;
                }
            }
        } else {
            assert!(name.starts_with("pattern-"), "{name}: unexpected fixture");
            match parse_pattern(&src, name) {
                Ok(steps) => {
                    assert!(!has_error, "{name}: expected an error, parsing succeeded");
                    let got: Vec<String> = steps.iter().map(step_summary).collect();
                    assert_eq!(got, annotations(&src, "expected_step"), "{name}");
                    for step in &steps {
                        step.validate().unwrap_or_else(|e| panic!("{name}: {e}"));
                    }
                    valid += 1;
                }
                Err(err) => {
                    assert!(has_error, "{name}: unexpected error {err}");
                    expect_error(name, &src, &err);
                    invalid += 1;
                }
            }
        }
    }
    assert!(
        valid >= 18 && invalid >= 70,
        "valid={valid} invalid={invalid}"
    );
}

#[test]
fn an_empty_map_file_with_only_the_version_is_the_default_map() {
    let map = parse_map("version = 2\n", "m.toml").unwrap();
    assert_eq!(map, PinMap::default());
    assert_eq!(map.pull_down, VALID_DIO_MASK);
}

#[test]
fn a_map_pin_listed_with_no_keys_equals_an_unlisted_pin() {
    let map = parse_map("version = 2\n[pins]\nGP3 = {}\n", "m.toml").unwrap();
    assert_eq!(map, PinMap::default());
}

#[test]
fn map_parser_rejects_pattern_keys_and_vice_versa() {
    let err = parse_map("version = 2\n[[step]]\nout = []\nhold = 1\n", "m.toml").unwrap_err();
    assert_eq!(err.message, "unknown key \"step\"");
    assert_eq!(err.line, 2);
    let err = parse_pattern("version = 2\n[pins]\n", "p.toml").unwrap_err();
    assert_eq!(err.message, "unknown key \"pins\"");
}

#[test]
fn utf8_garbage_and_empty_input_are_errors_not_defaults() {
    let err = parse_map("", "m.toml").unwrap_err();
    assert_eq!(
        (err.message.as_str(), err.line),
        ("missing key \"version\"", 1)
    );
    let err = parse_pattern("", "p.toml").unwrap_err();
    assert_eq!(err.message, "missing key \"version\"");
    let err = parse_pattern("version = 2\nunit = \n", "p.toml").unwrap_err();
    assert!(err.message.starts_with("toml syntax: "));
    assert_eq!(err.line, 2);
}

#[test]
fn config_errors_convert_to_a_parse_sdk_error_with_the_position() {
    let err = parse_map("version = 1\n", "m.toml").unwrap_err();
    match SdkError::from(err) {
        SdkError::Parse(m) => assert_eq!(m, "m.toml:1: unsupported version: expected 2, got 1"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn load_reads_files_and_names_them_in_errors() {
    let dir = fixtures_dir();
    let map = load_map(&dir.join("map-mixed-io.toml")).unwrap();
    assert_ne!(map, PinMap::default());
    let steps = load_pattern(&dir.join("pattern-basic.toml")).unwrap();
    assert!(!steps.is_empty());

    match load_map(&dir.join("map-bad-dir.toml")).unwrap_err() {
        SdkError::Parse(m) => assert!(m.contains("map-bad-dir.toml:"), "{m}"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        load_map(&dir.join("no-such-file.toml")).unwrap_err(),
        SdkError::Io(_)
    ));
}

#[test]
fn safety_parser_defaults_are_all_off() {
    let cfg = parse_safety("version = 2\n", "s.toml").unwrap();
    assert_eq!(cfg, SafetyConfig::default());
    assert_eq!(cfg.watchdog_ms, 0);
    assert!(!cfg.usbsafe);
    assert!(cfg.groups.is_empty());
}

#[test]
fn safety_parser_rejects_map_keys_and_the_map_parser_rejects_safety_keys() {
    let err = parse_safety("version = 2\n[pins]\n", "s.toml").unwrap_err();
    assert_eq!(err.message, "unknown key \"pins\"");
    let err = parse_map("version = 2\n[watchdog]\ntimeout_ms = 500\n", "m.toml").unwrap_err();
    assert_eq!(err.message, "unknown key \"watchdog\"");
    assert_eq!(err.line, 2);
}

#[test]
fn safety_parser_empty_input_and_garbage_are_errors_not_defaults() {
    let err = parse_safety("", "s.toml").unwrap_err();
    assert_eq!(
        (err.message.as_str(), err.line),
        ("missing key \"version\"", 1)
    );
    let err = parse_safety("version = 2\nwatchdog = \n", "s.toml").unwrap_err();
    assert!(err.message.starts_with("toml syntax: "));
    assert_eq!(err.line, 2);
}

#[test]
fn safety_group_masks_follow_the_pin_names() {
    let cfg = parse_safety(
        "version = 2\n[[exclusive]]\npins = [\"GP26\", \"GP0\", \"GP27\"]\n",
        "s.toml",
    )
    .unwrap();
    assert_eq!(cfg.groups, [1 | (1 << 26) | (1 << 27)]);
}

#[test]
fn load_safety_reads_files_and_names_them_in_errors() {
    let dir = fixtures_dir();
    let cfg = load_safety(&dir.join("safety-full.toml")).unwrap();
    assert_eq!(cfg.watchdog_ms, 800);
    match load_safety(&dir.join("safety-pin-duplicate.toml")).unwrap_err() {
        SdkError::Parse(m) => assert!(m.contains("safety-pin-duplicate.toml:"), "{m}"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        load_safety(&dir.join("no-such-file.toml")).unwrap_err(),
        SdkError::Io(_)
    ));
}
