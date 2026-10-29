//! Copyable command lines for humans (S2-T02, FR-015). Display only: ExifBee never executes
//! these strings. It runs the argv from `argv::Args` directly; this module renders the same argv
//! so that pasting it into the named shell runs exactly that argv.

use std::ffi::OsString;
use std::path::Path;

/// The terminal the user will paste into; quoting rules differ and cannot be shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    /// `sh`, `bash`, `zsh`, `dash` on Linux/macOS.
    Posix,
    /// PowerShell 7.3+ on Windows (its default "Standard" native-argument passing).
    PowerShell,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayedCommand {
    pub text: String,
    /// `false` when a path was not valid UTF-8 and had to be shown lossily (`�`); such a command
    /// would not run the same file if pasted, so the UI must say so instead of offering it as-is.
    pub exact: bool,
    /// Shown next to the command: which shell it is for and what differs elsewhere.
    pub warning: &'static str,
}

/// Renders `program args…` for `shell`.
///
/// POSIX: words made only of `A–Z a–z 0–9 @ % + = : , . / _ -` are left bare; anything else is
/// single-quoted, with each `'` written as `'\''`. Inside single quotes POSIX shells interpret
/// nothing (`$`, backticks, `\`, `;`, `&`, globs, newlines are literal), so this is exact.
///
/// PowerShell: `& 'program' 'arg' …` with every word single-quoted. Gotcha: PowerShell also treats
/// the curly quotes `‘ ’ ‚ ‛` as single-quote delimiters, so they are doubled like `'`.
///
/// Example: `display(Shell::Posix, "/usr/bin/exiftool", ["-json", "--", "/a/it's $HOME.jpg"])` →
/// `/usr/bin/exiftool -json -- '/a/it'\''s $HOME.jpg'`.
pub fn display(shell: Shell, program: &Path, args: &[OsString]) -> DisplayedCommand {
    let mut exact = true;
    let mut word = |value: &std::ffi::OsStr| {
        let text = value.to_string_lossy();
        exact &= value.to_str().is_some();
        match shell {
            Shell::Posix => posix_quote(&text),
            Shell::PowerShell => powershell_quote(&text),
        }
    };
    let mut words = vec![word(program.as_os_str())];
    words.extend(args.iter().map(|arg| word(arg)));
    let (text, warning) = match shell {
        Shell::Posix => (
            words.join(" "),
            "For sh, bash or zsh. Other shells quote differently.",
        ),
        Shell::PowerShell => (
            format!("& {}", words.join(" ")),
            "For PowerShell 7.3 or newer. cmd.exe and Windows PowerShell 5.1 quote differently.",
        ),
    };
    DisplayedCommand {
        text,
        exact,
        warning,
    }
}

fn posix_quote(word: &str) -> String {
    let safe = |c: char| c.is_ascii_alphanumeric() || "@%+=:,./_-".contains(c);
    if !word.is_empty() && word.chars().all(safe) {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

fn powershell_quote(word: &str) -> String {
    let mut quoted = String::with_capacity(word.len() + 2);
    quoted.push('\'');
    for c in word.chars() {
        // Every character PowerShell accepts as a single quote must be doubled to stay literal.
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            quoted.push(c);
        }
        quoted.push(c);
    }
    quoted.push('\'');
    quoted
}
