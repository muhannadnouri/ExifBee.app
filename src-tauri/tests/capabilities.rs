//! Capability enumeration and its cache (S2-T04).

mod common;

use common::harness::Engine;
use common::{fake_executable, TempDir};
use exifbee_lib::adapter::exiftool::lists::{enumerate, parse_tags, words, TagCapability};
use exifbee_lib::adapter::exiftool::process::CancelToken;
use exifbee_lib::adapter::exiftool::resolver::probe;
use exifbee_lib::adapter::exiftool::resolver::DEFAULT_TIMEOUT;
use exifbee_lib::service::capabilities::{
    CapabilityCache, CapabilitySnapshot, CACHE_FILE, MAX_PAGE,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn has(list: &[String], word: &str) -> bool {
    list.iter().any(|item| item == word)
}

fn tag<'a>(tags: &'a [TagCapability], group1: &str, name: &str) -> Option<&'a TagCapability> {
    tags.iter()
        .find(|tag| tag.group1 == group1 && tag.name == name)
}

// @req FR-007, UX-006
#[test]
fn the_installed_exiftool_reports_formats_groups_and_writability() {
    let engine = Engine::new();
    let tool = &engine.tool;
    let started = Instant::now();
    let listings = enumerate(tool, &CancelToken::default()).unwrap();
    eprintln!(
        "enumeration took {:?} for ExifTool {}",
        started.elapsed(),
        tool.version
    );

    // Formats come from ExifTool, far beyond photos.
    for extension in [
        "JPG", "PNG", "PDF", "MP4", "MP3", "ZIP", "DOCX", "XMP", "TTF",
    ] {
        assert!(
            has(&listings.readable_extensions, extension),
            "readable {extension}"
        );
    }
    for extension in ["JPG", "PDF", "MP4", "XMP"] {
        assert!(
            has(&listings.writable_extensions, extension),
            "writable {extension}"
        );
    }
    assert!(
        !has(&listings.writable_extensions, "ZIP"),
        "ZIP is read-only in ExifTool"
    );
    assert!(listings.recognized_extensions.len() >= listings.readable_extensions.len());

    for group in ["EXIF", "XMP", "File", "Composite"] {
        assert!(has(&listings.family0_groups, group), "family 0 {group}");
    }
    for group in ["IFD0", "XMP-dc", "ExifIFD"] {
        assert!(has(&listings.family1_groups, group), "family 1 {group}");
    }

    assert!(listings.tags.len() > 10_000, "{}", listings.tags.len());
    assert!(tag(&listings.tags, "IFD0", "Make").unwrap().writable);
    assert!(tag(&listings.tags, "XMP-dc", "Title").unwrap().writable);
    assert!(
        !tag(&listings.tags, "Composite", "ImageSize")
            .unwrap()
            .writable
    );
    assert!(listings.tags.iter().any(|tag| !tag.writable));
}

// @req UX-006
#[test]
fn read_only_and_writable_survive_serialization() {
    let dir = TempDir::new("caps-serialize");
    let cache = CapabilityCache::new(&dir.0);
    let snapshot = cache
        .snapshot(&Engine::new().tool, &CancelToken::default())
        .unwrap();

    let json = serde_json::to_vec(&*snapshot).unwrap();
    let back: CapabilitySnapshot = serde_json::from_slice(&json).unwrap();
    assert_eq!(back, *snapshot);
    assert!(back.listings.tags.iter().any(|tag| tag.writable));
    assert!(back.listings.tags.iter().any(|tag| !tag.writable));
    assert!(dir.0.join(CACHE_FILE).exists());
}

// @req FR-007
#[test]
fn parsing_follows_exiftool_conventions() {
    assert_eq!(
        words("Supported file extensions:\n  360 3FR JPG\n  PDF JPG\n"),
        ["360", "3FR", "JPG", "PDF"]
    );
    let xml = r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='Exif::Main' g0='EXIF' g1='IFD0' g2='Image'>
 <tag id='271' name='Make' type='string' writable='true'/>
 <tag id='2' name='PreviewImageLength' type='int32u' writable='true' g1='MakerNotes'/>
 <tag id='Time &amp; Date' name='TimeAndDate' type='?' writable='false'/>
</table>
<table name='Other::Main' g0='EXIF' g1='IFD0' g2='Image'>
 <tag id='271' name='Make' type='string' writable='false'/>
</table>
</taginfo>"#;
    let tags = parse_tags(xml).unwrap();
    // A tag's own g1 overrides its table's; duplicates collapse to the writable entry.
    assert_eq!(tags.len(), 3);
    assert!(
        tag(&tags, "MakerNotes", "PreviewImageLength")
            .unwrap()
            .writable
    );
    assert!(tag(&tags, "IFD0", "Make").unwrap().writable);
    assert!(!tag(&tags, "IFD0", "TimeAndDate").unwrap().writable);
    assert!(parse_tags("<taginfo><tag writable='true'/></taginfo>").is_err());
}

