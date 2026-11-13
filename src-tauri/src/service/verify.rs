//! Read-after-write verification (S4-T05, FR-017): compares a file as read after ExifTool wrote
//! it with what the plan intended, so a write ExifTool calls successful is only reported as
//! such when the file really holds the planned result.

use crate::domain::edit::{Change, EditValue};
use crate::domain::metadata::{MetadataValue, TagEntry};
use crate::service::plan::FilePlan;
use std::collections::{HashMap, HashSet};

/// Groups that change on any write or are not stored in the file; never compared.
const CHANGES_ON_WRITE: &[&str] = &["System", "ExifTool", "Composite"];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Verification {
    /// What does not match the plan; any entry means the write is not a success.
    pub problems: Vec<String>,
    /// Matches stored in another form, e.g. `ExifIFD:ExposureTime: stored as 1/200`.
    pub notes: Vec<String>,
}

/// Compares `after` (the file read back) with `plan` (its changes and the read made while
/// planning).
///
/// Rules:
/// - A set tag exists once and its value is the same ([`same_value`]); a one-item list counts
///   as the text it holds.
/// - A deleted tag is gone, and so is every tag a group removal's dry run listed, unless the
///   plan sets it again.
/// - Every other stored tag keeps its value, except groups that change on any write and the XMP
///   packet's toolkit stamp. Tags are matched by group and name, as copy numbers shift.
pub fn verify(plan: &FilePlan, after: &[TagEntry]) -> Verification {
    let mut result = Verification::default();
    let mut found: HashMap<(&str, &str), Vec<&TagEntry>> = HashMap::new();
    for tag in after {
        found.entry((&tag.group1, &tag.name)).or_default().push(tag);
    }
    let mut touched: HashSet<String> = HashSet::new();
    let mut set_again: HashSet<String> = HashSet::new();

    for change in &plan.edits {
        match change {
            Change::Set(edit) => {
                let key = format!("{}:{}", edit.group, edit.name);
                touched.insert(key.clone());
                set_again.insert(key.clone());
                let wanted = match &edit.value {
                    EditValue::Text { text } => vec![text.clone()],
                    EditValue::List { items } => items.clone(),
                };
                match found
                    .get(&(edit.group.as_str(), edit.name.as_str()))
                    .map(Vec::as_slice)
                {
                    None | Some([]) => result.problems.push(format!(
                        "{key}: planned {}, not in the file",
                        wanted.join(", ")
                    )),
                    Some([tag]) => {
                        let actual = texts(&tag.value);
                        let same = actual.len() == wanted.len()
                            && actual.iter().zip(&wanted).all(|(a, w)| same_value(w, a));
                        if !same {
                            result.problems.push(format!(
                                "{key}: planned {}, reads {}",
                                wanted.join(", "),
                                actual.join(", ")
                            ));
                        } else if actual != wanted {
                            result
                                .notes
                                .push(format!("{key}: stored as {}", actual.join(", ")));
                        }
                    }
                    Some(several) => result.problems.push(format!(
                        "{key}: planned once, the file now has {}",
                        several.len()
                    )),
                }
            }
            Change::DeleteTag(delete) => {
                let key = format!("{}:{}", delete.group, delete.name);
                if found.contains_key(&(delete.group.as_str(), delete.name.as_str())) {
                    result.problems.push(format!("{key}: still in the file"));
                }
                touched.insert(key);
            }
            Change::DeleteGroup(_) => {}
        }
    }
    let removed: HashSet<&String> = plan.changes.iter().flat_map(|c| &c.removes).collect();
    for key in &removed {
        if !set_again.contains(*key) {
            if let Some((group, name)) = key.split_once(':') {
                if found.contains_key(&(group, name)) {
                    result.problems.push(format!("{key}: still in the file"));
                }
            }
        }
        touched.insert((*key).clone());
    }

    // Everything the plan did not touch keeps its value.
    let mut left: HashMap<(&str, &str), Vec<String>> = HashMap::new();
    for tag in after {
        left.entry((&tag.group1, &tag.name))
            .or_default()
            .push(texts(&tag.value).join(", "));
    }
    for tag in &plan.before {
        let key = format!("{}:{}", tag.group1, tag.name);
        if CHANGES_ON_WRITE.contains(&tag.group1.as_str())
            || key == "XMP-x:XMPToolkit"
            || touched.contains(&key)
        {
            continue;
        }
        let was = texts(&tag.value).join(", ");
        let now = left.entry((&tag.group1, &tag.name)).or_default();
        if let Some(index) = now.iter().position(|value| *value == was) {
            now.remove(index);
        } else if let Some(other) = now.first() {
            result.problems.push(format!(
                "{key}: changed unexpectedly, was {was}, now {other}"
            ));
        } else {
            result
                .problems
                .push(format!("{key}: removed unexpectedly, was {was}"));
        }
    }
    result
}

