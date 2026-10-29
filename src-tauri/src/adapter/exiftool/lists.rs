//! ExifTool's own capability listings (S2-T04, FR-007): which file types it reads and writes,
//! which groups exist and which tags are writable. Everything here comes from the installed
//! ExifTool; ExifBee keeps no list of "supported" formats of its own.

use super::argv::Args;
use super::process::{self, CancelToken, RunError};
use super::resolver::ExifTool;
use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::thread;
use std::time::Duration;

const LIST_TIMEOUT: Duration = Duration::from_secs(60);
/// `-listx -s` is about 2.6 MB for ExifTool 13.55; room for growth across versions.
const MAX_LIST_OUTPUT: usize = 32 * 1024 * 1024;

/// One tag as ExifTool defines it. The same name can exist in many groups (e.g. `Make` in
/// `IFD0`, `XMP-tiff`, maker notes), so identity is `(group1, name)`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCapability {
    pub group1: String,
    pub name: String,
    pub group0: String,
    /// ExifTool can write this tag in this group. `false` means read-only, never "unknown":
    /// tags ExifTool does not list are simply absent.
    pub writable: bool,
}

/// Raw listings from one ExifTool, before keying and caching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listings {
    /// `-listf`: extensions ExifTool can read metadata from.
    pub readable_extensions: Vec<String>,
    /// `-listr`: extensions it recognizes (a superset; some are identified but not parsed).
    pub recognized_extensions: Vec<String>,
    /// `-listwf`: extensions it can write.
    pub writable_extensions: Vec<String>,
    /// `-listg` / `-listg1`: group names in families 0 (general) and 1 (specific).
    pub family0_groups: Vec<String>,
    pub family1_groups: Vec<String>,
    /// `-listx -s`: every tag with its groups and writability, sorted by `(group1, name)`.
    pub tags: Vec<TagCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListError {
    Run {
        listing: &'static str,
        error: RunError,
    },
    Failed {
        listing: &'static str,
        stderr: String,
    },
    Parse {
        listing: &'static str,
        message: String,
    },
}

impl fmt::Display for ListError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Run { listing, error } => write!(f, "ExifTool {listing} {error}"),
            Self::Failed { listing, stderr } => write!(f, "ExifTool {listing} failed: {stderr}"),
            Self::Parse { listing, message } => {
                write!(
                    f,
                    "could not understand ExifTool {listing} output: {message}"
                )
            }
        }
    }
}

impl std::error::Error for ListError {}

/// Runs all six listings in parallel (about 1 s for ExifTool 13.55 on 8 cores, dominated by `-listx`) and
/// parses them.
///
/// Flow: each listing is a separate one-shot run through the shared executor, on its own thread
/// (they are independent and ExifTool is single-threaded per process) → word lists are parsed
/// from ExifTool's "Heading:\n  WORD WORD …" text → `-listx -s` XML is streamed into
/// [`TagCapability`]s, where a tag's own `g0`/`g1` attributes override its table's (maker-note
/// tags inside an EXIF table carry `g1='MakerNotes'`).
///
/// Gotcha: the result describes *this* executable only; callers key it by version and
/// `ExecutableIdentity` (see `service::capabilities`) and must not reuse it for another ExifTool.
pub fn enumerate(tool: &ExifTool, cancel: &CancelToken) -> Result<Listings, ListError> {
    let run = |listing: &'static str, options: &'static [&'static str]| {
        let args = Args::new().options(options);
        let output = process::run(
            &tool.path,
            args.as_slice(),
            LIST_TIMEOUT,
            MAX_LIST_OUTPUT,
            cancel,
        )
        .map_err(|error| ListError::Run { listing, error })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(ListError::Failed { listing, stderr });
        }
        String::from_utf8(output.stdout).map_err(|error| ListError::Parse {
            listing,
            message: error.to_string(),
        })
    };
    thread::scope(|scope| {
        let readable = scope.spawn(|| run("-listf", &["-listf"]));
        let recognized = scope.spawn(|| run("-listr", &["-listr"]));
        let writable = scope.spawn(|| run("-listwf", &["-listwf"]));
        let family0 = scope.spawn(|| run("-listg", &["-listg"]));
        let family1 = scope.spawn(|| run("-listg1", &["-listg1"]));
        let tags = scope.spawn(|| run("-listx", &["-listx", "-s"]));
        let join = |handle: thread::ScopedJoinHandle<'_, Result<String, ListError>>| {
            handle.join().expect("listing thread panicked")
        };
        Ok(Listings {
            readable_extensions: words(&join(readable)?),
            recognized_extensions: words(&join(recognized)?),
            writable_extensions: words(&join(writable)?),
            family0_groups: words(&join(family0)?),
            family1_groups: words(&join(family1)?),
            tags: parse_tags(&join(tags)?).map_err(|message| ListError::Parse {
                listing: "-listx",
                message,
            })?,
        })
    })
}

/// Parses ExifTool's word-list format: a heading line ending in `:`, then indented words.
///
/// Example: `"Supported file extensions:\n  360 3FR JPG\n  PDF\n"` → `["360", "3FR", "JPG", "PDF"]`.
/// Words are kept as printed (extensions upper-case, group names as-is) and sorted/deduplicated.
pub fn words(text: &str) -> Vec<String> {
    let mut words: Vec<String> = text
        .lines()
        .filter(|line| !line.trim_end().ends_with(':'))
        .flat_map(str::split_whitespace)
        .map(String::from)
        .collect();
    words.sort();
    words.dedup();
    words
}

/// Streams `-listx -s` XML into tags, sorted by `(group1, name)` and deduplicated.
///
/// The same `(group1, name)` can appear in several tables (e.g. one per maker-note model); it is
/// writable if ExifTool marks it writable in any of them, because `group1:name` then has at least
/// one write path. ExifTool still decides per file at write time (S4 preflight).
pub fn parse_tags(xml: &str) -> Result<Vec<TagCapability>, String> {
    let mut reader = Reader::from_str(xml);
    let (mut table_g0, mut table_g1) = (String::new(), String::new());
    let mut tags: Vec<TagCapability> = Vec::new();
    loop {
        let event = reader.read_event().map_err(|error| error.to_string())?;
        let element = match &event {
            Event::Start(element) | Event::Empty(element) => element,
            Event::Eof => break,
            _ => continue,
        };
        let attribute = |key: &str| -> Result<Option<String>, String> {
            match element
                .try_get_attribute(key)
                .map_err(|error| error.to_string())?
            {
                Some(attr) => attr
                    .normalized_value(XmlVersion::default())
                    .map(|value| Some(value.into_owned()))
                    .map_err(|error| error.to_string()),
                None => Ok(None),
            }
        };
        match element.name().as_ref() {
            "table" => {
                table_g0 = attribute("g0")?.unwrap_or_default();
                table_g1 = attribute("g1")?.unwrap_or_default();
            }
            "tag" => {
                let name = attribute("name")?.ok_or("tag without a name")?;
                tags.push(TagCapability {
                    group1: attribute("g1")?.unwrap_or_else(|| table_g1.clone()),
                    group0: attribute("g0")?.unwrap_or_else(|| table_g0.clone()),
                    writable: attribute("writable")?.as_deref() == Some("true"),
                    name,
                });
            }
            _ => {}
        }
    }
    tags.sort_by(|a, b| (&a.group1, &a.name, !a.writable).cmp(&(&b.group1, &b.name, !b.writable)));
    // Sorted writable-first within each (group1, name), so dedup keeps the writable entry.
    tags.dedup_by(|later, kept| later.group1 == kept.group1 && later.name == kept.name);
    Ok(tags)
}
