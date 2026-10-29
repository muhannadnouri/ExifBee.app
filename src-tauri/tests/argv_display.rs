//! Argument building and copyable command display (S2-T02): hostile names stay single literal
//! arguments, and the displayed command reproduces the executed argv exactly.

mod common;

use common::{fake_executable, fixture, system_exiftool, TempDir};
use exifbee_lib::adapter::exiftool::argv::{Args, ArgsError};
use exifbee_lib::adapter::exiftool::display::{display, Shell};
use exifbee_lib::adapter::exiftool::read::read_args;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Names that would break or hijack a command line if it were ever built as text.
fn hostile_names() -> Vec<&'static str> {
    vec![
        "plain.jpg",
        "with spaces.jpg",
        "it's.jpg",
        r#"say "cheese".jpg"#,
        "-rf --delete.jpg",
        "a:b:c.jpg",
        "x; rm -rf ~.jpg",
        "a & b | c > d.jpg",
        "$HOME ${PATH} $(touch pwned) `touch pwned2`.jpg",
        // Only "safe" characters plus one shell-special one: quoting must not be skipped here.
        "$HOME",
        "x$PWD.jpg",
        "~root",
        "a*b",
        "c?d",
        r"back\slash\\n.jpg",
        "glob*?[ab].jpg",
        "~tilde #hash !bang.jpg",
        "new\nline\ttab.jpg",
        "مرحبا 日本語 🐝.jpg",
        "‘curly’ ‚low‛ quotes.jpg",
        "",
    ]
}

/// A stand-in program that prints each argument it receives, NUL-terminated.
fn argv_printer(dir: &Path) -> PathBuf {
    fake_executable(
        dir,
        "print-argv",
        r#"for a in "$@"; do printf '%s\0' "$a"; done"#,
    )
}

fn run_in_shell(shell: &str, command: &str) -> Vec<String> {
    let output = Command::new(shell).args(["-c", command]).output().unwrap();
    assert!(
        output.status.success(),
        "{shell}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut args: Vec<String> = String::from_utf8(output.stdout)
        .unwrap()
        .split('\0')
        .map(String::from)
        .collect();
    args.pop(); // trailing terminator
    args
}

fn shells() -> Vec<&'static str> {
    ["/bin/sh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/dash"]
        .into_iter()
        .filter(|shell| Path::new(shell).exists())
        .collect()
}

// @req SEC-002, TST-007
#[test]
fn options_come_first_then_double_dash_then_absolute_files() {
    let args = Args::new()
        .options(&["-json", "-G1:4"])
        .files(["/photos/-rf.jpg", "/photos/a b.jpg"])
        .unwrap();
    let expected: Vec<OsString> = ["-json", "-G1:4", "--", "/photos/-rf.jpg", "/photos/a b.jpg"]
        .map(OsString::from)
        .into();
    assert_eq!(args.as_slice(), expected.as_slice());

    assert_eq!(
        Args::new().files(["-rf.jpg"]),
        Err(ArgsError::RelativeFile("-rf.jpg".into()))
    );
    let read = read_args(Path::new("/x/y.jpg")).unwrap();
    assert_eq!(read.as_slice().last().unwrap(), "/x/y.jpg");
    assert!(read.as_slice().contains(&OsString::from("--")));
}

// @req FR-015, SEC-002, NFR-005, TST-007
#[test]
fn posix_display_runs_exactly_the_executed_argv_in_real_shells() {
    let dir = TempDir::new("display-posix");
    // The program path itself is hostile too.
    let program_dir = dir.0.join("tools $(touch pwned) 'q'");
    std::fs::create_dir(&program_dir).unwrap();
    let printer = argv_printer(&program_dir);
    let args: Vec<OsString> = hostile_names()
        .into_iter()
        .map(|name| format!("/data/{name}").into())
        .chain(["-json".into(), "--".into()])
        .collect();

    let shown = display(Shell::Posix, &printer, &args);
    assert!(shown.exact);
    let expected: Vec<String> = args
        .iter()
        .map(|arg| arg.to_str().unwrap().to_string())
        .collect();
    for shell in shells() {
        assert_eq!(run_in_shell(shell, &shown.text), expected, "{shell}");
    }
    assert!(!dir.0.join("pwned").exists() && !Path::new("pwned").exists());
    assert!(!Path::new("pwned2").exists());
}