/// A fake ExifTool that serves canned listings and logs every invocation's first argument.
fn fake_exiftool(dir: &Path, name: &str, version: &str) -> PathBuf {
    let log = dir.join(format!("{name}.log"));
    fake_executable(
        dir,
        name,
        &format!(
            r#"echo "$1" >> '{log}'
case "$1" in
  -ver) echo {version} ;;
  -listf) printf 'Supported file extensions:\n  JPG PDF\n' ;;
  -listr) printf 'Recognized file extensions:\n  JPG PDF ZIP\n' ;;
  -listwf) printf 'Writable file extensions:\n  JPG\n' ;;
  -listg) printf 'Groups in family 0:\n  EXIF XMP\n' ;;
  -listg1) printf 'Groups in family 1:\n  IFD0 XMP-dc\n' ;;
  -listx) printf "<taginfo><table name='E' g0='EXIF' g1='IFD0'><tag name='Make' writable='true'/></table></taginfo>\n" ;;
esac"#,
            log = log.display()
        ),
    )
}

fn enumerations(dir: &Path, name: &str) -> usize {
    fs::read_to_string(dir.join(format!("{name}.log")))
        .unwrap_or_default()
        .lines()
        .filter(|line| *line == "-listx")
        .count()
}

// @req FR-007
#[test]
fn the_cache_is_reused_until_the_executable_or_version_changes() {
    let dir = TempDir::new("caps-cache");
    let cache_dir = dir.0.join("cache");
    let cancel = CancelToken::default();
    let first = probe(&fake_exiftool(&dir.0, "a", "13.55"), DEFAULT_TIMEOUT).unwrap();

    let cache = CapabilityCache::new(&cache_dir);
    let snapshot = cache.snapshot(&first, &cancel).unwrap();
    assert_eq!(snapshot.listings.writable_extensions, ["JPG"]);
    assert_eq!(enumerations(&dir.0, "a"), 1);
    cache.snapshot(&first, &cancel).unwrap(); // memory hit
    CapabilityCache::new(&cache_dir)
        .snapshot(&first, &cancel)
        .unwrap(); // disk hit on next start
    assert_eq!(
        enumerations(&dir.0, "a"),
        1,
        "cached snapshot must be reused"
    );

    // A different executable (another install) invalidates, even with the same version.
    let other = probe(&fake_exiftool(&dir.0, "b", "13.55"), DEFAULT_TIMEOUT).unwrap();
    let rebuilt = cache.snapshot(&other, &cancel).unwrap();
    assert_eq!(enumerations(&dir.0, "b"), 1);
    assert_eq!(rebuilt.key.identity, other.identity);

    // The same file reporting a new version (an in-place upgrade) invalidates too.
    let mut upgraded = other.clone();
    upgraded.version = "13.60".into();
    let after = CapabilityCache::new(&cache_dir)
        .snapshot(&upgraded, &cancel)
        .unwrap();
    assert_eq!(after.key.version, "13.60");
    assert_eq!(enumerations(&dir.0, "b"), 2);

    // A damaged cache file is rebuilt, never trusted.
    fs::write(cache_dir.join(CACHE_FILE), b"{\"format\": 1, \"snap").unwrap();
    CapabilityCache::new(&cache_dir)
        .snapshot(&upgraded, &cancel)
        .unwrap();
    assert_eq!(enumerations(&dir.0, "b"), 3);
}

// @req FR-007
#[test]
fn tag_listings_page_and_search_with_stable_order() {
    let dir = TempDir::new("caps-page");
    let snapshot = CapabilityCache::new(&dir.0)
        .snapshot(&Engine::new().tool, &CancelToken::default())
        .unwrap();
    let all = snapshot.page("", 0, 100);
    assert_eq!(all.total, snapshot.listings.tags.len());
    assert_eq!(all.tags.len(), 100);
    assert_eq!(
        snapshot.page("", 100, 1).tags[0],
        snapshot.listings.tags[100]
    );
    assert_eq!(snapshot.page("", 0, 100_000).tags.len(), MAX_PAGE);

    let dc = snapshot.page("xmp-dc:title", 0, 10);
    assert!(dc.total >= 1);
    assert!(dc
        .tags
        .iter()
        .all(|tag| format!("{}:{}", tag.group1, tag.name)
            .to_lowercase()
            .contains("xmp-dc:title")));
    assert!(snapshot.page("no-such-tag-anywhere", 0, 10).tags.is_empty());
    assert_eq!(snapshot.page("", all.total + 5, 10).tags.len(), 0);
}

// @req FR-007, UX-006
#[test]
fn file_selection_has_no_hardcoded_format_allowlist() {
    // Formats are ExifTool's to decide; the dialog must not filter by extension.
    let commands = include_str!("../src/commands/mod.rs");
    assert!(
        !commands.contains("add_filter"),
        "file dialogs must not restrict extensions"
    );
}
