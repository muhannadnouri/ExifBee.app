//! Linux: ExifTool comes from the distribution's package manager (SPEC §3.1, DEC-014).

pub const EXIFTOOL_FILE_NAME: &str = "exiftool";

/// Where distribution and common manual installs put ExifTool. Suggestions only: `PATH` is still
/// searched afterwards, and the user can always choose another executable.
pub const KNOWN_EXIFTOOL_LOCATIONS: &[&str] = &[
    // Debian/Ubuntu (libimage-exiftool-perl), Fedora (perl-Image-ExifTool), openSUSE.
    "/usr/bin/exiftool",
    // Manual installs from the official tarball (`make install`) and Homebrew-on-Linux links.
    "/usr/local/bin/exiftool",
    // Arch/CachyOS/Manjaro (perl-image-exiftool): Perl scripts live outside the default PATH.
    "/usr/bin/vendor_perl/exiftool",
    "/usr/bin/site_perl/exiftool",
    // Homebrew on Linux default prefix.
    "/home/linuxbrew/.linuxbrew/bin/exiftool",
    // NixOS system profile.
    "/run/current-system/sw/bin/exiftool",
];
