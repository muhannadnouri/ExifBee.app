//! macOS and Windows are not implemented yet: only `PATH` is searched. S7 adds macOS known
//! locations (`/opt/homebrew/bin`, `/usr/local/bin`, Finder-launched PATH handling); S8 resolves
//! the bundled official Windows package first (SPEC §3.1–3.2).

#[cfg(windows)]
pub const EXIFTOOL_FILE_NAME: &str = "exiftool.exe";
#[cfg(not(windows))]
pub const EXIFTOOL_FILE_NAME: &str = "exiftool";

pub const KNOWN_EXIFTOOL_LOCATIONS: &[&str] = &[];