/// A value as texts: one for text, one per item for a list; structures and binary data as the
/// inspector shows them.
fn texts(value: &MetadataValue) -> Vec<String> {
    match value {
        MetadataValue::Text { text } => vec![text.clone()],
        MetadataValue::List { items } => items.iter().flat_map(texts).collect(),
        other => vec![format!("{other:?}")],
    }
}

/// Whether ExifTool stored `wanted` as `actual`, allowing the forms it normalizes to.
///
/// Equal when identical; equal once surrounding whitespace is trimmed (ExifTool drops trailing
/// spaces); the same number written as a decimal or a fraction (`0.005` = `1/200`, `5` =
/// `5.0`); or the same date and time with numbers compared field by field
/// (`2026:1:2 3:4:5` = `2026:01:02 03:04:05`). Probed on ExifTool 13.55.
pub fn same_value(wanted: &str, actual: &str) -> bool {
    if wanted == actual || wanted.trim() == actual.trim() {
        return true;
    }
    if let (Some(a), Some(b)) = (number(wanted), number(actual)) {
        return (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0);
    }
    match (date_fields(wanted), date_fields(actual)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// `5`, `5.0`, `-1.5`, `1/200` → the number; anything else → `None`.
fn number(text: &str) -> Option<f64> {
    let text = text.trim();
    match text.split_once('/') {
        Some((top, bottom)) => {
            let bottom: f64 = bottom.trim().parse().ok()?;
            (bottom != 0.0).then(|| top.trim().parse::<f64>().ok().map(|top| top / bottom))?
        }
        None => text.parse().ok().filter(|value: &f64| value.is_finite()),
    }
}

/// `2026:1:2 3:4:5+02:00` → `[2026, 1, 2, 3, 4, 5, 2, 0]`, for texts starting like an ExifTool
/// date (`YYYY:M:D`); `None` otherwise.
fn date_fields(text: &str) -> Option<Vec<u64>> {
    let text = text.trim();
    let mut parts = text.splitn(3, ':');
    let year = parts.next()?;
    if year.len() != 4 || !year.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let fields: Vec<u64> = text
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .map(|part| part.parse().ok())
        .collect::<Option<_>>()?;
    (fields.len() >= 3 && text[4..].starts_with(':')).then_some(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    // @req FR-017
    #[test]
    fn values_match_in_the_forms_exiftool_normalizes_to() {
        for (wanted, actual) in [
            ("Canon", "Canon"),
            (" Spaced ", " Spaced"),
            ("0.005", "1/200"),
            ("5", "5.0"),
            ("-1.5", "-3/2"),
            ("2026:1:2 3:4:5", "2026:01:02 03:04:05"),
            ("2026:01:02 03:04:05+2:00", "2026:01:02 03:04:05+02:00"),
            ("", ""),
        ] {
            assert!(same_value(wanted, actual), "{wanted:?} vs {actual:?}");
        }
        for (wanted, actual) in [
            ("Canon", "Nikon"),
            ("6", "Rotate 90 CW"),
            ("0.005", "1/300"),
            ("1/0", "0"),
            ("2026:01:02", "2026:01:03"),
            ("12:30", "12:30:00"),
            ("a b", "ab"),
            ("", "0"),
        ] {
            assert!(!same_value(wanted, actual), "{wanted:?} vs {actual:?}");
        }
    }
}
