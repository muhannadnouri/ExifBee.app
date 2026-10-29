//! Baseline metadata of the generated fixture corpus (SPEC §6.2), read with the real system ExifTool.
//! Regenerate fixtures with `npm run fixtures`; set `EXIFTOOL` to test a specific installation.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const UNICODE: &str = "مرحبا · 日本語 · 🐝";
const XMP: [&str; 4] = [
    "-XMP-dc:Title={U}",
    "-XMP-dc:Subject=bee, fixture",
    "-XMP-tiff:Make=ExifBee XMP Make",
    "-XMP-iptcCore:CreatorCity=Fixture City",
];

/// Expected `-Group1:Tag=value` lines per fixture (`{U}` = UNICODE), in SHA256SUMS order.
const EXPECTED: &[(&str, &[&str])] = &[
    (
        "metadata.jpg",
        &[
            "-File:FileType=JPEG",
            "-File:Comment=ExifBee JPEG comment",
            "-IFD0:ImageDescription=ExifBee synthetic JPEG",
            "-IFD0:Make=ExifBee EXIF Make",
            "-IFD0:Artist=ExifBee Fixtures",
            "-ExifIFD:DateTimeOriginal=2026:01:02 03:04:05",
        ],
    ),
    (
        "metadata.png",
        &[
            "-File:FileType=PNG",
            "-PNG:Title=ExifBee PNG title",
            "-PNG:Description={U}",
        ],
    ),
    (
        "metadata.pdf",
        &[
            "-File:FileType=PDF",
            "-PDF:Title=ExifBee PDF title",
            "-PDF:Author=ExifBee Fixtures",
            "-PDF:Subject={U}",
            "-PDF:Keywords=bee, fixture",
        ],
    ),
    ("sidecar.xmp", &["-File:FileType=XMP"]),
    (
        "archive.zip",
        &["-File:FileType=ZIP", "-ZIP:ZipFileName=hello.txt"],
    ),
    ("no-metadata.jpg", &["-File:FileType=JPEG"]),
    ("plain.txt", &["-File:FileType=TXT"]),
    ("empty.bin", &["-ExifTool:Error=File is empty"]),
    (
        "truncated.jpg",
        &["-File:FileType=JPEG", "-ExifTool:Warning=JPEG format error"],
    ),
];

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures")
}

fn read_args(exiftool: &Path, file: &Path) -> Vec<String> {
    let output = Command::new(exiftool)
        .args(["-args", "-G1", "-a", "-charset", "filename=utf8"])
        .arg(file)
        .output()
        .expect("ExifTool runs");
    String::from_utf8(output.stdout)
        .expect("UTF-8 output")
        .lines()
        .map(String::from)
        .collect()
}

// @req OPS-003
#[test]
fn generated_fixtures_carry_their_known_metadata() {
    let tool = common::system_exiftool();

    let listed: Vec<String> = fs::read_to_string(fixture_dir().join("SHA256SUMS"))
        .unwrap()
        .lines()
        .map(|line| line.split_once("  ").unwrap().1.to_string())
        .collect();
    assert_eq!(
        listed,
        EXPECTED.iter().map(|(name, _)| *name).collect::<Vec<_>>()
    );

    for &(name, lines) in EXPECTED {
        let actual = read_args(&tool.path, &fixture_dir().join(name));
        let with_xmp = matches!(name, "metadata.jpg" | "sidecar.xmp");
        let xmp = if with_xmp { &XMP[..] } else { &[] };
        for line in lines.iter().chain(xmp) {
            let line = line.replace("{U}", UNICODE);
            assert!(
                actual.contains(&line),
                "{name}: missing {line:?} in {actual:#?}"
            );
        }
        // Healthy fixtures must parse cleanly; only the deliberately broken ones may report problems.
        if !matches!(name, "empty.bin" | "truncated.jpg") {
            let problems: Vec<_> = actual
                .iter()
                .filter(|l| l.starts_with("-ExifTool:Error") || l.starts_with("-ExifTool:Warning"))
                .collect();
            assert!(problems.is_empty(), "{name}: {problems:?}");
        }
    }
}