// @req FR-015, TST-007
#[test]
fn posix_display_round_trips_generated_hostile_strings() {
    // Deterministic pseudo-random strings over the characters shells care about.
    const ALPHABET: &[char] = &[
        'a', 'Z', '0', ' ', '\t', '\n', '\'', '"', '`', '$', '(', ')', '{', '}', '[', ']', '*',
        '?', '~', '#', '!', ';', '&', '|', '<', '>', '\\', '%', '^', '=', ':', ',', '.', '/', '-',
        '_', 'é', '日', '🐝', '‘', '’',
    ];
    let mut seed: u64 = 0x5eed_c0de;
    let mut next = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as usize
    };
    let strings: Vec<String> = (0..500)
        .map(|_| {
            (0..1 + next() % 24)
                .map(|_| ALPHABET[next() % ALPHABET.len()])
                .collect()
        })
        .collect();

    let dir = TempDir::new("display-fuzz");
    let printer = argv_printer(&dir.0);
    for chunk in strings.chunks(100) {
        let args: Vec<OsString> = chunk.iter().map(OsString::from).collect();
        let shown = display(Shell::Posix, &printer, &args);
        for shell in shells() {
            assert_eq!(run_in_shell(shell, &shown.text), chunk, "{shell}");
        }
    }
}

// @req FR-015, NFR-005
#[test]
fn displayed_read_command_reproduces_the_real_exiftool_read() {
    let tool = system_exiftool();
    let dir = TempDir::new("display-read");
    let hostile = dir.0.join("-it's $(touch pwned) & ‘x’\nnew.jpg");
    std::fs::copy(fixture("metadata.jpg"), &hostile).unwrap();
    let args = read_args(&hostile).unwrap();

    let direct = Command::new(&tool.path)
        .args(args.as_slice())
        .output()
        .unwrap();
    let shown = display(Shell::Posix, &tool.path, args.as_slice());
    let pasted = Command::new("/bin/sh")
        .args(["-c", &shown.text])
        .output()
        .unwrap();
    assert!(direct.status.success());
    assert_eq!(pasted.stdout, direct.stdout);
    assert!(String::from_utf8_lossy(&direct.stdout).contains("ExifBee EXIF Make"));
    assert!(!dir.0.join("pwned").exists() && !Path::new("pwned").exists());
}

// @req FR-015
#[test]
fn simple_words_stay_readable_and_others_are_single_quoted() {
    let args: Vec<OsString> = [
        "-json",
        "-G1:4",
        "--",
        "/photos/IMG_0042.jpg",
        "/a/it's $HOME.jpg",
        "",
    ]
    .map(OsString::from)
    .into();
    let shown = display(Shell::Posix, Path::new("/usr/bin/exiftool"), &args);
    assert_eq!(
        shown.text,
        r#"/usr/bin/exiftool -json -G1:4 -- /photos/IMG_0042.jpg '/a/it'\''s $HOME.jpg' ''"#
    );
    assert!(shown.warning.contains("sh, bash or zsh"));
}

// @req FR-015
#[test]
fn powershell_display_quotes_every_word_including_curly_quotes() {
    let args: Vec<OsString> = ["-json", "--", r"C:\Photos\it's ‘x’ $env:PATH.jpg", ""]
        .map(OsString::from)
        .into();
    let shown = display(
        Shell::PowerShell,
        Path::new(r"C:\Program Files\ExifBee\exiftool.exe"),
        &args,
    );
    assert_eq!(
        shown.text,
        r"& 'C:\Program Files\ExifBee\exiftool.exe' '-json' '--' 'C:\Photos\it''s ‘‘x’’ $env:PATH.jpg' ''"
    );
    assert!(shown.exact);
    assert!(shown.warning.contains("PowerShell 7.3"));
}

// @req FR-015, NFR-005
#[test]
fn a_non_utf8_path_is_flagged_as_not_exact() {
    use std::os::unix::ffi::OsStringExt;
    let name = OsString::from_vec(b"/photos/caf\xe9.jpg".to_vec());
    let shown = display(Shell::Posix, Path::new("/usr/bin/exiftool"), &[name]);
    assert!(!shown.exact);
    assert!(shown.text.contains('\u{FFFD}'));
}
