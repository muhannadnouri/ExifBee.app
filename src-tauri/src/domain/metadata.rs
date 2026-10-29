//! The metadata model shared by Rust and the UI (SPEC §4.3, S2-T05, FR-005, FR-023).
//!
//! It keeps what ExifTool reported without reinterpretation: values stay exact text (no float
//! rounding, no leading-zero loss), lists and XMP structures stay nested, binary data is a
//! descriptor (never bytes forced into text), and every tag keeps its full identity
//! (`group1`, optional copy number, name) so same-name tags are never merged.

use serde::Serialize;

/// One tag as ExifTool reported it for a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct TagEntry {
    /// ExifTool's own key, e.g. `XMP-tiff:Copy1:Make`; unique within one file.
    pub key: String,
    /// Family-1 group, e.g. `IFD0`, `XMP-dc`, `PNG`.
    pub group1: String,
    /// ExifTool's family-4 copy number when the same tag occurs more than once (`Copy1` → 1).
    pub copy: Option<u32>,
    pub name: String,
    pub value: MetadataValue,
}

/// A tag value. Scalars are text exactly as ExifTool printed them (read with
/// `-api StructFormat=JSONQ`, so `13.50` stays `13.50` and `1e3` stays `1e3`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub enum MetadataValue {
    Text {
        text: String,
    },
    List {
        items: Vec<MetadataValue>,
    },
    /// An XMP structure (read with `-struct`); fields keep ExifTool's order.
    Structure {
        fields: Vec<StructField>,
    },
    /// Binary data ExifTool did not print, e.g. a thumbnail or palette. `byte_length` comes from
    /// ExifTool's `(Binary data N bytes, …)` placeholder; the bytes are extracted on demand (S6-T04).
    Binary {
        // JSON numbers are exact up to 2^53, far beyond any embedded blob.
        #[cfg_attr(test, ts(type = "number | null"))]
        byte_length: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct StructField {
    pub name: String,
    pub value: MetadataValue,
}
