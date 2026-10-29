//! The capability snapshot of the ExifTool in use (S2-T04, FR-007, SPEC §3.2 item 7): what it
//! can read and write, cached per executable so the ~1 s enumeration runs once per install.

use crate::adapter::exiftool::lists::{self, ListError, Listings, TagCapability};
use crate::adapter::exiftool::process::CancelToken;
use crate::adapter::exiftool::resolver::{ExecutableIdentity, ExifTool};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const CACHE_FILE: &str = "capabilities.json";
/// Bumped when the cached shape changes, so an old cache file is rebuilt instead of misread.
const CACHE_FORMAT: u32 = 1;
pub const MAX_PAGE: usize = 500;

/// Which ExifTool a snapshot describes. Same version *and* same file: a different install of the
/// same version can have different modules, and an in-place upgrade changes the version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotKey {
    pub version: String,
    pub identity: ExecutableIdentity,
}

impl SnapshotKey {
    pub fn of(tool: &ExifTool) -> Self {
        Self {
            version: tool.version.clone(),
            identity: tool.identity.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySnapshot {
    pub key: SnapshotKey,
    #[serde(flatten)]
    pub listings: Listings,
}

/// What the cache file holds; `format` guards against reading a file from another ExifBee.
#[derive(Serialize, Deserialize)]
struct CacheFile {
    format: u32,
    snapshot: CapabilitySnapshot,
}

/// One page of tags, for UIs that must not receive all ~26k tags at once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagPage {
    /// Matching tags in total, so a UI can show "1–100 of 342".
    pub total: usize,
    pub tags: Vec<TagCapability>,
}

impl CapabilitySnapshot {
    /// Tags whose `group1:name` contains `search` (case-insensitive; empty matches all), from
    /// `offset`, at most `limit` (clamped to [`MAX_PAGE`]). Order is stable: `(group1, name)`.
    ///
    /// Example: `page("xmp-dc:t", 0, 50)` → `XMP-dc:Title`, `XMP-dc:Type`, … with `total`.
    pub fn page(&self, search: &str, offset: usize, limit: usize) -> TagPage {
        let needle = search.to_lowercase();
        let matches: Vec<&TagCapability> = self
            .listings
            .tags
            .iter()
            .filter(|tag| {
                needle.is_empty()
                    || format!("{}:{}", tag.group1, tag.name)
                        .to_lowercase()
                        .contains(&needle)
            })
            .collect();
        TagPage {
            total: matches.len(),
            tags: matches
                .into_iter()
                .skip(offset)
                .take(limit.min(MAX_PAGE))
                .cloned()
                .collect(),
        }
    }
}

/// Memory + disk cache of the current snapshot. Shared app state; cheap to query once built.
#[derive(Debug)]
pub struct CapabilityCache {
    dir: PathBuf,
    current: Mutex<Option<Arc<CapabilitySnapshot>>>,
}

impl CapabilityCache {
    /// `dir` is the OS app-cache directory in the app (`~/.cache/app.exifbee` on Linux).
    pub fn new(dir: &Path) -> Self {
        Self {
            dir: dir.into(),
            current: Mutex::new(None),
        }
    }

    /// The snapshot for `tool`, enumerating only when no cached snapshot matches it.
    ///
    /// Flow: memory hit (same [`SnapshotKey`]) → return it; else a disk cache with the same format
    /// and key → load it; else run `lists::enumerate`, write the cache atomically (temp + rename)
    /// and keep it in memory. Any mismatch — other version, other file, unreadable or old-format
    /// cache — rebuilds, so a changed ExifTool is never described by stale data.
    ///
    /// Gotchas: blocking (runs ExifTool on a miss); call it off the async runtime. A failed cache
    /// write is not an error: the snapshot is still returned and only the next start re-enumerates.
    pub fn snapshot(
        &self,
        tool: &ExifTool,
        cancel: &CancelToken,
    ) -> Result<Arc<CapabilitySnapshot>, ListError> {
        let key = SnapshotKey::of(tool);
        let mut current = self
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(snapshot) = current.as_ref().filter(|snapshot| snapshot.key == key) {
            return Ok(Arc::clone(snapshot));
        }
        let snapshot = match self.load(&key) {
            Some(snapshot) => snapshot,
            None => {
                let snapshot = CapabilitySnapshot {
                    key,
                    listings: lists::enumerate(tool, cancel)?,
                };
                let _ = self.store(&snapshot);
                snapshot
            }
        };
        let snapshot = Arc::new(snapshot);
        *current = Some(Arc::clone(&snapshot));
        Ok(snapshot)
    }

    fn load(&self, key: &SnapshotKey) -> Option<CapabilitySnapshot> {
        let bytes = fs::read(self.dir.join(CACHE_FILE)).ok()?;
        let file: CacheFile = serde_json::from_slice(&bytes).ok()?;
        (file.format == CACHE_FORMAT && &file.snapshot.key == key).then_some(file.snapshot)
    }

    fn store(&self, snapshot: &CapabilitySnapshot) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let data = serde_json::to_vec(&CacheFile {
            format: CACHE_FORMAT,
            snapshot: snapshot.clone(),
        })
        .map_err(std::io::Error::other)?;
        let path = self.dir.join(CACHE_FILE);
        let temp = path.with_extension("json.tmp");
        let mut file = fs::File::create(&temp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        fs::rename(temp, path)
    }
}
