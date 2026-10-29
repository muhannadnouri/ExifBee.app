---
title: ExifBee — Software Design & Delivery Specification
spec_version: 1.0.10
status: approved-baseline-for-implementation
created: 2026-10-28
product: ExifBee
initial_target: Linux desktop
subsequent_targets: macOS and Windows desktop
license_intent: MIT (ExifBee source; third-party terms remain applicable)
stack: Tauri v2 / Rust / React / TypeScript
---

# ExifBee — Software Design & Delivery Specification (SDD)

**Purpose:** This single living specification is the implementation contract and execution checklist for an AI coding agent developing **ExifBee**, a modern, offline-first, general-purpose graphical interface for Phil Harvey's ExifTool. It specifies what to build, in what order, how to test it, and when work may be marked complete.

**Baseline decisions (locked for v1 unless changed through an explicit decision record in this file):**

1. **Desktop only:** Linux first; macOS and Windows later. **No Android, iOS, PWA, website backend, ZeroPerl, or WASM ExifTool runtime.**
2. **Technology:** Tauri v2, Rust, React, and TypeScript; no Electron, no hosted backend.
3. **ExifTool dependency:** On Linux/macOS invoke a **user-installed/system ExifTool** (detect and allow selecting its path). On Windows ship the **official ExifTool Windows executable distribution**, together with its required companion directory, as an application resource/sidecar; optionally support a user-selected installed ExifTool. **Do not independently bundle or build a Perl interpreter.** The official Windows ExifTool package *contains* a Perl runtime internally; there is no technically honest way to claim it is Perl-free.
4. **Functional ambition:** Expose ExifTool's entire reachable metadata breadth across its supported file formats, not just photos. The common workflows must be discoverable; less-common functionality remains accessible through a carefully secured advanced ExifTool argument interface. Actual read/write/create/delete capabilities depend on ExifTool version, file format, tag, and metadata family. Do not imply all readable fields are writable.
5. **Safety:** Read operations are non-destructive. Write operations require a staged plan and preflight; preserve backups by default, verify results, and provide explicit warnings/confirmation for high-risk operations. Never execute user-supplied arguments through a shell.
6. **Experience:** Professional, uncluttered, keyboard-accessible UI; **light, dark, and follow-system** modes; visible generated ExifTool CLI equivalent, warnings, and a useful execution log.
7. **Spec-driven delivery:** One primary Markdown document (this file), stable requirement/task IDs, tests as *completion evidence*, and CI checks for traceability/drift. Automated test code and fixtures are not additional specification documents.
8. **Execution:** MVP is developed and manually validated on Linux; cross-platform architecture must be planned from the outset. macOS and Windows manual sign-off is **deferred to their platform stages**, not falsely marked complete on Linux.

> **Ownership:** ExifBee is an independent GUI using ExifTool; do not imply endorsement or ownership by Phil Harvey. Check logo/name/trademark and distribution presentation before release.

---

## 0. How to use and maintain this SDD

### 0.1 One-document policy

- This is the **only narrative product/design/architecture/task specification**. Do not create `requirements.md`, `architecture.md`, per-feature spec files, shadow TODO lists, or generated Markdown summaries that duplicate it.
- Ordinary indispensable repository files **are allowed**: `README.md` (setup and user entry point), `LICENSE`, `THIRD_PARTY_NOTICES`, security/release policy if required, source-code comments, machine-readable schemas, tests, and generated CI artifacts. They must *link to* rather than restate this SDD.
- A change in intended behavior or architectural boundaries requires editing the relevant section of **this** file in the *same PR* as its implementation. A test-only refactor need not rewrite the SDD if the product contract is unchanged.
- **Spec governs intent; code implements it; tests provide verifiable evidence.** A passing test does not prove an undocumented user need was satisfied; a checked checkbox without passing evidence is invalid.
- No stale version strings in prose: dependency versions belong in lockfiles/build manifests. This file specifies policy and required versions through *constraints*, not hand-maintained snapshots.

### 0.2 Stable IDs and status

- Requirements: `FR-###` functional, `UX-###` experience, `SEC-###` security/safety, `NFR-###` quality/performance, `OPS-###` engineering operations, `PKG-###` packaging, `TST-###` testing.
- Tasks: `S0-T01`, `S1-T02`, etc. Gate identifiers: `G0` … `G9`.
- **Never reuse an ID** after removing a requirement. Mark it deprecated by starting its requirement text with `DEPRECATED:` followed by the reason and replacement; preserve historical references.
- Task states: `[ ] TODO`, `[ ] ⏳ IN PROGRESS` (append owner/branch), `[ ] ⛔ BLOCKED` (append blocker), `[x] DONE`. Only checked means done. An agent may have **one implementation task in progress** at a time unless specifically delegated independent tasks.
- All tasks start TODO. Architecture decisions above are already adopted, not completed implementation.
- A task may be marked DONE only after **all** its listed acceptance criteria pass, applicable automated tests pass, CI is green, manual checks are recorded, and the change is merged/reviewed. If manual evaluation is deliberately deferred, record that explicit exception and leave the *platform release gate* open.

### 0.3 Test-to-requirement traceability without documentation rot

Each executable test suite or representative test case carries a stable ID annotation or metadata field, for example:

```ts
// @req FR-012, SEC-004
it('does not overwrite the source without an approved write plan', () => { /* ... */ });
```

```rust
// @req SEC-002, TST-007
#[test]
fn raw_arguments_are_never_sent_to_a_shell() { /* ... */ }
```

Rules:

1. `scripts/check-spec-traceability` parses the **requirement-definition table in §2** and `@req` annotations in test code. Fail CI if an annotation refers to a non-existent/deprecated ID, IDs are duplicated in definition rows, or a DONE implementation task with automatable criteria has no matching requirement-linked tests. Manual approvals remain a human review responsibility, not something a parser can certify.
   - An annotation is a code comment line whose text starts with `@req`, followed by IDs separated by commas or spaces.
   - A requirement is *automatable* when its §2 evidence type names a runnable kind of evidence (unit, integration, E2E, UI, CI, benchmark, traceability, adversarial, screenshot, a11y, perf, smoke, matrix). A DONE task needs at least one of its automatable evidence IDs annotated in code; tasks whose evidence is only manual, audit or review are exempt.
   - The checker also validates frontmatter, task status syntax (§0.2), duplicate task IDs, and references to unknown requirements, tasks (`S#-T##`) and backticked gates. Run it with `npm run test:traceability`.
2. **A completed testable requirement must have at least one actual automated assertion.** No test may satisfy a requirement solely by checking that a source file or function name exists. Human-only UX/accessibility criteria have a recorded manual checklist and a justified exemption.
3. CI generates a transient coverage report/JSON artifact mapping requirement IDs → test files → test status. **Do not commit generated coverage Markdown** or a second hand-maintained mapping.
4. Unit tests alone do not close behavior involving actual ExifTool/filesystem writes; use integration tests with real ExifTool and fixtures. UI journeys require E2E tests.
5. Updating/removing behavior means updating both requirement and test evidence in the same branch. The *test runner's result*, not the checked box, is the technical source of truth.

### 0.4 Mandatory agent working protocol

For every task:

1. Read this SDD's current task and dependencies; inspect nearby code and existing tests before edits.
2. State the selected task ID and narrowly scoped implementation plan in the PR/commit body (not another Markdown file).
3. Implement the smallest vertical slice, with separated React UI, typed IPC, and Rust execution changes where relevant.
4. Add a **failing test first** when practical, then implementation and negative cases. Run targeted tests, formatting, typecheck, lint, and required integration tests.
5. Report observed test commands/results, design tradeoffs, and unresolved issues in the PR description or agent turn.
6. Mark DONE in this SDD only with evidence; increment spec version when the contract changes; do not silently expand scope.
7. If blocked by missing external OS/tooling, leave BLOCKED or TODO; do not fabricate a success, mock away required integration, or expand to another platform arbitrarily.
8. Do not enable unrelated plugins, add large dependencies, change packaging mode, or commit generated binaries without review.

### 0.5 Versioning and change control

- This is **SDD v1.0.10** (v1.0.0 was the initial implementation baseline). Product release versioning is independent (start application releases at `0.x`).
- Spec `PATCH`: clarifications or test links without behavior change. `MINOR`: additive requirements/tasks. `MAJOR`: materially changed behavior, security guarantees, scope, or compatibility.
- Record important decisions in the **Decision log (§18)** with date, ID, rationale, tradeoff, and replacement when superseded; don't introduce separate ADR Markdown files.
- CI validates frontmatter, unique IDs, valid status syntax, task/gate references, and test references. A machine report is generated on demand rather than maintained manually.

---

## 1. Product charter and boundaries

### 1.1 Users and jobs-to-be-done

- **Power users and developers:** Inspect any supported file, find obscure tags, safely construct ExifTool operations, and learn the CLI from visible commands.
- **Archivists and researchers:** Batch inspect, export, copy, strip, update, and audit metadata on large, heterogeneous collections.
- **Photographers and creators:** Accomplish common workflows without requiring an image-management application.
- **General Linux desktop users:** Use ExifTool without remembering syntax, scripting, or installing a bulky media organizer.

### 1.2 Product principles

1. **File-type agnostic:** Show ExifTool metadata rather than assuming a photograph schema; support media, documents, archives, fonts, executables, etc. where ExifTool can read them.
2. **Truthful capability:** Read-only formats/tags stay read-only; writes only where supported. Display an explicit unsupported/not-writable explanation rather than offering ineffective controls.
3. **Progressive complexity:** Simple read/edit workflow first, advanced tag expression/argument runner as an escape hatch.
4. **User in control:** No surprise writes, silent file moves, hidden metadata removal, or background network requests.
5. **Offline/privacy-first:** Metadata and paths stay on device; no telemetry, analytics, remote APIs, uploads, or CDN fonts. Explicit user-triggered external documentation links are permitted.
6. **Observable by design:** Every execution has an equivalent CLI representation, timestamps, scope, warnings/errors, progress, and per-file result.
7. **Dependable rather than ornamental:** Fast startup, bounded processing queues, keyboard shortcuts, accessible contrast, and conservative file-safety defaults.

### 1.3 Explicit non-goals

- No photo catalog/digital asset management, image editor, media converter, thumbnail generation library, cloud storage, folder synchronization, AI assistant, OCR, document content extraction outside ExifTool, or metadata database indexer.
- No attempt to rewrite ExifTool or implement new tag codecs in Rust/JavaScript.
- No guarantee of identical writability for all file formats, nor automatic editing of every structural/binary/unknown tag.
- No mobile native apps, iOS/Android build targets, PWA, browser deployment, or WebAssembly Perl.
- No terminal emulator or unrestricted host shell inside the UI. An advanced **ExifTool argument runner** is allowed but is not an arbitrary command prompt.
- No automatic download/installation of ExifTool in v1. Provide local install guidance instead; the app itself must work without network access once dependencies are available.

### 1.4 Definition of MVP

**Linux MVP exit (`G5`)**: launch and configure system ExifTool; import files/folders of mixed types; inspect and search all reported metadata; perform generic supported tag modifications and deletion; execute safe batch jobs and metadata copy; present generated CLI commands, confirmations and detailed logs; use light/dark/system themes; run all Linux CI, integration, and desktop E2E gates. Advanced dangerous/raw operations may be in their own later Linux gate (`G6`), but the full scope is mandatory for v1 before general cross-platform release.

---

## 2. Requirements registry (normative definitions)

**Interpretation:** `P0` is required for Linux MVP, `P1` for full-feature Linux, `P2` for multi-platform release. Requirement IDs are stable. Implementation tasks and stage gates are in §7; detailed operational contracts and test guidance follow in §§8–17.

### Functional requirements

| ID | Priority | Normative requirement | Evidence type |
|---|---|---|---|
| FR-001 | P0 | Discover ExifTool, show absolute path/version, validate executable, and explain missing/unsupported dependency | unit + integration + UI E2E |
| FR-002 | P0 | User can override ExifTool executable path, revalidate it, and revert to auto-detection | integration + E2E |
| FR-003 | P0 | Import individual files and multiple files by native dialog and drag/drop without format-specific allowlists | integration + E2E |
| FR-004 | P0 | Import directories, enumerate supported and unknown content without assuming extension determines capabilities | integration + E2E |
| FR-005 | P0 | Read full available metadata in structured form with tag group/source, duplicate-safe identification, and per-file errors | real ExifTool fixture integration |
| FR-006 | P0 | Browse, filter, sort, search, and copy metadata/tags in a responsive table/tree | UI tests + E2E |
| FR-007 | P0 | Discover readable/writable tags, supported/writable file extensions, and metadata groups from the installed ExifTool version; cache per version | integration |
| FR-008 | P0 | Stage generic tag-value writes with explicitly qualified group/tag and preserve typed value/list intent | integration + E2E |
| FR-009 | P0 | Stage generic tag/group deletion, including clearing whole supported metadata groups, with impact warning | integration + E2E |
| FR-010 | P0 | Display planned changes, targets, read/write capability, backups, conflicts, and representative command before execution | unit + E2E |
| FR-011 | P0 | Execute single-file writes safely with per-file results and post-write verification | real filesystem integration |
| FR-012 | P0 | Apply one operation to selected multiple files with bounded queue, progress and partial-failure reporting | integration + E2E |
| FR-013 | P0 | Copy supported tags/groups from source file to one/many destinations with source mapping | integration + E2E |
| FR-014 | P0 | Preserve native ExifTool backup behavior by default, show where backups are located, and never silently purge them | integration + E2E |
| FR-015 | P0 | View equivalent runnable ExifTool command and copy a shell-specific safely escaped representation | unit + E2E |
| FR-016 | P0 | Provide live execution logs with severity, timestamps, file/job association, stderr, exit status, and export | integration + E2E |
| FR-017 | P0 | Detect tag/format write failures, warnings, conflicts, and mismatched verification; never report false success | integration |
| FR-018 | P0 | Support cancel-before-start, cancel-in-progress and retry-failed with honest per-file outcomes | integration + E2E |
| FR-019 | P0 | Provide keyboard-driven selection/edit/execution and basic recent-folder navigation (local only) | E2E + accessibility |
| FR-020 | P1 | Advanced ExifTool argument mode for supported options, with parsing, preflight, scoped files and safeguards | adversarial integration + E2E |
| FR-021 | P1 | Support recursive traversal, filters, include/exclude extensions, path previews, and symlink policy | integration |
| FR-022 | P1 | Expose tag-to-tag copy/rename/reassignment, time shifts, date formatting, import/export CSV/JSON/XMP/sidecar, and file rename/move where supported | integration + E2E |
| FR-023 | P1 | Handle binary/structured/list metadata read/write/export via dedicated safe operations; do not coerce bytes into text | integration |
| FR-024 | P1 | Capability inspect/diagnostics UI shows backend feature/version/platform and why an operation is unavailable | E2E |
| FR-025 | P1 | Job history, auditable execution summaries, optional persisted logs, and restart/crash recovery indications | integration + E2E |
| FR-026 | P1 | Support a native ExifTool `-stay_open` process optimization or demonstrate a benchmark-based reason not to use it | integration + benchmark |
| FR-027 | P2 | Native platform file selection, filesystem semantics, installers and app paths work on Linux, macOS and Windows | platform smoke + manual |
| FR-028 | P1 | Advanced operations cover ExifTool functionality unavailable via forms, with explicit feature/policy limits shown | integration + review |

### UX and accessibility requirements

| ID | Priority | Normative requirement | Evidence type |
|---|---|---|---|
| UX-001 | P0 | Two-pane desktop layout: file collection and metadata/workspace; action inspector and log are accessible without clutter | E2E + manual |
| UX-002 | P0 | Light, dark, and system theme; persistent preference; correct system change handling | UI + E2E |
| UX-003 | P0 | Consistent design tokens, contrast, typography, reduced-motion support and no decorative over-design | screenshot + a11y |
| UX-004 | P0 | Keyboard and screen-reader basics: focus rings, labels, table semantics, shortcuts, live status, dialogs, no keyboard traps | automated a11y + manual |
| UX-005 | P0 | Clear empty/loading/error/success and missing-ExifTool states; no silent failures | UI + E2E |
| UX-006 | P0 | Distinguish read-only/writable/unsupported/unknown tags and non-image formats accurately | UI + integration |
| UX-007 | P0 | Confirm destructive actions, show backups and post-write outcomes; avoid alarm fatigue for reads | E2E |
| UX-008 | P1 | Responsive desktop resizing and large dataset virtualization without layout jumps | E2E + perf |
| UX-009 | P1 | Log and command panes offer copying, search/filter, clear/export and privacy warning for sensitive metadata | E2E |
| UX-010 | P1 | First-run onboarding teaches system dependency on Linux/macOS and bundled dependency on Windows | E2E |

### Security and file-safety requirements

| ID | Priority | Normative requirement | Evidence type |
|---|---|---|---|
| SEC-001 | P0 | No network requests or telemetry in normal operation; no remotely fetched fonts/scripts/assets | audit + offline E2E |
| SEC-002 | P0 | Never use `sh -c`, `cmd /c`, PowerShell or string-interpolated shell execution for ExifTool; use executable plus argument vector | code inspection + integration |
| SEC-003 | P0 | Treat all file paths, names, metadata and ExifTool output as untrusted; prevent HTML/script injection and path traversal | adversarial tests |
| SEC-004 | P0 | All mutations require explicit user-approved structured job plan; reads can execute without write approval | integration + E2E |
| SEC-005 | P0 | File backup safety by default; overwrite modes restricted behind explicit controls and warnings | integration |
| SEC-006 | P0 | Validate scope/target paths and detect symlinks, outside-scope references, collisions and changed files before writes | adversarial integration |
| SEC-007 | P0 | Safe process lifetime, bounded stdout/stderr, timeouts, cancellation, and child cleanup | integration |
| SEC-008 | P0 | Tauri IPC only exposes narrowly scoped commands; use capability least privilege and Rust-mediated FS/process access | audit + integration |
| SEC-009 | P0 | Sensitive metadata and paths are not persisted by default; exported logs carry warning; explicit retention controls | integration + E2E |
| SEC-010 | P1 | Advanced option risk classifier gates `-config`, argument files, external writes, recursive/move/delete/overwrite, and arbitrary paths | adversarial integration |
| SEC-011 | P1 | No arbitrary shell, dynamic Perl config execution, or subprocess chaining without dedicated high-risk consent; never run untrusted config silently | adversarial integration |
| SEC-012 | P1 | Release artifacts are reproducibly built, checksummed, dependency-scanned, and have third-party license notices | CI + release audit |

### Nonfunctional, operations, testing and packaging requirements

| ID | Priority | Normative requirement | Evidence type |
|---|---|---|---|
| NFR-001 | P0 | All file-processing jobs are asynchronous; UI remains interactive during scans, writes and cancellation | E2E + perf |
| NFR-002 | P0 | Bound CPU/memory use with incremental rendering, paged metadata and batches; don't buffer all results unboundedly | perf + code review |
| NFR-003 | P0 | Handle thousands of files without O(n²) UI operations or one process per file | benchmark |
| NFR-004 | P0 | Consistent error taxonomy and observability; structured errors cross IPC | unit + integration |
| NFR-005 | P0 | Unicode, spaces, punctuation, leading hyphens and long paths handled safely where OS supports them | integration |
| NFR-006 | P1 | Performance budgets and regression baselines gathered on documented hardware/fixtures; no unsupported speed claims | benchmark artifacts |
| NFR-007 | P1 | Config schema evolution and failure-safe defaults with deterministic migration testing | unit + integration |
| OPS-001 | P0 | Pinned/locked dependencies, reproducible scripts, lint/format/typecheck/unit/integration/E2E CI jobs | CI |
| OPS-002 | P0 | Single spec tracked with task/requirement IDs and CI traceability checks | traceability script |
| OPS-003 | P0 | No secrets, user photos, copyrighted sample media or generated ExifTool binaries checked into source | audit |
| OPS-004 | P1 | OS-matrix CI build/smoke for Linux/macOS/Windows; non-Linux manual gates separate | CI |
| OPS-005 | P1 | Dependency update process, changelog/release checklist, issue templates and minimal contributor setup | review |
| PKG-001 | P0 | Linux uses installed ExifTool without separately shipping Perl/ExifTool; missing executable guides user | Linux packaging test |
| PKG-002 | P2 | macOS uses installed ExifTool and supports arm64/x64 as supported; handles GUI PATH differences | macOS platform test |
| PKG-003 | P2 | Windows bundles official matching-architecture ExifTool executable **and `exiftool_files` directory**, without independently repackaging Perl | Windows installer test |
| PKG-004 | P2 | License compliance of MIT app and separately distributed ExifTool/Perl runtime components documented and verified | legal/CI audit |
| PKG-005 | P2 | Signing/notarization/release distribution policy defined and tested; unsigned prerelease clearly labeled | platform release review |
| TST-001 | P0 | Unit tests cover command building, parsing, state, capability detection and safety classifiers | CI |
| TST-002 | P0 | Real ExifTool integration tests validate reads/writes/backups/verification in temporary directories | CI |
| TST-003 | P0 | Automated frontend tests for form interactions, accessibility and error states | CI |
| TST-004 | P0 | Linux desktop E2E covers critical user journeys against a built Tauri application | CI |
| TST-005 | P1 | Performance and fuzz/property tests cover complex options, paths, files and scale | benchmarks + CI |
| TST-006 | P2 | Cross-platform build, install, smoke, and native E2E tests with manual signoff | OS matrix |
| TST-007 | P0 | Security negative tests cover injection, path escaping, malicious output and destructive operations | CI |
| TST-008 | P0 | Requirement-to-test evidence is automatically validated; no box is DONE solely by assertion of agent | traceability CI |

---

## 3. Runtime and dependency design

### 3.1 Platform dependency matrix

| Platform | Resolution | Shipping | If missing | Important risk |
|---|---|---|---|---|
| Linux MVP | Resolve `exiftool` from validated search path; permit absolute override | **System-installed ExifTool**, not Perl bundled by ExifBee | In-app installation instructions, Retry, Choose executable | Distribution PATH differences, older system versions |
| macOS later | Probe known paths plus GUI app PATH and custom override | **System-installed ExifTool** | Explain official pkg/Homebrew options, retry | Finder-launched app PATH differs from terminal; codesign/quarantine |
| Windows later | Resolve **bundled official distribution** first; optional override for system tool | `exiftool.exe` **plus companion `exiftool_files/`**, appropriate arch, as packaged resource(s) | Installer integrity error and repair guidance | Location/resource paths, binary version/arch, process startup/antivirus |

**Critical technical distinction:** The official Windows executable distribution **includes Perl**. The decision here means *ExifBee's team will not separately package a Perl runtime*. A literal prohibition on any Perl bytes in installer would conflict with bundling official Windows ExifTool; in that case Windows must instead require user-installed ExifTool. Do not silently switch models.

**Dependency choice:** For Linux/macOS do not build a bundled `exiftool` from source, invoke system `perl` directly, download executable at runtime, or require the user to find Perl modules manually. Invoke the installed `exiftool` command as a program. If its own installation requires Perl, that is managed upstream by the user's package manager/installation.

### 3.2 Executable discovery/validation

1. Try stored user override if present; require absolute existing executable path (or an explicit cross-platform selected executable reference).
2. Probe safe OS-specific known locations, then trusted process PATH; handle missing/invalid PATH and symlinks robustly.
3. Launch `-ver` with timeout, capture and parse version, reject non-ExifTool or empty/unparseable output and surface remediation. Never equate an executable filename with validation of identity or trust.
4. Linux path suggestion only: common package-managed locations (do **not** hardcode exclusive paths). Show command such as `exiftool -ver` in onboarding; package install instruction varies with distribution.
5. macOS also probe `/opt/homebrew/bin/exiftool` and `/usr/local/bin/exiftool` when appropriate (not exhaustive).
6. Windows prefer bundled path under Tauri resource resolution; keep executable and `exiftool_files` together. Packaging is verified by launching the **installed app**, not merely dev mode.
7. Create `ExifToolCapabilitySnapshot` keyed by version and path identity, using `-listf`, `-listwf`, `-listw`, `-listg*`, `-listx` as needed (large listings parsed off main thread). Refresh after path/version change.
8. Define a tested minimum ExifTool version **during S0** from feature compatibility trials; do not invent an arbitrary minimum in v1.0.0 baseline. Older versions may run in degraded, clearly documented read-only mode only if tests prove this safe.
   - **Recorded by S0-T03 (2026-10-28): tested version and provisional minimum = ExifTool 13.55** (Arch Linux `perl-image-exiftool` 13.55-1, installed at `/usr/bin/vendor_perl/exiftool`, which is not on a desktop launcher's default PATH and is therefore a probed known location). It is the only version exercised so far, so the resolver rejects older versions with an explicit "older than the minimum tested version" error. Distribution packages are mostly older (2026-10-28: Ubuntu 24.04 12.76, Debian 13 13.25, Ubuntu 26.04 13.50, Debian 12 12.57).
   - **Revised by S0-T05 (DEC-014): minimum = ExifTool 12.76**, the Ubuntu 24.04 LTS package, so users of the oldest supported LTS can use their distribution ExifTool. Evidence: the CI `integration` matrix runs every real-ExifTool test against Ubuntu 24.04 apt 12.76 and the official 13.55 release; S0-T05 cannot be checked until both legs pass. Never lower the minimum below a version that CI tests, and raise it (with a recorded reason) when a feature needs newer ExifTool behavior.
   - `-ver` output is accepted only as a bare `major.minor` version (two-digit minor). Anything else, including ExifTool's own `[Warning: Library version is …]` script/library mismatch suffix, is rejected as a broken installation and its output is shown.
   - A user override is used exclusively: if it fails validation the error is reported, never silently replaced by an auto-detected executable. Relative overrides and relative PATH entries are rejected.

### 3.3 How other tools integrate ExifTool

Existing GUIs commonly either **require an external ExifTool command** or bundle its distributable Windows executable. ExifToolGUI's documented installation procedure asks users to separately install the official ExifTool EXE; this is evidence that system/external dependency is an ordinary model, not a design failure. ExifBee's system-first Linux/macOS approach reduces third-party packaging/licensing complexity, while Windows's official executable offers an out-of-box experience.

### 3.4 Legal/distribution gate

- Application-owned code: MIT license.
- ExifTool: distributed under the same terms as Perl (Perl Artistic License or GPL options); actual third-party obligations follow the chosen distribution terms, and require confirmation at release.
- For Windows: preserve official package files, licensing/attribution notices and any relevant launcher/Perl notices. Verify redistribution terms for the exact downloaded package; no assumption that a binary is automatically MIT.
- Build script must fetch/copy pinned official release artifact from trusted URL, verify immutable checksum and fail closed on mismatch. **Do not commit the downloaded EXE or `exiftool_files` to git.** Publish provenance and hashes as release artifacts.
- No unrelated ExifTool code copied into ExifBee; review jExifToolGUI/other GUI source licenses before adapting code.
- Display "Powered by ExifTool by Phil Harvey" in About with explanatory independent-project attribution.
- A release **cannot pass PKG-004** until notices/license review is recorded; this is an engineering compliance gate, not legal advice.

---

## 4. Software architecture

### 4.1 Context and trust boundaries

```text
+--------------------------------------------------------------+
| ExifBee desktop application (Tauri v2)                       |
|                                                              |
|  React + TypeScript WebView (untrusted data presentation)     |
|   File workbench | Tag browser | Editor | Plan | Logs | Theme |
|          | Typed IPC (minimal commands, no generic shell)    |
|          v                                                   |
|  Rust Application Layer                                      |
|   - selection/session and scoped paths                       |
|   - tag/capability inventory                                 |
|   - planner + validation + risk classification               |
|   - queue + cancellation + job event stream                  |
|   - read/write verifier + backup/output policy               |
|          |                                                   |
|          v                                                   |
|  ExifTool Adapter                                            |
|   - executable resolver / version probe                      |
|   - argv or validated -@ arguments; output parsing           |
|   - bounded process worker / optional -stay_open pool        |
|          | (OS process, no shell)                             |
+----------|---------------------------------------------------+
           v
   ExifTool process --> user-chosen filesystem targets
           |
           +-- stdout/stderr/status --> Rust structured events
```

**Trust boundaries:** Files, paths, metadata values, tags, stdout/stderr, imported arg files and advanced arguments are untrusted. The WebView is not granted arbitrary filesystem or shell capability. Rust validates job intent and enforces scopes at the point of execution, not only in React.

### 4.2 Recommended repository layout (avoid documentation proliferation)

```text
exifbee/
  README.md
  LICENSE
  THIRD_PARTY_NOTICES
  docs/SPEC.md                    # this exact document (canonical; see DEC-012)
  package.json, package-lock.json # choose one lockfile/tool
  src/
    app/                           # boot, routes/panes, providers, themes
    features/files/                # selection, table, folder tree
    features/metadata/             # tag inspector, search, editor
    features/operations/           # staged plan and confirmation
    features/jobs/                 # progress and log views
    features/settings/             # dependency status, theme
    components/                    # accessible shared UI primitives (one CSS file each)
      atoms/                       # basic building blocks: Button, Select, …
    lib/ipc/                       # generated/checked typed contract
    lib/models/                    # view models, not process control
  src-tauri/
    src/
      main.rs, lib.rs
      commands/                    # narrowly-scoped Tauri commands
      domain/                      # plans, capabilities, errors
      service/                     # discovery, orchestration, verify, history
      adapter/exiftool/            # argv, process, parser, stay_open
      safety/                      # policy, scope, preflight
      platform/                    # OS-specific path/package resolution
    capabilities/                  # Tauri permission manifests
    icons/
    resources/                     # packaging manifest (no committed Windows binary)
    tauri.conf.json
  tests/
    fixtures/                      # synthetic or redistributable files
    integration/                   # real ExifTool fixture suites
    e2e/                           # WebdriverIO desktop workflows
    performance/                   # repeatable benchmark harness
  scripts/
    check-spec-traceability.*
    verify-exiftool-artifact.*
    generate-fixtures.*
  .github/workflows/
```

Use the repository's chosen package manager consistently; lock the toolchain, Rust dependencies (`Cargo.lock`), and JS dependencies. Avoid introducing global application state frameworks or SQLite until a measured need exists. Use a small typed state layer (React context plus reducer or a single minimal store) for current selections/plan/jobs. Store application settings in an atomic JSON config under OS app-config directory. Logs are opt-in/rotated JSONL in OS app-data directory (no full metadata dumps by default); add SQLite only if actual history/query requirements justify it.

### 4.3 Domain objects and typed IPC

Model concepts (illustrative shape; adjust code naming once and generate bindings, rather than manually duplicating schemas):

```ts
type FileId = string;              // opaque ID, not user-controlled path in IPC

type MetadataValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; raw?: string }
  | { kind: 'list'; items: MetadataValue[] }
  | { kind: 'structure'; entries: Record<string, MetadataValue> }
  | { kind: 'binary'; byteLength?: number; exportable: boolean }
  | { kind: 'unknown'; display: string };

type TagDescriptor = {
  groupFamily0?: string;
  groupFamily1?: string;
  groupFamily4?: string;       // distinguishes same-name tags/instances
  tag: string;
  occurrence?: number;
  humanLabel?: string;
  value: MetadataValue;
  writeCapability: 'yes' | 'no' | 'unknown';
  reason?: string;
};

type Operation =
  | { type: 'set-tag'; group: string; tag: string; value: MetadataValue }
  | { type: 'delete-tag'; group: string; tag: string }
  | { type: 'delete-group'; group: string }
  | { type: 'copy-tags'; sourceFileId: FileId; groups?: string[] }
  | { type: 'advanced-args'; args: string[]; declaredOutputs: string[] };

type WritePolicy = {
  backup: 'exiftool-default' | 'explicit-overwrite';
  preserveMtime: boolean;
  confirmHighRisk: boolean;
};

type JobPlan = {
  jobId: string;
  targetFileIds: FileId[];
  operations: Operation[];
  policy: WritePolicy;
  expectedFileIdentity: Record<FileId, { size: number; mtimeMs: number }>;
};

type JobEvent = {
  jobId: string;
  at: string;
  kind: 'started'|'file-started'|'progress'|'warning'|'error'|'file-done'|'cancelled'|'finished';
  fileId?: FileId;
  message: string;
  details?: unknown;
};
```

**Important:** ExifTool output is heterogeneous. `-j -a -G1:4 -s` avoids duplicate tag-name collisions (keys like `IFD0:Make` and `XMP-tiff:Copy1:Make`; `-G4` alone drops the group name, see DEC-015); distinguish `SourceFile`, tag group families, numeric/raw representation, embedded documents and repeated instances. Some outputs contain binary data, arrays or nested XMP. The actual domain model must preserve enough identity, order and raw fidelity to avoid mistaken edits. Do not assume JSON property name alone is a unique writable tag target. Discover writability at tag + format + group combination when possible; if unknown, never silently promise it.

Recommended typed command boundaries:

```text
exiftool_status() -> ExecutableStatus
set_exiftool_override(path?) -> ExecutableStatus
list_capabilities(page?) -> CapabilityPage
add_files(paths_selected_via_dialog) -> FileHandle[]
add_directory(selection, recursion_policy) -> ScanJobId
read_metadata(file_ids, options) -> JobId
plan_operations(selection, operations, policy) -> PlanPreview
execute_plan(approved_plan_id) -> JobId
cancel_job(job_id) -> Outcome
retry_failed(job_id) -> JobId
get_job_events(job_id, cursor) -> JobEventPage
export_job_log(job_id, save_path) -> Result
get_preferences()/set_preferences() -> Preferences
```

No `execute_arbitrary_command(command: string)`, `read_any_path(path)` or `exec_shell(...)` generic IPC endpoint. Advanced arguments must be passed through a distinct validated planner bound to explicit selected files and named outputs.

### 4.4 Process execution / stdout protocol

- Use Rust's `std::process::Command` or `tokio::process::Command` with a validated executable path and **separate OS arguments**; no shell interpolation or eval.
- For large argument counts, use ExifTool's `-@ ARGFILE` or persistent `-stay_open` protocol only after careful handling of UTF-8, newlines, argfile special syntax, and platform nuances; create private temp files with restrictive permissions, delete after use, and do not insert untrusted options into an unreviewed arg stream.
- Use `--` end-of-options where appropriate for **positional** file paths beginning with hyphens; verify exact ordering per ExifTool invocation mode and protect `-@` argument boundaries. Paths beginning `-` must never be construed as an option.
- Distinguish stdout data, stderr diagnostics, process exit, and ExifTool warnings embedded in file metadata (`Error`/`Warning`) when using JSON.
- Reads should prefer structured JSON in bounded batches (for example 50–200 files initially, configurable after benchmarking) with batched progress. CSV output can buffer large datasets; do not use it as the internal canonical read format.
- Writes may allocate ExifTool's own temp files; surface disk-space failures and interruption semantics, and do not claim application-level atomicity across multi-file jobs.
- For `-stay_open`, use a dedicated serialized request dispatcher, request IDs/ready markers, single-writer command stream, response framing, worker restart on protocol desynchronization, and deterministic shutdown. No mixing stdout from independent jobs.
- **Design input from S1-T03 import review (2026-10-29), ExifTool 13.55, 8-core Linux, 1×1 JPEG fixtures; indicative only, not a benchmark (NFR-006/S3-T06 own real numbers):** one process per file ≈ 55 ms/file; one batched call ≈ 1.9 ms/file; `-stay_open` one request at a time ≈ 2.5 ms/request; listing names only ≈ 430k files in 2 s. Consequences for S2/S3: never spawn per file; batch reads; serve the selected file through `-stay_open`; enumerate first and read metadata on demand; keep bulk metadata in Rust and send the renderer summaries. A whole-disk browser was rejected in favor of user-authorized roots (folder tree + virtualized file table, §5.1) plus recent folders (FR-019). In a `-stay_open` argument stream, a request containing `--` before the path stalled without a `{ready}` reply; S2-T03/S2-T05 must define the stay_open argument framing separately from one-shot argv.
- **Recorded by S0-T06 (2026-10-28), ExifTool 13.55 on Linux:**
  - A file ExifTool cannot parse (e.g. empty) still yields JSON with `ExifTool:Error`, but the exit status is 1; per-file outcome therefore comes from the JSON, and the exit status only matters when no JSON is printed (e.g. `Error: File not found` on stderr).
  - Passing a directory makes ExifTool read every file in it, so a single-file read rejects non-regular files before spawning.
  - Absolute paths never begin with `-`; reads pass `--` before the path as well. Hostile names (quotes, `;`, `$()`, backticks, globs, newline, leading hyphen, Unicode) and >1 KiB paths round-trip unchanged in `SourceFile`.
  - Unquoted JSON numbers lose their text form when parsed as floating point (`13.50` → `13.5`); S2-T05 must keep the raw number text (e.g. `serde_json` `arbitrary_precision`) to meet the `raw` fidelity of §4.3.
  - On a killed child, a grandchild can keep the output pipes open (e.g. Ubuntu's dash `/bin/sh` does not exec the last command), so the runner returns without waiting for EOF; process-group termination belongs to S2-T03.
  - The native dialog is opened from Rust (`tauri-plugin-dialog`), so the renderer never supplies a filesystem path; no capability file grants plugin permissions, so the renderer cannot call the dialog or `tauri-plugin-fs` (pulled in by the dialog crate) directly.

### 4.5 Operation planner and file safety

**Read workflow:** select → scan/import → read → inspect. No write approval.

**Write workflow:** select → stage changes → verify capability + target state → preview/command → explicit approval → execute bounded queue → re-read changed fields → report results/backup paths.

Mandatory preflight:

- Check file still exists and matches captured size/mtime (optionally stronger file identity/hash for rename/copy); reject or ask to refresh on concurrent changes.
- Resolve/inspect paths and symlinks. Protect against traversal and symlink swaps (recheck at execution); do not imply perfect TOCTOU elimination without OS-specific handles. Display intended real paths, especially in recursive jobs.
- Check read-only/writability, destination collisions, backup location/name clashes, same source/destination, disk availability where determinable, and unsupported tag/file types. If a property cannot be proven, mark `unknown` and require appropriate policy.
- Group targets by compatible operation and file capabilities; skip unsupported files with visible reasons. Do not abort unrelated valid files on one failure unless selected `stop on first error`.
- Preserve ExifTool's `_original` backup behavior by default, **including clear visibility of pre-existing backup collisions**; never delete backups automatically. Overwrite and in-place overwrite are distinct policies with distinct implications.
- `-overwrite_original_in_place` may preserve attributes more faithfully but can be slower and has distinct risks; treat as an advanced explicit option.
- Modifying filesystem `FileName`/`Directory`, timestamps, extracting binary data or writing output files must be treated as **filesystem operations**, not harmless scalar metadata edits.
- After writes, read the resulting tags back and validate semantic postconditions. If ExifTool reports `0 updated` or values mismatch, report no-change/warning/failure rather than success.
- Multi-file jobs are **not transactions**. Never promise rollback of an entire collection; show per-file outcome and backup/recovery instructions.

### 4.6 Advanced argument risk policy

The goal is to expose the full ExifTool CLI **without** becoming an arbitrary host shell or accidentally executing dangerous input. Implement a tokenizer/argument editor, never shell interpretation. Categorize:

| Risk | Examples | Default policy |
|---|---|---|
| Read-only | `-j`, `-G4`, `-s`, metadata listing, diagnostics | Execute on selected scope; bounded output |
| Controlled write | `-TAG=value`, `-TAG=`, `-TagsFromFile` | Build/preflight/confirm structured plan; backups |
| High impact | `-all=`, `-r`, `-FileName=...`, `-Directory=...`, overwrite options, bulk output creation, large scope | Show affected target/destination preview; dedicated high-risk confirmation |
| Code/argument injection vectors | `-config` (user Perl code), `-@` (arguments), `-stay_open`, `-execute`, user-declared alternate outputs | Disabled for implicit execution; require explicit local-file trust and separate high-risk review if intentionally supported. Never automatically execute unknown configs or allow protocol control to defeat planner |
| External process/shell | shell pipelines, redirects, `;`, `&&`, arbitrary EXE | Not accepted as a shell; show instructions to use a real terminal independently |

A blanket whitelist of "known safe tags" would contradict broad ExifTool support. Instead classify **option effects** and **destinations**; allow uncommon ExifTool options when their full effects can be preflighted, and expose explicit limitations for commands ExifBee cannot safely execute. If user demands exact unrestricted ExifTool CLI behavior, they can copy the generated command into their terminal; the UI must not claim unrestricted arbitrary scripting support.

---

## 5. Interaction and visual design specification

### 5.1 Information architecture

```text
┌────────────── ExifBee  [File] [Edit] [View] [Tools] [Help] ──────────────┐
│ Toolbar: Add files | Add folder | Inspect | Stage edit | Run | Settings │
├──────────────────┬───────────────────────────────────────────────────────┤
│ FILES / FOLDERS  │ FILE METADATA                                        │
│ filter / tree    │ Search tags [               ] Group / Writable / All│
│  file1.jpg       │ ┌───────────────────┬──────────────────────────────┐  │
│  file2.pdf       │ │ Tag/group         │ Value                        │  │
│  file3.mp4       │ │ ...               │ ...                          │  │
│  data.zip        │ └───────────────────┴──────────────────────────────┘  │
├──────────────────┴───────────────────────────────────────────────────────┤
│ ACTION DRAWER: staged changes → target count → preview → confirm/run    │
├──────────────────────────────────────────────────────────────────────────┤
│ LOG / COMMAND: command | progress | warnings | per-file results         │
└──────────────────────────────────────────────────────────────────────────┘
```

This is a *layout contract*, not a request for pixel-perfect screenshot replication. Default to a roomy, utilitarian UI; panes resize and persist preference. No mandatory preview/thumbnail dependency. Plain file icon/extension/type/size is sufficient for every format. For supported image previews, a future optional thumbnail is non-MVP and must never block metadata work.

### 5.2 Main screens and states

1. **Welcome / dependency health:** local/offline statement; detected path/version; installation hints on missing Linux/macOS dependency; Choose path; Retry; never a blank screen.
2. **Workbench:** mixed file/folder list with row status/type/size; metadata inspector grouped by ExifTool group families; filter read-only/writable; tag value copy; no assumption that every file has EXIF tags.
3. **Edit drawer:** add tag selector with group and capability, edit scalar/list/structured where supported, removal controls; staged modifications with visible undo before execution.
4. **Plan and confirmation:** target files/count, selected tag changes, unsupported/skipped files, backup policy, CLI equivalent, known risks and confirmation action.
5. **Jobs/log drawer:** asynchronous progress, cancel, warnings, per-file outcomes, copy/export log and retry failures. Logs do not pretend to be an OS terminal.
6. **Advanced mode (P1):** typed token list/argument input, parsing errors, previews, high-risk confirmation, links to relevant upstream docs. Default collapsed/hidden from novice path.
7. **Settings/About:** theme, path/version/status, optional log retention, preserve modification time default, ExifBee/ExifTool versions, license acknowledgments.

### 5.3 Component inventory

`AppShell`, `MainToolbar`, `FileCollectionPane`, `FolderTree`, `FileTable`, `MetadataInspector`, `TagGroupSelector`, `TagSearch`, `MetadataValueView`, `MetadataValueEditor`, `StagedOperations`, `CommandPreview`, `PlanReviewDialog`, `JobProgress`, `JobLog`, `DependencyHealth`, `PreferencesDialog`, `ThemeSwitcher`, `AdvancedArgumentsEditor`, `Toast/InlineError`.

No raw `innerHTML`, untrusted HTML rendering, or arbitrary image/media preview loading based on metadata URLs. Sanitize/escape display strings by normal React text binding.

### 5.4 Themes and tokens

- Themes: **Light**, **Dark**, **System (default)**. Use CSS variables with semantic tokens (`--bg`, `--surface`, `--surface-raised`, `--text`, `--text-muted`, `--border`, `--accent`, `--danger`, `--warning`, `--success`, `--focus`) rather than hard-coded per-component colors.
- A restrained honey/amber accent may connect to the ExifBee name, but **not** as a high-saturation background. Use neutral surfaces, readable tabular monospace for commands/logs and a neutral sans serif for other content.
- WCAG AA target for normal text contrast (4.5:1), non-text UI components (3:1 where applicable), visible focus rings; theme contrast must be tested on error/warning text and disabled states.
- Persist explicit user preference; system mode listens to OS theme changes; avoid a flash of wrong theme on launch.
- Supports keyboard-only flow, clear heading/landmark hierarchy, distinguish color and icons with text, accessible modals, reduced motion, 125–200% display scaling, small laptop width and enlarged text.
- Keyboard shortcuts must be discoverable in menus/tooltips and must not conflict with normal text-input behavior. Proposed: Ctrl/Cmd+O add files, Ctrl/Cmd+F find tag, Ctrl/Cmd+Enter open plan (not run without confirmation), Esc close transient panel, Ctrl/Cmd+, settings. Final shortcuts tested on platforms.
- **Recorded by S1-T02 (2026-10-28):** tokens live once in `src/styles/tokens.css` using CSS `light-dark()`, so System mode is pure CSS (`color-scheme: light dark`) and follows OS changes live without a JS listener; Light/Dark pin `data-theme` on `<html>`. `light-dark()` needs WebKitGTK ≥ 2.46 (Safari 17.5 engine), which every supported Linux target ships via updates. The explicit choice is stored in WebView `localStorage` and applied by `public/theme-init.js`, a classic script in `<head>`, before first paint; it moves into the S1-T04 config file only if a Rust-side consumer needs it. Contrast for every rendered foreground/background pair is asserted per mode by `src/styles/tokens.test.ts`. Styling is plain CSS: global `tokens.css` and `base.css` (element resets) only, and one co-located CSS file per component; basic controls are atoms in `src/components/atoms/`, added only when a second use or a shared look exists, not ahead of need.
- **Recorded by S1-T03 (2026-10-29):** shortcuts are discoverable through tooltips/`aria-keyshortcuts` and a Keyboard shortcuts dialog (toolbar button) fed by one list (`src/app/shortcuts.ts`); global shortcuts are only Ctrl/Cmd+O and Esc, because F1 and F6 did not reach the app in WebKitGTK on the maintainer's KDE desktop and are not needed (Tab reaches every area); a native application menu bar is deferred until menus carry actions the toolbar does not, so the §5.1 menu row is not built yet. Modals use the native `<dialog>` (`components/Dialog`): page inert, Esc closes, Tab wraps inside (WebKit/Chromium otherwise let Tab leave the document), focus returns to the opener. Scrollable regions without focusable content are Tab stops. Read outcomes are announced through the toolbar `status` live region; errors use `role="alert"`; the session log is a `role="log"` region. Tag tables use row headers. A global `prefers-reduced-motion` rule neutralizes any future animation. axe (WCAG 2.2 A/AA tags) runs in the renderer tier for every UI state in both themes and must report zero violations.

### 5.5 Copy and error-state language

- Missing tool: "ExifTool was not found. Install it using your Linux package manager, then choose Retry or select the executable path." (macOS adapted; Windows reports bundle error).
- Read-only: "This tag or file format is not writable through the selected ExifTool version." Avoid attributing all inability solely to the extension.
- Unknown support: "Write support could not be confirmed. ExifTool may reject this operation; the original will be backed up.".
- Batch partial failure: "142 files updated, 3 skipped, 2 failed; review results." Never say "Completed successfully" if files failed.
- Advanced mode: "These are ExifTool arguments, not shell commands. Options that rename, remove or overwrite files require review."

---

## 6. Testing strategy and source of truth

### 6.1 Test pyramid and boundaries

| Layer | Tooling recommendation | Must test | CI disposition |
|---|---|---|---|
| Type/static | TypeScript strict, ESLint, Rust clippy, fmt, dependency audit | IPC contracts, null/error handling, unsafe dependencies | each PR |
| Rust unit/property | `cargo test`, proptest (selective) | command planning, path checks, policies, error mapping, tokenizing | each PR |
| UI component/unit | Vitest + React Testing Library (axe runs in the renderer E2E tier, which has real layout for contrast rules) | states, forms, tag rendering, theme, keyboard | each PR |
| Real integration | Rust harness + real pinned ExifTool in sandbox/temp directory | all read/write/delete/copy/backups/output scenarios | each PR on Linux |
| Renderer E2E | Playwright (`@playwright/test`, Chromium) with mocked IPC (DEC-017) | complex UX, real layout/CSS/theme behavior and pinned-container screenshot snapshots without a native window | each PR |
| Native desktop E2E | WebdriverIO `@wdio/tauri-service` using documented supported provider; final tool chosen at S3-T07 (DEC-017) | select/read/stage/write/verify/log and dependency failures | Linux CI, later OS matrix |
| Performance | controlled fixture runner, UI profiling, RSS/CPU metrics | 1k/10k inventory, large metadata, batch writes, cancellation | scheduled + pre-release |
| Manual signoff | checklist and recorded OS/app/tool versions | window behaviors, OS install, accessibility, AV warnings, external drives | per platform gate |

**Tauri note:** Direct `tauri-driver` supports Linux/Windows, not WKWebView on macOS. The current WebdriverIO Tauri service documents an **embedded driver provider supporting macOS**; assess security/testing-only plugin configuration, isolate from production builds if appropriate, and verify on real macOS rather than assuming direct `tauri-driver` parity. Pin compatible versions of E2E plugins to avoid drift.

#### 6.1.1 Pyramid strategy (living rules)

Tiers, from many fast tests to few realistic ones. Each tier proves what the tiers below cannot; none substitutes for another.

| Tier | What runs | Where / command | Proves | Never proves |
|---|---|---|---|---|
| 1 Static | nothing executes | `lint`, `typecheck`, `format:check`, `audit:deps`, `test:traceability` | types, style, dependency advisories, requirement links | runtime behavior |
| 2 Unit / component | functions; React components in jsdom (no layout) | `src/**/*.test.ts(x)`, `scripts/*.test.mjs`, Rust `#[cfg(test)]`; `test:unit` | logic, state, focus, escaping, token contrast | real layout, real browser, ExifTool |
| 3 Real integration | Rust adapter with real ExifTool on fixtures in temp copies | `src-tauri/tests/*.rs`; `test:integration` | ExifTool behavior, paths, errors, bounds, file safety | UI |
| 4 Renderer E2E | built frontend in Chromium, Tauri bridge mocked | `tests/renderer/*.e2e.ts` (`behavior`, anywhere) and `*.snapshots.e2e.ts` (pixels, pinned container only); `test:e2e:renderer`, `test:e2e:renderer:docker` | real layout/CSS, theme pre-paint, OS-theme following, visual snapshots | WebKitGTK quirks, Rust, native window |
| 5 Native desktop E2E | the built app: WebKitGTK + Rust + real ExifTool | `tests/e2e/` from S3-T07 | full user journeys on the real engine | other OSes until their stage |
| 6 Manual sign-off | maintainer on the real OS | task checkbox notes | look/feel, OS integration, what tiers 4–5 cannot reach yet | regressions (not repeatable) |

Rules:
1. Put each assertion at the lowest tier that can observe it; move up only when a lower tier cannot (layout → 4; WebKitGTK rendering, window behavior → 5, else 6).
2. A mocked-IPC test (tiers 2 and 4) is never evidence for Rust or ExifTool behavior; file reads/writes are proven at tier 3 with real ExifTool.
3. Screenshot snapshots cover stable visual contracts only, stay few, compare one baseline per snapshot from the pinned Playwright image, and are regenerated only for a reviewed intentional visual change.
4. A task's completion note states which tiers proved each acceptance item and which gaps remain open, and where they are tracked (e.g. native 200% check → S3-T07).
5. A check that keeps recurring in manual sign-off is promoted to an automated tier at the first task that can host it.

Update this section (with a DEC entry when a tool changes) when: S3-T07 chooses the native tier tool (candidates: WebdriverIO `@wdio/tauri-service`, `tauri-plugin-playwright`, `tauri-pilot`; any in-app control plugin must be a default-off cargo feature absent from release builds, with a test proving it); a new platform stage adds a runner (S7 macOS, S8 Windows); a tier becomes a required CI check or changes its gating (§6.5); or a tier's tool, browser image or snapshot policy changes.

### 6.2 Fixture corpus

Keep small legally redistributable/synthetic fixtures with controlled known metadata and checksums; document generated sources as code/config (not extra narrative docs). At minimum:

- Writable: JPEG with EXIF/XMP, PNG XMP/text where writable, TIFF, MP4/MOV test sample, PDF metadata, XMP sidecar, selected audio format (e.g. MP3), and other ExifTool-writable type if supported by test tool version.
- Read-only/limited: ZIP or 7z, relevant RAW, executable/font/document sample with readable-only metadata as recognized by tested version.
- Edge cases: no metadata, duplicate group/tag names, nested/list XMP, Unicode values (Arabic/CJK/emoji), arbitrary binary blob, malformed and truncated files, whitespace and linebreak/leading-dash filenames, long/deep paths, empty folder, symlink loop, symlink outside selected scope, read-only directory, name collision, nonexistent path, 0-byte input, stale modified file.
- Use generated **temporary copies** for all destructive tests; never mutate golden fixtures. For each fixture record baseline metadata digest/expected values, not only file hash.
- Platform-specific fixture tests adapt to file permissions/symlink support rather than silently skipping essential safety tests.
- **Recorded by S0-T04 (2026-10-28):** the corpus is generated byte-for-byte by `scripts/generate-fixtures.mjs` (`npm run fixtures`; `--check` verifies) into `tests/fixtures` with a `sha256sum`-compatible `SHA256SUMS`, and `.gitattributes` disables line-ending conversion there. Every byte and metadata value is ExifBee-authored (MIT); the only seed is a 1×1 solid-grey JPEG image, which has no creative content. Source-license research: ExifTool's bundled test images and third-party sample-media sites carry their own or unclear terms, so none are copied; user photos are never committed. Baseline (JPEG EXIF/XMP/comment, PNG text, PDF Info, XMP sidecar with list/struct/Unicode and duplicate `Make` across groups, read-only ZIP, no-metadata, empty and truncated files) has expected values asserted with real ExifTool. Formats and filename edge cases still missing from the list above are added by the tasks that first need them (S2-T05, S2-T06, S6-T07). Hostile filenames are created in temp copies, not committed, because they are not portable across checkouts.

### 6.3 What tests must verify

- **Contract:** ExifTool returned fields/tags and a known list of values are represented without collapsing distinct groups or duplicate tag identities.
- **Behavior:** Write the expected tag, read it back, verify backup, verify unrelated metadata and content where technically supported; distinguish no-change from written.
- **Negative:** Unsupported write, malformed metadata, missing executable, wrong executable, partial failures, cancel during batch, timeout/hung process, nonzero exit, output overflow, malicious metadata markup, tag/path injection, symlink/path scope escapes.
- **E2E:** A user can go from empty workspace → import mixed files → inspect → stage → approve → write → verify → inspect/log, and can diagnose common failure states without opening a terminal.
- **Offline:** Build app with local assets, disconnect network, run all core workflows and demonstrate no network dependency.
- **Accessibility:** Keyboard-only read/write plan, error announcements, focus restoration, contrasts in both themes; automated audits do not replace manual spot checks.

### 6.4 Performance budgets (targets, not unmeasured guarantees)

Record hardware/OS, ExifTool version, cold/warm cache, file sizes, throughput, peak app RSS, ExifTool child RSS, elapsed wall time, and 95th-percentile UI event latency. Do **not** turn unreliable shared-CI timings into hard release failures without a dedicated consistent runner.

**Initial engineering targets on a representative Linux development machine, calibrated in S3:**

- App shell becomes interactive in **≤ 2 seconds warm start** (excluding first-time OS WebView initialization; measure baseline).
- File inventory for **10,000 directory entries** does not lock the UI for more than **100 ms continuously**; show progress in chunks.
- Metadata table displays **10,000 rows** via virtualization with no O(n²) filtering/sorting and no sustained input lag above **100 ms** during ordinary scrolling/filtering.
- User-visible progress begins within **1 second** of launching a 1,000-file read job on local SSD (allow a clearly documented cold-start exception).
- No unbounded memory growth: hold only selected/paged results and a bounded job event ring in RAM. Define measured RSS regression limits after baseline rather than making up universal MB limits.
- Batch memory roughly proportional to concurrent workers × batch size × average metadata payload, **not all files in the collection**. ExifTool itself may buffer particular outputs; avoid giant single-shot CSV/JSON exports.
- Compare naive process-per-file vs batch and `-stay_open` with representative files; adopt the simpler option when equivalent within a justified margin.
- Repeated benchmark runs should report distribution and a regression alert threshold (initial proposal >25% median degradation on controlled runner) for human investigation, not automatically blame code without environmental confirmation.

### 6.5 CI stage gating

- PR: formatting, lint, Rust/TS typecheck, unit, traceability, security negative tests, real ExifTool integration (Linux), selected renderer E2E; required status checks branch-protected.
- Linux release candidate: native E2E, performance profile, clean install on supported distros and dependency-missing UX, artifact inspection and offline checks.
- Cross-platform release candidate: native test matrix for Linux/macOS/Windows, notarization/signing policy and all package validation; platform-specific manual signoff.
- Tests must not use a mocked ExifTool as the *only* evidence for file writing. A fake executor is fine for UI error simulation and planner unit tests.

---

---

## 7. Delivery roadmap, dependencies and execution policy

**Stage dependency graph:** `S0 → S1 → S2 → S3 → S4 → S5 (Linux MVP) → S6 (full ExifTool breadth) → S7 (macOS) / S8 (Windows) → S9 (multi-platform release)`. S7 and S8 may be implemented independently after S6. Critical security and test infrastructure are developed throughout, not bolted on at the end.

**Interpretation of per-task contracts below:** Every task has a narrow implementation instruction, verification evidence, and acceptance criteria. An agent should implement only the named task, avoid work from future stages unless necessary for a tested dependency, and report the exact commit/test evidence. Task checkboxes are **initially all unchecked**. Agents must not declare whole stages complete merely because the UI visually appears functional.

### Stage S0 — Product baseline, feasibility spike and project foundation

**Goal:** A reproducible Linux dev environment and proven ExifTool process interface, before UI complexity.

- [x] **S0-T01 — Initialize repository and toolchains.** *(2026-10-28, `feature/linux-mvp`: maintainer confirmed `npm run dev` opens the window on Linux; recorded exception — CI evidence deferred by the maintainer until S0-T05 adds CI.)* Create Tauri v2/Rust/React/TypeScript (strict) repository, package/Rust lockfiles, reproducible `dev`, `build`, `test`, `lint`, `typecheck`, `format` scripts. Configure supported Node/Rust minimums based on actual Tauri v2 requirements and pin CI versions. **Acceptance:** Fresh Linux clone builds/opens window without manual code edits; `npm ci` (or chosen lockfile equivalent) and `cargo test` pass; no cloud service or mobile Tauri targets. **Evidence:** `OPS-001`, `NFR-004` CI build.
- [x] **S0-T02 — Install the single-spec workflow.** *(2026-10-28, `feature/linux-mvp`: maintainer approved; spec kept at `docs/SPEC.md` per DEC-012; recorded exception — preflight CI run deferred by the maintainer.)* Save this file as `SPEC.md` without splitting it, implement `scripts/check-spec-traceability` with duplicate/unknown ID detection, status syntax, and completed-task evidence checking; add preflight CI job. **Acceptance:** Intentional malformed IDs, stale test annotations, and checked automatable tasks lacking traceable test evidence make CI fail; correct baseline passes without counting TODO requirements as missing. **Evidence:** `OPS-002`, `TST-008` test harness fixtures.
- [x] **S0-T03 — Prove ExifTool resolver on Linux.** *(2026-10-28, `feature/linux-mvp`: maintainer approved; tested with ExifTool 13.55 on Arch Linux, provisional minimum recorded in §3.2; recorded exception — CI run deferred by the maintainer.)* Write a standalone Rust adapter spike that resolves system `exiftool`, runs `-ver`, captures stdout/stderr/status and handles nonexistent executable and version mismatch. Document actual tested version/minimum compatibility in this file after evidence. **Acceptance:** 3 scenarios (installed/missing/invalid binary) have integration tests; no shell calls. **Evidence:** `FR-001`, `SEC-002`.
- [x] **S0-T04 — Establish legal and fixture baseline.** *(2026-10-28, `feature/linux-mvp`: maintainer approved; fixtures regenerate byte-identically and real ExifTool 13.55 reads their expected values; Windows notice review stays open in `THIRD_PARTY_NOTICES` until S8-T05; recorded exception — CI run deferred by the maintainer.)* Add MIT `LICENSE`, accurate ExifTool attribution/third-party notice placeholder, synthetic/legal fixture generator and checksums; research source metadata licenses. **Acceptance:** no binary ExifTool/Perl in git; fixtures may be redistributed; documented Windows notice review is open until its stage; fixture generation is repeatable. **Evidence:** `OPS-003`, `PKG-004` early audit.
- [ ] ⛔ BLOCKED (first CI run deferred by the maintainer until the MVP draft PR) **S0-T05 — Add Linux CI quality gates.** GitHub Actions or equivalent for JS/Rust lint/format/build, real Linux ExifTool installed from package manager, unit/integration and coverage artifact, dependency audit and traceability check. **Acceptance:** Clean CI passes without local mutable dependencies; intentionally failing integration and safety test correctly blocks PR. **Evidence:** `OPS-001`, `TST-001`, `TST-002`.
- [x] **S0-T06 — Architectural decision spike.** *(2026-10-28, `feature/linux-mvp`: maintainer confirmed in `npm run dev` that the Rust-opened native dialog reads a PNG and a real PDF and that cancelling returns to the empty state; integration tests cover JPEG/PDF/ZIP/text, per-file errors and hostile >1 KiB paths with ExifTool 13.55; findings recorded in §4.4 and DEC-015; recorded exception — CI run deferred by the maintainer.)* Validate Tauri IPC command pattern and native-dialog selection, real path handling and installed ExifTool behavior on a test JPG and non-image fixture. Commit thin prototype or replace it with clean production adapter; do not retain two competing execution paths. **Acceptance:** Demonstrate `read one mixed-format file` through Rust and return structured error; record any discovery that changes this spec. **Evidence:** `FR-003`, `FR-005`, `NFR-005`.

**Gate `G0` — S0 accepted when:** All S0 tasks done; reproducible Linux startup; ExifTool system invocation proves reads on image and non-image fixtures; CI and traceability checks actually block failing changes; baseline tooling/fixture licenses reviewed. **No production feature claims yet.**

### Stage S1 — App shell, settings, theming, accessibility foundation

**Goal:** Stable UI architecture with three working themes, interaction states, and typed IPC, before editing files.

- [x] **S1-T01 — Build the application shell.** *(2026-10-28, `feature/linux-mvp`: maintainer approved the shell in `npm run dev` (`GDK_SCALE=2` had no visible effect on that Wayland session, so 200% was not exercised natively); 200% evidence is the renderer layout measured at 1280×800, 910×512 and 640×400 with every critical control in view and no page scroll; window minimum lowered to 480×320 because 800×560 cannot fit the 640×400 logical screen of a 1280×800 display at 200%; recorded exceptions — CI deferred by the maintainer, native 200% check and native E2E open until S3-T07.)* Implement toolbar, file pane, metadata area, operation drawer and log drawer; keyboard navigation and resize behavior. Keep empty state useful. **Acceptance:** Works at 1280×800 and a small laptop viewport; no overlap/clipped critical controls at 200% scaling; focus survives pane changes. **Evidence:** `UX-001`, `UX-005`, `UX-008` component/E2E.
- [x] **S1-T02 — Theme tokens and persistence.** *(2026-10-29, `feature/linux-mvp`: maintainer approved both themes in `npm run dev`. Tier 2: token contrast per mode, preference persistence, pre-paint script, switcher. Tier 4 (DEC-017): pre-paint before app scripts, all modes persist across reloads, System follows OS changes live, explicit theme ignores OS; six light/dark snapshot baselines generated in the pinned Playwright image and reviewed. Open: snapshot comparison runs first in CI (deferred by the maintainer); native WebKitGTK relaunch flash and live OS following → S3-T07.)* Implement light/dark/system using semantic CSS variables; use OS preference listener and persisted explicit setting loaded before full UI render. **Acceptance:** All three modes persist/reload correctly, system mode follows OS change, no visibly wrong flash, all primary text/control contrasts meet target; screenshot snapshots in both themes. **Evidence:** `UX-002`, `UX-003`.
- [ ] ⏳ IN PROGRESS (Claude, feature/linux-mvp) **S1-T03 — Basic accessibility contract.** Accessible menus/dialogs, focus management, ARIA labels/live regions, reduced-motion preference, keyboard shortcuts, WCAG AA audit with axe. **Acceptance:** Critical flows operable keyboard-only; no critical automated axe failures and manual spot check completed; interactive controls have accessible names. **Evidence:** `UX-004`, `FR-019`.
- [ ] **S1-T04 — Settings and dependency states.** Config save/load with safe default/version migration; dependency status card, path override input/file picker, reload/retry and About information. **Acceptance:** Missing/invalid ExifTool gives actionable message rather than crash; override persists and can reset; corrupt config recovers with explicit warning. **Evidence:** `FR-001`, `FR-002`, `NFR-007`, `UX-010`.
- [ ] **S1-T05 — Typed IPC and error taxonomy.** Generate or type-check Rust↔TS command bindings; define `AppError` domains (`DependencyMissing`, `Unsupported`, `InvalidInput`, `ScopeViolation`, `ProcessFailure`, `Cancelled`, `PartialFailure`, `VerificationMismatch`, `Internal`) with user-safe messages. **Acceptance:** Frontend handles every error category; no `any` or freeform stringly `invoke` at feature call sites. **Evidence:** `NFR-004`, `SEC-008` unit/UI tests.
- [ ] **S1-T06 — Privacy and app permissions.** Apply Tauri CSP and minimal capabilities; static local assets; restrict frontend shell/FS access and include network-off test. **Acceptance:** renderer cannot spawn arbitrary command or read an arbitrary local file; normal UI makes no remote requests; test fixture metadata cannot inject HTML. **Evidence:** `SEC-001`, `SEC-003`, `SEC-008`.

**Gate `G1` — S1 accepted when:** All S1 tasks done, themes and dependency UX tested, native shell renders reliably, offline/security baseline holds, and all settings have automated migration/error coverage.

### Stage S2 — Robust ExifTool adapter and capability inventory

**Goal:** A reliable cross-platform-in-design Rust ExifTool execution engine on Linux, with real metadata discovery.

- [ ] **S2-T01 — Finalize executable resolver.** Separate `platform/` discovery and `adapter/` process invocation; validate output of `-ver`, per-executable identity and configurable override. Include Linux package-managed paths; leave macOS/Windows implementations behind typed platform interfaces until stages S7/S8. **Acceptance:** Installed, stale path, invalid executable, nonzero exit and timeout tested; selected path/version displayed; no process spawned through shell. **Evidence:** `FR-001`, `FR-002`, `SEC-002`.
- [ ] **S2-T02 — Implement argv builder and safe display formatter.** Build `Vec<OsString>`/equivalent, no string concatenation into a shell; separately format copies for POSIX and Windows user terminals with clear warning for shell-dependent quoting. **Acceptance:** Spaces, single/double quotes, Unicode, newline (where legal), leading-hyphen names, colon, `;`, `&`, `$`, backslashes do not produce unintended operations; displayed command is faithful to executed argv with platform-specific representation. **Evidence:** `FR-015`, `SEC-002`, `NFR-005`, `TST-007`.
- [ ] **S2-T03 — Build isolated executor.** Spawn child, enforce resource/time/output bounds, gather stdout and stderr independently, expose exit status and cancellation token, clean up on abrupt error. **Acceptance:** Slow/hung, oversized output, nonzero exit, missing dependency, user cancellation, and child termination tested without zombie processes; no unhandled UI rejection. **Evidence:** `SEC-007`, `FR-017`, `FR-018`.
- [ ] **S2-T04 — Capability enumeration.** Use installed ExifTool to obtain `-listf`, `-listr`, `-listwf`, `-listw`, group info and selective `-listx`; normalize/version-key cache and paginate large tag listings. **Acceptance:** File formats are never limited by a hardcoded photo extension list; cache invalidates when executable changes; known read-only/writable distinctions survive serialization. **Evidence:** `FR-007`, `UX-006`.
- [ ] **S2-T05 — Metadata JSON parser.** Read with `-j -G4 -s` or justified equivalent preserving identity; parse arrays, structures, errors, duplicate tags, source paths and unrepresentable/binary values without data loss; reject pathological payload sizes. **Acceptance:** Test fixtures include duplicate groups, empty metadata, non-image metadata, nested/list tags, malformed file, Unicode, binary value and no writable tags. **Evidence:** `FR-005`, `FR-023`, `SEC-003`.
- [ ] **S2-T06 — Adapter integration harness.** Create temp-directory runner and deterministic comparison against CLI output and post-write hashes; capture version so test results are reproducible. **Acceptance:** All real ExifTool tests use temporary copies and assert exit/status/metadata—not just process success; cleanup works after fail/cancel. **Evidence:** `TST-002`, `TST-007`.

**Gate `G2` — S2 accepted when:** CLI execution and metadata decoding work for mixed file formats with no untrusted shell execution; capability discovery tested against real installed ExifTool; error/lifecycle regression suite green.

### Stage S3 — File ingestion, inspection and scalable browsing

**Goal:** A fast, general-purpose metadata browser with zero write risk.

- [ ] **S3-T01 — File import.** Use native file picker and drag/drop; stable opaque file IDs; allow mixed extensions and repeated selections; skip duplicate paths with clear notice. **Acceptance:** JPEG + PDF + MP4 + ZIP + unknown file can be selected together; paths with Unicode/quotes/leading hyphens work; no arbitrary WebView filesystem permission. **Evidence:** `FR-003`, `SEC-008`, `NFR-005`.
- [ ] **S3-T02 — Directory scan and enumeration.** Scan selected folder asynchronously and incrementally, with counts, stop control, symlink loop detection, hidden/file filter options and user-selected recursion. **Acceptance:** 10k-entry fixture remains interactive; symlink cycle does not hang; outside-root symlink policy is visible (default do not follow); canceled scan produces honest partial status. **Evidence:** `FR-004`, `FR-021`, `NFR-001`.
- [ ] **S3-T03 — Metadata read jobs.** Batch reads, identify each `SourceFile` and warnings, incrementally publish events/results, and avoid holding entire corpus in a single JSON object. **Acceptance:** A read-only fixture and non-image fixture display meaningful groups; individual corrupt file does not hide healthy files; no unbounded buffers. **Evidence:** `FR-005`, `FR-017`, `NFR-002`.
- [ ] **S3-T04 — Inspector and search.** Group tree, tag name/source/value, full-text tag search, group/reader/writability filters, sort, copy to clipboard, empty and unsupported states. **Acceptance:** Users can find group-qualified values in a large set and distinguish duplicate names/read-only tags; no photo-centric labels. **Evidence:** `FR-006`, `UX-006`, `TST-003`.
- [ ] **S3-T05 — Virtualization.** Render only visible file rows/metadata entries and paginate/tag-list as needed; memoize filtering and guard excessive React re-renders. **Acceptance:** Test 10k rows, keyboard selection across virtualized boundaries, stable scroll and no lost focus. **Evidence:** `NFR-002`, `NFR-003`, `UX-008`.
- [ ] **S3-T06 — Performance baseline.** Implement repeatable scan/read/filter benchmarks and record reference Linux machine/ExifTool version/fixtures in CI artifacts (not duplicated prose). **Acceptance:** Measurements exist for 1k/10k entries, cold/warm read, UI lag and memory; regression threshold and reproducible bench command defined. **Evidence:** `NFR-006`, `TST-005`.
- [ ] **S3-T07 — Read journey E2E.** Test empty → add files/folder → inspect mixed formats → filter tags → discover unsupported read/write and errors. **Acceptance:** Runs on a built Linux Tauri app with real ExifTool where required; browser/renderer E2E may supplement but not replace native test. **Evidence:** `TST-004`, `FR-003`–`FR-007`.

**Gate `G3` — S3 accepted when:** Linux mixed-format reading/search is production-usable; large selection does not freeze UI; real metadata round trips and native desktop E2E pass; nothing in read flow mutates files.

### Stage S4 — Safe editing, staging, previews and verification

**Goal:** The core value proposition: generic ExifTool metadata editing with visible intent and dependable outcomes.

- [ ] **S4-T01 — Generic tag editor.** Implement staged `set-tag` with qualified group/tag, scalar/list representation and capability warnings; handle data types without lossy coercion. **Acceptance:** Modify writable generic tags on photo and non-photo fixtures; unsupported formats/tags show explanation and are not silently submitted; staged edits can be undone before execution. **Evidence:** `FR-008`, `UX-006`.
- [ ] **S4-T02 — Delete tag/group controls.** Implement staged deletion with visible group scope; treat `-all=`/all-metadata removal as high impact. **Acceptance:** Specific tag removed while unrelated tags remain; group removal warning explicitly describes scope; backup remains; deletion from read-only file produces skip/failure. **Evidence:** `FR-009`, `SEC-005`.
- [ ] **S4-T03 — Plan builder and impact preview.** Validate selected file IDs, tag availability, expected file identities, paths and backups; generate execution argv + user-equivalent command; show all intended files and skipped reasons. **Acceptance:** Readable diff/preflight, no surprising write targets; no mutation occurs from creating preview; stale file or out-of-scope path prevents unchecked write. **Evidence:** `FR-010`, `SEC-004`, `SEC-006`.
- [ ] **S4-T04 — Safe executor and backup policy.** Execute approved plan only; preserve ExifTool default `_original` files, handle collisions and write permissions; keep `-overwrite_original` opt-in and confirmed. **Acceptance:** Real write creates recoverable backup by default and target reflects intended data; overwrite option cannot be injected via normal UI without explicit policy; source file is unchanged on failed preflight. **Evidence:** `FR-011`, `FR-014`, `SEC-005`.
- [ ] **S4-T05 — Read-after-write verification.** Re-open target and compare expected values/removed tags with actual; record warnings, exits and no-change distinctly. **Acceptance:** Forced write rejection or verification mismatch does not report success; partial result and backup path shown; test asserts metadata semantic equality. **Evidence:** `FR-017`, `NFR-004`.
- [ ] **S4-T06 — Copy tags across files.** Support source file, destination list, exact tags/group selector and ExifTool `-TagsFromFile` semantics; avoid accidental source==dest or copy of unwritable groups. **Acceptance:** Proven copy on two formats, preserved input backup, unsupported tags skipped/report; copy does not imply every source tag is writable in target. **Evidence:** `FR-013`, `SEC-006`.
- [ ] **S4-T07 — Confirmation UX and help.** Implement plan review dialog, explicit action, backup policy explanation, failed/skip outcome and copied CLI representation. **Acceptance:** Full keyboard flow works; no direct write button skips plan approval; CLI equivalent is copyable and accurate for selected platform. **Evidence:** `FR-015`, `UX-007`, `SEC-004`.
- [ ] **S4-T08 — Write journey E2E.** End-to-end temp-fixture test read → edit → preview → confirm → modify → verify/backup → see log; include rejection, no-op, unsupported, Unicode, dangerous filename and cancel-before-start. **Acceptance:** Repeated Linux native run passes; original golden fixtures never mutated. **Evidence:** `TST-002`, `TST-004`, `TST-007`.

**Gate `G4` — S4 accepted when:** One-file and multi-target copy/edit/delete operations are backed up by default, preflighted and verified with real ExifTool; adverse inputs cannot silently modify unintended files; command preview is trustworthy.

### Stage S5 — Batch processing, logs, cancellation and Linux MVP release

**Goal:** Dependable large-scale operations plus installable, tested Linux release candidate.

- [ ] **S5-T01 — Bounded batch scheduler.** Build queue with per-file states (`queued`, `running`, `updated`, `unchanged`, `skipped`, `failed`, `cancelled`, `verification-failed`), configurable but bounded concurrency, progress and result aggregation. **Acceptance:** 100+ mixed writable/read-only files yield accurate counts; worker errors don't starve queue; UI remains interactive. **Evidence:** `FR-012`, `NFR-001`, `NFR-003`.
- [ ] **S5-T02 — Cancellation and retry.** Cancel queued work immediately, request process termination for running work safely, mark indeterminate modifications for verification, retry only explicitly chosen failures. **Acceptance:** Mid-batch cancellation doesn't claim atomic rollback, resumes UI, leaves backups intact; no orphan children; retry doesn't reprocess successfully updated files inadvertently. **Evidence:** `FR-018`, `SEC-007`.
- [ ] **S5-T03 — Job logs, diagnostics and privacy.** Event store with timestamp/severity/job/file linkage, stderr and exit status; text/JSON export, log-copy, search/filter; default session-only metadata-sensitive contents; opt-in bounded persisted logs with retention. **Acceptance:** Real stderr and per-file ExifTool warnings visible, export reproducible; sensitive paths/values not silently written to persistent storage; privacy warning before export. **Evidence:** `FR-016`, `SEC-009`, `UX-009`.
- [ ] **S5-T04 — Durable job indication.** On app restart detect possible interrupted operation if persisted journal enabled; differentiate "interrupted/unknown state" from complete, offer re-scan, not automatic unsafe resume. **Acceptance:** Simulated crash mid-batch does not fabricate success; unknown target state requires revalidation before retry. **Evidence:** `FR-025`, `NFR-007` (minimal MVP implementation allowed; P1 richer history later).
- [ ] **S5-T05 — Linux installers/artifacts.** Configure Linux `.deb` and AppImage (and `.rpm` where supported by Tauri/release tooling); don't bundle Perl or ExifTool; app dependency diagnostics point users to their package manager. Validate behavior for desktop launcher where PATH differs. **Acceptance:** Install/run/uninstall on clean representative Linux VM; detects missing system ExifTool and recovers after install; core app works offline. **Evidence:** `PKG-001`, `SEC-001`.
- [ ] **S5-T06 — Security/offline audit.** Inspect Tauri capabilities, CSP, filesystem scopes, process arguments, logs, path traversal/symlink handling and default backup behavior. **Acceptance:** Adversarial test suite passes; no remote dependencies; source isn't modified by unsupported/failed preflight. **Evidence:** `SEC-001`–`SEC-009`, `TST-007`.
- [ ] **S5-T07 — Linux release acceptance run.** Run integrated Linux native E2E from a packaged build, whole fixture corpus, theme/accessibility checklist, 1k-file workload, missing dependency, safe write/restore from backup and crash/cancel test. **Acceptance:** All `P0` requirements satisfied, no critical/high bugs open, build hashes captured, supported Linux distro/package results recorded in release CI artifact. **Evidence:** `G5`, `TST-004`, `NFR-006`.

**Gate `G5` — LINUX MVP ACCEPTED only when:** S0–S5 tasks and every P0 requirement are DONE with test evidence, Linux installation and offline operation confirmed, cross-format read/edit/batch functionality passes real integration tests, and no critical security/data-loss defect remains. **Do not claim that macOS/Windows are tested at this gate.** A Linux-only `0.x` release may be cut here and accurately labeled.

### Stage S6 — Complete general-purpose ExifTool breadth and advanced workflows

**Goal:** Avoid an artificial "photo metadata editor" ceiling; expose all ExifTool-supported file types and major operation classes through generic model plus advanced CLI-equivalent mode.

- [ ] **S6-T01 — Advanced argument parser and safety plan.** Implement tokenized ExifTool argument input (not shell), option parsing, effects classifier and target/outputs preview. Make a threat-model table for arguments modifying paths, control protocol, argfiles and configs. **Acceptance:** Correctly handles quotes/spaces as literal values and rejects shell syntax as command execution; high-risk writes cannot skip consent; adversarial corpus passes. **Evidence:** `FR-020`, `FR-028`, `SEC-010`, `SEC-011`.
- [ ] **S6-T02 — Source/output mapping.** Support advanced copy (`-TagsFromFile`, tag expressions), metadata export/import and user-chosen output paths with collision checks and proper backups. **Acceptance:** Fixture tests for per-file metadata transfer, sidecar generation/import, CSV/JSON export and safe destination detection; never confuse writing a new output with mutating an original. **Evidence:** `FR-022`, `SEC-006`.
- [ ] **S6-T03 — Time/rename/move/recursion operations.** Plan timestamp shifts, templated rename, directory moves, extension filters, recursive traversal; distinguish physical FileName/Directory mutations from ordinary metadata. **Acceptance:** Dry-run shows exact moves/output names, collision and outside-root checks enforced, symlink policy explicit, real fixture tests cover a successful and failing operation. **Evidence:** `FR-021`, `FR-022`, `SEC-010`.
- [ ] **S6-T04 — Binary and structured metadata.** Display binary fields as descriptors (not string garbage), export where ExifTool permits, support list/structured tags and embedded subdocument metadata without collapsing identity. **Acceptance:** Binary extraction compared byte-for-byte to CLI, large output uses streaming/temp file where possible, structured/list values round-trip on supported fixture. **Evidence:** `FR-023`, `NFR-002`.
- [ ] **S6-T05 — Feature discovery and limitations.** Add capabilities/diagnostics UI, exhaustive `-list*` browsing where practical, explanation of version-specific limitations and safe fallback to copyable command. **Acceptance:** All tested file categories appear based on ExifTool not static whitelist; unknown/read-only formats clearly identified; advanced limitations are explicit. **Evidence:** `FR-007`, `FR-024`, `FR-028`.
- [ ] **S6-T06 — Optimize worker lifecycle.** Evaluate `-stay_open` vs per-batch invocation, implement response framing and worker isolation if performance wins; guard child lifetime, desync, errors, cancellation. **Acceptance:** Benchmarks are recorded; 1k/10k job throughput and RSS bounded; either working persistent worker or documented measured decision not to enable it. **Evidence:** `FR-026`, `SEC-007`, `NFR-006`.
- [ ] **S6-T07 — Extended matrix coverage.** Add authoritative fixture matrix spanning file families (images/raw/video/audio/documents/archives/sidecars/other), tag groups and read/write limitations; run realistic advanced workflows. **Acceptance:** No fixed photo-only allowlist in product logic; demonstrate broad ExifTool operations and graceful read-only/unsupported outcomes; test every advertised advanced workflow. **Evidence:** `FR-020`–`FR-028`, `TST-005`.
- [ ] **S6-T08 — Full-feature Linux exit.** Run all advanced operations through packaged Linux application; validate warnings and recovery; review security before enabling advanced option defaults. **Acceptance:** No elevated-risk option reaches Rust executor without scoped planner/confirmation; CLI examples are copyable and reflect actual arguments. **Evidence:** `G6`, `SEC-010`, `SEC-011`.

**Gate `G6` — FULL-FEATURE LINUX ACCEPTED when:** P1 functionality and safety cases pass, broad supported-format coverage demonstrated, advanced operations are deliberate and tested, performance decisions justified, and all new operations carry user-visible limitations. This gate is a prerequisite for cross-platform release.

### Stage S7 — macOS packaging and validation (after Linux MVP)

**Goal:** System ExifTool integration and native Tauri distribution tested on Apple Silicon and Intel where supported.

- [ ] **S7-T01 — macOS resolver and install UX.** Implement Finder-GUI PATH handling, `/opt/homebrew/bin`, `/usr/local/bin`, manual override, validated `-ver` and missing dependency instructions. **Acceptance:** Fresh macOS account with no ExifTool shows guide; Homebrew/official pkg installation detected; changing override invalidates capability cache; no bundled Perl. **Evidence:** `PKG-002`, `FR-001`, `FR-002`.
- [ ] **S7-T02 — Platform filesystem semantics.** Test UTF-8/NFD path normalization, permissions, symlinks, external/removable volumes, resource forks/extended attributes implications and backup/overwrite semantics. **Acceptance:** File edits preserve user-selected policy, warn about attributes potentially affected by overwrite, and don't create unintended destinations. **Evidence:** `SEC-005`, `SEC-006`, `NFR-005`.
- [ ] **S7-T03 — Native builds and E2E.** Build Tauri native macOS `.app`/`.dmg` as appropriate; test React/IPC, bundled assets and the documented WebdriverIO embedded-driver approach on actual macOS/CI runner. **Acceptance:** Real app import/read/write/backup/log workflow passes; if automation framework fails on a runner, documented actual manual smoke remains open and gate cannot be auto-checked. **Evidence:** `FR-027`, `OPS-004`, `TST-006`.
- [ ] **S7-T04 — Signature/notarization policy.** Choose dev unsigned artifact policy vs signed/notarized production releases; validate Gatekeeper launch path, clean install and uninstall. **Acceptance:** Public stable release either signed/notarized according to policy or explicitly marked unsupported/unsigned prerelease; user can identify installation prerequisites. **Evidence:** `PKG-005`.

**Gate `G7` — macOS accepted when:** All S7 tasks and actual platform smoke/manual checks pass on intended supported hardware/architectures. Do not check solely because macOS CI compiles.

### Stage S8 — Windows official ExifTool distribution and validation

**Goal:** A reliable standalone desktop installer that uses the *official Windows ExifTool package*, not a separately built Perl runtime.

- [ ] **S8-T01 — Pin and verify upstream artifact.** Select official Windows ExifTool archive per target architecture; script retrieval during packaging with pinned version/checksum, store cache outside git, preserve licenses and contents. **Acceptance:** Hash mismatch fails build, provenance recorded, no third-party EXE in source control. **Evidence:** `PKG-003`, `SEC-012`.
- [ ] **S8-T02 — Bundle executable AND companion files.** Rename `exiftool(-k).exe` to `exiftool.exe` where needed, preserve required `exiftool_files` sibling folder, configure Tauri sidecar/resource paths and runtime resolution; test installed layout. **Acceptance:** Installed app runs `-ver`, reads and writes fixtures on Windows machine **with no separately installed Perl or ExifTool**; no missing-module/launcher errors. **Evidence:** `PKG-003`, `FR-001`.
- [ ] **S8-T03 — Windows filesystem and argv.** Test Win32 paths, drive letters, UNC/network paths, reserved characters, Unicode, leading hyphens, antivirus locking, permissions and backup behavior. **Acceptance:** No `cmd /c`, correct OS argument passing, graceful long path/ACL denial, collisions and partial failures; distinct log for lock errors. **Evidence:** `SEC-002`, `SEC-006`, `NFR-005`.
- [ ] **S8-T04 — Installer and desktop E2E.** Package NSIS/MSI based on supported Tauri tooling; test Win10/Win11 (supported set finalized at release), installed app lifecycle and real native E2E. **Acceptance:** No Perl installer required, normal-mode app works offline, uninstall removes application not user files/backups, native read/edit/log tests pass. **Evidence:** `FR-027`, `TST-006`.
- [ ] **S8-T05 — Redistribution notice and trust review.** Verify official upstream archive licensing/Perl runtime launcher notices and supply `THIRD_PARTY_NOTICES`, checksums, provenance and optional code-signing plan. **Acceptance:** Compliance checklist reviewed and no falsely claimed MIT license for ExifTool distribution; release page differentiates bundled third-party bits. **Evidence:** `PKG-004`, `SEC-012`.

**Gate `G8` — Windows accepted when:** A clean Windows machine with no separately installed Perl successfully installs ExifBee, runs bundled official ExifTool, edits/backs up real fixtures, and passes security, licensing and installer checks.

### Stage S9 — Cross-platform release, maintainability and post-MVP hardening

**Goal:** A trustworthy independently distributed cross-platform desktop utility, with no untracked spec/test drift.

- [ ] **S9-T01 — Full OS CI/release matrix.** Build and test intended Linux packaging, macOS architectures, Windows architectures; check runtime loading and installer contents, not just compile. **Acceptance:** Required CI status checks and hashes reproducible for all target OS artifacts; platform manual acceptance records linked to release. **Evidence:** `OPS-004`, `TST-006`, `SEC-012`.
- [ ] **S9-T02 — Dependency update/security automation.** Add dependency audits, pinned official ExifTool version review, advisory tracking and remediation policy without uncontrolled updates. **Acceptance:** A known bad dependency or checksum test intentionally causes failure; updating ExifTool re-runs compatibility matrix. **Evidence:** `OPS-005`, `SEC-012`.
- [ ] **S9-T03 — End-user guidance and recovery.** `README.md` stays minimal: purpose, supported platforms, dependency model, download/install, common tasks, safety/backups, support links and link to this SPEC. Advanced help is implemented in UI or linked to upstream docs. **Acceptance:** New user can install, inspect a PDF, edit a supported field, and locate/recover a backup without developer assistance. **Evidence:** `UX-010`, manual usability.
- [ ] **S9-T04 — Release and license review.** Confirm MIT app source, third-party notices, build provenance, signing/notarization status, privacy/default logging and missing-ExifTool instructions on each OS. **Acceptance:** Platform release checklist complete; known limitations documented with reproducible issue links; no high-risk open data-loss defects. **Evidence:** `PKG-004`, `PKG-005`, `SEC-012`.
- [ ] **S9-T05 — Spec drift audit.** Run parser mapping requirement IDs to real tests, compare all checked tasks with CI evidence; spot-check UI and release binary against documented behavior; deprecate abandoned tasks explicitly. **Acceptance:** No checked tasks lacking evidence, no tests referencing missing IDs, and no untested release-critical workflows. **Evidence:** `OPS-002`, `TST-008`.
- [ ] **S9-T06 — First stable cross-platform release.** Tag version, publish installer checksums and provenance; verify links and clean install/uninstall; publish issues/feedback channel. **Acceptance:** G0–G9 complete, no misleading claim that every ExifTool-readable format is writable, users can reliably execute and observe operations. **Evidence:** `G9`.

**Gate `G9` — V1 CROSS-PLATFORM RELEASE ACCEPTED when:** `G0`–`G8` have been genuinely satisfied, all P0–P2 normative requirements applicable to stable release pass, OS binaries and installed behavior validated, security/licensing/privacy reviewed, and requirements/tests/task status agree.

---

## 8. Detailed command and metadata semantics

The Rust planner/executor is **the single point** that translates a selected set of files and a structured job into ExifTool invocations. UI-generated commands and exported commands must derive from the same argument model, not a second string-builder.

### 8.1 Representative CLI reference (behavioral examples, not literal implementation)

```bash
# Read (group family 4 helps differentiate otherwise duplicated names)
exiftool -j -G4 -s -- some-file.pdf

# List capabilities from installed ExifTool
exiftool -ver
exiftool -listf
exiftool -listwf
exiftool -listw
exiftool -listx

# Write a qualified tag; ExifTool defaults to writing an _original backup
exiftool -XMP-dc:Rights="Example rights" -- sample.jpg

# Remove selected metadata; high-impact operation
exiftool -XMP:All= -- sample.jpg

# Copy writable tags across different files
exiftool -TagsFromFile source.jpg -all:all -- destination.jpg

# Preserve filesystem modification time (not a substitute for backup)
exiftool -P -XMP-dc:Rights="Example rights" -- sample.jpg

# Query supported extension families, not just images
exiftool -listf
```

These demonstrate option semantics. Filesystem path treatment and `--` placement must be verified per operation; arguments containing ExifTool's own `<`, `>`, `$`, `@` expression syntax must remain **one literal argv element** when intended as ExifTool input and must never be shell-interpreted. In CLI **display only**, correct escaping depends on the user's shell; offer POSIX shell and PowerShell display modes where necessary, and label the target terminal.

### 8.2 Tags, duplicate identities and editability

- ExifTool supports multiple tag namespaces/group families, and identical short names may occur in more than one group. Group-qualified IDs are required for stable editing.
- `-G4` + JSON avoids many duplicate-name collisions. Test whether still-ambiguous repeated instances can be represented and make such instances read-only in simple editing if there is no unambiguous write target.
- **Readability != writability.** A file extension may be supported for reading only; a writable format may contain read-only or computed tags; binary or MakerNote fields can have extra constraints.
- Do not synthesize metadata values from media decoders; display ExifTool's actual extracted values. Make a clear distinction between interpreted/display value and literal/raw value where ExifTool supports both.
- Tags can be list, language-alternative, structure, numeric, binary, computed, or absent. Avoid universally flattening values to strings.
- For metadata deletion, distinguish tag deletion, a metadata family/group removal, and full metadata removal. The UI must expose scope and possible implications (for example, certain metadata groups may include information relevant to file rendering or provenance).
- Metadata copy applies **only to writable destinations**; the UI should never imply a one-to-one clone of all metadata in any source format.
- Unsupported/corrupt file reads must preserve the per-file error and avoid a misleading blank success state.

### 8.3 Formats and dynamic support

**Never implement an application whitelist like** `['jpg', 'jpeg', 'png', 'tiff']`. Use installed ExifTool's own `-listf`/`-listr`/`-listwf` and actual per-file behavior. Extension support is a useful hint, not an authorization or final guarantee. A format's actual support depends on its container, internal variant and ExifTool version.

Coverage categories must include at minimum: JPEG/PNG/TIFF/RAW images, audio, video, PDFs and office/document-like containers, fonts, archives, sidecars/structured metadata, executables and other recognized formats. The test fixture matrix is representative, not an exhaustive claim of compatibility with every file format. The advanced interface exposes ExifTool options to cover formats that lack custom UI affordances.

### 8.4 Exports, outputs, and original preservation

Exporting extracted binary data, thumbnails, metadata tables, CSV/JSON or XMP sidecars may create entirely new files. For each operation:

- Require explicit output location; preview each filename or deterministic template and conflicts.
- Identify whether the operation **reads source only**, **creates a new output**, **modifies source**, or **moves/renames source**.
- Default to non-destructive filename collision handling; no implicit overwrite of existing output.
- Avoid loading whole binary outputs into React memory; stream or move temp outputs using Rust.
- When a write operates on an input file, preserve ExifTool backup default unless explicitly changed with an approved policy. Allow a safe output-copy mode where applicable; do not assume copying preserves every filesystem attribute.
- Surface the existence, path and name of backups after execution and preserve them across cancel/retry.

### 8.5 Advanced features and high-risk exceptions

Some ExifTool options can invoke behavior not representable in a simple field editor. To meet the "full breadth" commitment without giving the UI unchecked code execution:

1. Offer advanced user-defined ExifTool arguments as a **tokenized argv list** with a preview. Do not parse raw terminal syntax with a shell.
2. Derive target scope from selected file IDs, not arbitrary pasted paths unless explicitly approved in a trusted advanced mode.
3. Detect `-r`, `-o`, `-w`, `-W`, `-@`, `-config`, `-stay_open`, `-execute`, filename/directory changes, metadata removal, external import files, output templates and overwrite arguments. This is not an exhaustive risk list; tests must cover aliases and ExifTool's evolving option set.
4. Config files (`-config`) can contain executable Perl. They are **not ordinary metadata inputs**. Default deny; a later implementation may support explicit trusted local configs only after separate review, a high-risk confirmation, filesystem disclosure, and threat-model coverage. If not implemented, present a clear limitation and offer command copy for terminal execution.
5. Avoid allowing user arguments to hijack the application's persistent `-stay_open` control channel. Advanced mode should use a separate child process/controlled argument file where necessary.
6. For arbitrary advanced options whose side effects cannot be established, require user confirmation acknowledging the exact command and target scope; refuse operations that would bypass the executor's scope and safety model.
7. **Do not claim full arbitrary ExifTool scripting parity inside the UI.** The goal is to expose the breadth of ExifTool's metadata operations and affordances while retaining safe execution boundaries. Exact unbounded CLI usage remains available through the user’s terminal.

---

## 9. API boundaries and state machines

### 9.1 App states

```text
INITIALIZING
    │
    ├── ExifTool missing/invalid ──> DEPENDENCY_ERROR ── retry/settings ──┐
    └── ExifTool validated ────────> READY                           <─────┘
                                           │
                                           ├── IMPORTING -> READY/IMPORT_FAILED
                                           ├── READING   -> READY/READ_PARTIAL
                                           └── EDITING
                                               -> STAGED
                                               -> PREFLIGHT
                                               -> APPROVAL_REQUIRED
                                               -> EXECUTING
                                               -> VERIFYING
                                               -> COMPLETE/PARTIAL/FAILED/CANCELLED
```

App UI state (selection, editor/drawer) is separate from durable job state. A job should have exactly one final status and independently recorded per-file outcomes. A cancellation request is **not** proof a running write was undone. If process exits before verification, mark the file `unknown`/`verification-required` where appropriate.

### 9.2 File selection scope

- `FileId` is opaque and bound to an app-session registry of selected paths and identity. Do not accept a client-supplied arbitrary absolute path as authority for a write.
- Native dialog result is a selection proposal; Rust confirms canonical/real paths, symlink policy and scope. Once a user explicitly authorizes a folder, recursion remains within the intended selection/symlink rules.
- Re-evaluate identity and scope immediately before mutation; detect moved/replaced files between preview and execution.
- For network/removable mounts, report disconnected or changed targets rather than attempting retries against a different path silently.
- Copy/output operations need separately validated source/destination capabilities; preserving source identity alone is insufficient.

### 9.3 Error classification and IPC result

All Rust commands return a typed `Result<T, AppError>`. Error records include stable machine code, safe user message, optional ExifTool exit code, stderr excerpt (bounded), related file/job IDs, retryability flag, and suggested action. Avoid storing full metadata in error payloads. UI messages must not leak internal backtraces by default; developer diagnostic mode may expose sanitized details.

### 9.4 Restart/crash semantics

- In-memory jobs are not automatically resumed after a crash. Preserve enough **minimal job marker/status** (when optional persistent journaling enabled) to prompt the user to recheck possibly modified files; do not persist sensitive metadata values as the default.
- If a write was interrupted, read/verify the file and backup before offering retry. The original path might no longer be the expected object after rename/move.
- Never promise exactly-once semantics across a crash. Provide idempotence where a specific operation genuinely permits it, and flag non-idempotent options (append-to-list, time shift, move/rename) explicitly.

---

## 10. Performance and resource-engineering notes

### 10.1 Complexity budget

Let `F` = selected files, `T` = total metadata tags returned, `B` = number of files per backend batch, `W` = bounded workers, `V` = visible table rows. Expected scan cost is O(F), metadata data-processing cost O(T), and display cost per render should approach O(V), not O(F×T). Filtering may be O(T) per query unless indexed; debounce and memoize before considering indexes. Sorting F rows is typically O(F log F) and should be off the most-sensitive UI path for very large selections.

- Avoid creating thousands of separate ExifTool processes; batch compatible jobs or use measured persistent `-stay_open` mode.
- Avoid aggregating all files into a single massive JSON document or one CSV export just to show previews. Stream/batch results and paginate in the UI.
- For metadata caching, cache only what's necessary per selected file and evict stale/unselected results; do not build a general-purpose searchable filesystem index in v1.
- Virtualize large tables and directory views, keeping selected rows addressable when offscreen.
- Keep binary value previews out of React state; only hold descriptor/size and use explicit export action.
- Restrict stdout/stderr memory retention with a configurable ring buffer (for example cap by bytes/event count). Persistent log export should be streamed, not string-concatenated into an enormous buffer.
- Jobs may be I/O-bound, and parallel writes to the same directory/disk can reduce performance or introduce contention; cap concurrency conservatively and prevent concurrent writes to the **same file**.
- ExifTool's JSON/CSV output and some data extraction flags have different memory characteristics; benchmark actual operations rather than assuming all output is streaming.
- Prefer measuring bottlenecks to introducing a complex worker pool, SQLite index, custom Rust metadata parser, or media preview engine prematurely.

### 10.2 Proposed initial operational limits

Choose these as **configurable engineering defaults**, not permanent product limits: metadata read batches of 50–200 files, 1–2 concurrent write workers, visible log event ring of up to 10,000 bounded-size messages, and no more than one write job touching the same file at a time. Calibrate using S3/S6 benchmarks and document any changes through test evidence.

Avoid silent truncation of metadata, logs, or selected files. If a soft limit is reached, show that results were paginated/truncated, provide an export or narrower query path, and ensure no safety-critical warnings are dropped from the final summary.

### 10.3 Performance and correctness tradeoffs

| Choice | Advantage | Cost / mitigation |
|---|---|---|
| System ExifTool Linux/macOS | Small installer, upstream maintained, no Perl packaging | ExifTool may be missing or old; clear health UI, version floor/capabilities |
| Official Windows ExifTool bundle | No separate user install | Bigger installer, third-party notices, companion files and security updates |
| Persistent `-stay_open` | Low process startup overhead | Stateful output protocol, desync/cancel complexity; benchmark first |
| Batch execution | Reduced process overhead | Large output/partial error bookkeeping; bounded chunks |
| JSON structured read | Easier rich metadata parsing | Potential large output, tag collisions; group-qualified/bounded reads |
| Safe default backups | Data recovery opportunity | Extra disk usage, collision/cleanup UX; explicit user choice |
| Rust-mediated filesystem | Centralized safety, consistency | Typed IPC overhead; minimize unnecessary round trips |
| One SDD | Low doc maintenance | Large file; index via headings, stable IDs and automated lint |

---

## 11. Security threat model and negative-case contract

### 11.1 Threats

| Threat | Attack/failure example | Mitigation + tests |
|---|---|---|
| Shell injection | File called `a; rm -rf ...` | Separate argv, no shell, hostile filename integration (`SEC-002`) |
| Option injection | Selected filename begins `-` | Positional separator/canonical paths, argument boundary tests (`SEC-003`) |
| Arbitrary Perl | User supplies `-config` pointing to code | Default deny/trusted high-risk feature gate (`SEC-011`) |
| Argfile protocol abuse | `-@` with special control lines | Parse as untrusted, don't merge with internal `-stay_open` (`SEC-010`) |
| WebView content injection | EXIF Comment contains HTML/script | React escaped text, CSP, no untrusted HTML (`SEC-003`) |
| Path escape | Symlink to sensitive file outside folder | Explicit scope, preflight and execution recheck (`SEC-006`) |
| Time-of-check/time-of-use | File replaced after preview | Re-stat, identity recheck and honest residual risk (`SEC-006`) |
| Destructive default | `-all=`/`-overwrite_original` without confirmation | Separate high-risk plan and backups (`SEC-004`, `SEC-005`) |
| Accidental data leakage | App logs GPS/author metadata automatically | No telemetry; minimal/opt-in logs; explicit export warnings (`SEC-001`, `SEC-009`) |
| Hung child | ExifTool stalls on malformed file | Timeout/cancel/cleanup and bounded output (`SEC-007`) |
| Package supply chain | Replaced unofficial Windows EXE | Pin official provenance/checksum, verify license (`SEC-012`) |
| False success | Exit 0 but tag cannot be changed | Read-after-write postcondition and per-file statuses (`FR-017`) |

### 11.2 Non-negotiable file-data invariants

1. Merely opening or inspecting a file must not change it (test stat/hash before/after read).
2. A write cannot begin from an unapproved job plan.
3. Default writes preserve the original per ExifTool's backup behavior unless the user explicitly selects a different policy.
4. A failed preflight cannot mutate selected files.
5. An operation may report `updated` only when expected change is verified, or explicitly labeled "completed without independent verification" in a narrowly justified exceptional command class; no optimistic success.
6. A canceled multi-file job is never labeled fully rolled back.
7. Operation logs must identify all processed/skipped/failed files and must not turn stderr warnings into silent success.
8. A file path returned by the UI is not sufficient authority for execution; the backend checks scope and identity.
9. No silent remote network calls, external Perl code evaluation, or arbitrary shell invocation.
10. Overwrite, rename, move and delete have explicit preview, conflict policy and user acknowledgement.

### 11.3 Security review gate

Before enabling advanced mode and before cross-platform release, manually inspect the final command builder, all OS-specific quoting, Tauri permissions, process output parsing, config/argfile handling and installer source provenance. Unit tests are essential but not sufficient for these boundaries.

---

## 12. Automated tests: executable contract examples

Test names below are **examples** of acceptance evidence, not a new hand-maintained test plan. Put requirement annotations in the actual test source and let tooling collect them.

```text
Rust unit:
  read_plan_does_not_set_write_options                      @req SEC-004
  unsafe_argv_is_not_interpreted_by_shell                   @req SEC-002
  leading_hyphen_filename_stays_positional                 @req SEC-003 NFR-005
  backup_policy_defaults_to_exiftool_original              @req FR-014 SEC-005
  advanced_config_without_explicit_trust_is_rejected       @req SEC-011
  symlink_outside_scope_is_rejected                         @req SEC-006
  output_parser_preserves_duplicate_group_identity         @req FR-005
  cancellation_final_state_is_not_success                  @req FR-018

Real ExifTool integration:
  jpg_set_and_read_back_rights_with_original_backup        @req FR-008 FR-011 FR-014
  pdf_writable_metadata_roundtrip                          @req FR-005 FR-008
  readonly_archive_reports_not_writable                    @req FR-017 UX-006
  unsupported_tag_does_not_report_updated                  @req FR-017
  copy_metadata_between_compatible_files                  @req FR-013
  group_deletion_only_removes_intended_group               @req FR-009
  batch_partial_failure_keeps_per_file_outcomes            @req FR-012 FR-017
  unicode_and_metacharacters_do_not_inject_options         @req SEC-002 NFR-005
  cancel_mid_write_requires_reverification                @req FR-018

Native desktop E2E:
  initial_dependency_missing_guidance                      @req UX-010 FR-001
  switch_system_dark_light_and_persist                     @req UX-002
  open_mixed_files_and_search_tag                           @req FR-003 FR-006
  stage_preview_confirm_and_verify                          @req FR-010 FR-011
  partial_batch_failure_and_export_log                     @req FR-012 FR-016
  advanced_args_show_risk_confirmation                     @req FR-020 SEC-010
```

**Test reliability:** Fixture assertions must be conditional on real documented upstream file-format capabilities, not written to pass regardless of ExifTool outcome. A test skipped because installed ExifTool is incompatible must fail the configured release gate or be explicitly approved as a version-specific exception, not silently counted as covered.

### 12.1 Minimal test helper contracts

- `TempFixtures`: copies immutable fixture(s) to fresh temp workspace, records identity/checksum/known metadata and restores permissions on cleanup.
- `ExifToolHarness`: resolves the same executable as application under test, supports timeouts/cancellation, reports actual version, and captures stderr and per-file warning fields.
- `EngineAssertions`: `expectTagValue`, `expectTagAbsent`, `expectBackupExists`, `expectOriginalUnchanged`, `expectNoUnexpectedOutputs`, `expectPerFileOutcomes`.
- `TestEvidence`: writes CI JSON output containing test suite, requirement IDs, runner platform, fixture version, ExifTool version, status, timestamp and commit SHA. Evidence is **generated**, not manually maintained.

---

## 13. CI and release commands (target developer experience)

The selected package manager may differ, but command intent must be provided by repository scripts:

```bash
npm ci
npm run dev
npm run build
npm run lint
npm run typecheck
npm run format:check
npm run test:unit
npm run test:integration     # calls REAL system exiftool in temporary sandbox
npm run test:e2e:renderer   # fast mocked-IPC UI behavior
npm run test:e2e:desktop    # real Linux Tauri build + real ExifTool
npm run test:traceability   # SDD + test @req annotations
npm run test:security
npm run bench:metadata      # performance baseline/report (not always PR gating)
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Implement script names as agreed in S0 and keep them stable; do not leave inert scripts that merely echo success. Test commands must return non-zero on failures. If `npm` is not chosen, replace examples consistently with the selected JS package manager.

**Required branch-protection principle:** CI must prove test execution; only passing local commands are insufficient. Any high-risk job touching real filesystem targets must have at least one integration fixture and one negative case.

### 13.1 Platform runner matrix

| Phase | Runner | Test | Why it matters |
|---|---|---|---|
| S0–S5 | Linux latest supported CI + pinned ExifTool installation | build, real integration, desktop E2E, traceability | first MVP |
| S6 | Linux + periodic longer perf runner | advanced/safety and large corpus | full CLI breadth |
| S7 | macOS arm64/x64 runner or available hardware | build/install/executable detection/native E2E | Finder PATH, filesystem, WKWebView |
| S8 | Windows x64 (additional arch if published) | official package validation, install/native E2E | runtime/companion folder, path/AV issues |
| S9 | all release platforms | smoke + security + package provenance | genuine cross-platform confidence |

**Manual check exception policy:** If a specific platform cannot be exercised by the author yet, the platform task remains open and the release is described accurately as untested/preview. A successful Linux build cannot substitute for running the Windows/macOS binary.

---

## 14. Release acceptance checklists

### 14.1 Linux MVP (`G5`) manual acceptance

- [ ] A clean Linux environment can install and launch ExifBee without shipping ExifTool or Perl in its installer.
- [ ] Without ExifTool installed, ExifBee shows accurate missing dependency guidance, stays usable for settings, and does not crash.
- [ ] After installing ExifTool, Retry resolves/version-checks it without restarting the OS.
- [ ] Import a directory containing JPEG, PDF, MP4, a read-only archive, a malformed file and Unicode filenames.
- [ ] Every import is represented; readable files show authentic metadata; malformed/read-only cases show truthful diagnostics.
- [ ] Light/dark/system mode works and survives app restart; normal usage doesn't require network.
- [ ] Edit a writable field on an image **and** on at least one non-image format; preview command and file set accurately.
- [ ] Approving write results in changed verified metadata and an intact backup by default.
- [ ] Remove a tag, then test a group removal and confirm warnings and correct scope.
- [ ] Batch edit mixed files and confirm skipped/error/success counts and preserved originals.
- [ ] Copy compatible metadata between files and inspect individual results.
- [ ] Cancel part-way through batch, inspect unknown statuses, and safely retry only selected failures.
- [ ] View/copy/save execution log; no metadata values persisted without consent.
- [ ] Perform the full workflow by keyboard, test enlarged text and both themes.
- [ ] Run packaged desktop native E2E, integration corpus, security negatives and representative performance benchmark.
- [ ] Confirm README, About and license attribution state independently maintained ExifTool dependency accurately.

### 14.2 Full-feature Linux (`G6`) manual acceptance

- [ ] Advanced argument interface does not execute shell code or bypass selected scope.
- [ ] Test bulk metadata removal, recursive traversal, rename/move, time shift, copy, import/export and sidecar operations.
- [ ] High-risk operations show accurate target counts, intended paths/backups, output collisions and explicit confirmation.
- [ ] A `-config` / `-@` / `-stay_open` control attempt cannot silently execute trusted-by-default code or hijack process protocol.
- [ ] A binary metadata export is byte-accurate; structured/list values remain correctly represented.
- [ ] Unsupported file types and format-specific limits are surfaced, not hidden by photo-specific UI assumptions.
- [ ] Benchmark evidence supports selected batching/process optimization.

### 14.3 macOS (`G7`) manual acceptance

- [ ] Launch from Finder without terminal PATH and detect/reconfigure system ExifTool.
- [ ] Test both supported architecture targets where releases are published.
- [ ] Perform read/write/backup/copy on local file and removable volume.
- [ ] Verify signatures/notarization or clearly label prerelease distribution limitations.
- [ ] Test system theme, keyboard, accessibility and installed-app E2E.

### 14.4 Windows (`G8`) manual acceptance

- [ ] Install on machine with **no separately installed Perl or ExifTool**.
- [ ] Confirm bundled official `exiftool.exe` and sibling `exiftool_files` work after install.
- [ ] Run full mixed-format read/write/backup/log flow; test Unicode/long/UNC and permission-denied paths where available.
- [ ] Confirm packaging retains upstream attribution/licensing, version and checksums.
- [ ] Test cancel/interruption and Windows security software/installer warnings.
- [ ] Test native E2E against installed binary; user data/backups remain after uninstall.

---

## 15. Release-blocking defects and triage rubric

| Severity | Examples | Release rule |
|---|---|---|
| Critical | Unapproved file overwrite/deletion; shell injection; remote metadata leak; corrupted source with no safe warning/backup | Block immediately; add regression test |
| High | Batch silently skips errors; incorrect target mapping; mismatched verification falsely reported success; installed Windows ExifTool fails | Block relevant platform gate |
| Medium | Unsupported tag mislabeled writable (with correct safe error), annoying UI slowdown, non-critical accessibility problem | Triage explicitly, fix before stable if commonly encountered |
| Low | Cosmetic alignment, unused keyboard shortcut, minor non-blocking visual polish | Can defer with issue and honest known-limitation entry |

A regression in backup safety, selected path scope, process-execution safety or post-write verification is always release-blocking, even if it affects an uncommon file format.

---

## 16. Risks, unresolved assumptions and mitigation

| Risk ID | Risk / assumption | Mitigation | Closure stage |
|---|---|---|---|
| RISK-01 | ExifTool capabilities differ by version and tag | Versioned dynamic registry and real format fixtures | S2–S6 |
| RISK-02 | Native WebView behavior differs across OS | Early abstraction, OS E2E and actual installed-app runs | S7/S8 |
| RISK-03 | Windows EXE resource folder missing when Tauri installs sidecar | Bundle `exiftool.exe` + `exiftool_files` and launch installed app in CI | S8 |
| RISK-04 | Perl runtime licensing in official Windows distribution | Audit exact artifact and required third-party notices before release | S8/S9 |
| RISK-05 | Advanced options can have effects beyond simple selected files | Argument risk classifier, output/target mapping, explicit high-risk gate, refuse unsafe uncontrolled execution | S6 |
| RISK-06 | ExifTool output has duplicates, binary values and embedded structures | Group-family identity and tested typed parser | S2/S6 |
| RISK-07 | Backup naming and filesystem attributes differ by platform | Per-OS tests, conservative defaults, show recovery paths | S4–S8 |
| RISK-08 | Resource exhaustion from huge directories/files/logs | Bounded queues, chunked reads, virtualization, output limits | S3/S5/S6 |
| RISK-09 | Spec statuses drift from actual tests | Requirement annotations, CI traceability checker, per-stage evidence | S0 onwards |
| RISK-10 | CLI expressiveness exceeds safe GUI planner | Advanced mode with explicitly documented exceptions; export command for terminal | S6 |
| RISK-11 | `-stay_open` worker desynchronizes or crashes | Serialized dispatcher, protocol test corpus, restart on desync; fallback batch invocation | S6 |
| RISK-12 | Data loss if user assumes batch-wide transactional rollback | Per-file states, backup retention, explicit nontransactional copy | S4/S5 |

**Open implementation decisions (resolve by task, not user interrogation unless unavoidable):**

- Choose exact minimum supported ExifTool version and OS versions from measured compatibility data (`S0-T03`, `S7-T03`, `S8-T04`).
- Choose primary JS package manager and minimal state-store mechanism in S0/S1; no brand preference overrides tests.
- Choose whether to use Tauri sidecar API or direct resource-path spawning for Windows based on the need to keep `exiftool_files` beside the official executable; the observable package/runtime requirement is fixed.
- Determine whether `-stay_open` wins materially for representative workloads (`S6-T06`).
- Choose exact supported high-risk advanced arguments after effect-classification tests; no promise to run arbitrary untrusted Perl configuration scripts.
- Confirm copyright notices and license obligations for the exact official ExifTool Windows artifact, including its embedded runtime, before public redistribution.

---

## 17. Agent handoff and exact first implementation sequence

When starting a fresh coding-agent session, provide this file and the following instruction (the excerpt below is part of the SDD, not another spec):

> Implement ExifBee from `SPEC.md` using the earliest unchecked task whose dependencies are satisfied. Do not implement a later stage, add product scope, or invent missing requirements. Before editing, identify task ID and acceptance tests, inspect the repository, and create a small plan. Make focused code changes and executable tests, run checks, and report evidence. Update task state only after test evidence and review. Keep SDD as the sole product/architecture specification; do not create extra planning Markdown files. Prefer working real ExifTool integration tests over mocks for file mutations. Never sacrifice backup safety or execute arbitrary shell commands. The project is Linux-first desktop, Tauri v2/Rust/React/TypeScript, with system ExifTool on Linux/macOS and official Windows distribution later. Maintain light/dark/system themes and support all file families ExifTool can actually handle. If a planned step conflicts with safety/technical reality, record a concrete proposed change in the SDD and explain it before implementing a silent workaround.

### 17.1 First ten agent actions, in order

1. Establish repo and toolchains (`S0-T01`).
2. Install this spec/ID validator, malformed-ID negative tests and CI integration (`S0-T02`).
3. Implement actual Linux system ExifTool resolver and `-ver` sanity test (`S0-T03`).
4. Create legal synthetic mixed-format fixture corpus and license baseline (`S0-T04`).
5. Add Linux CI jobs that execute real ExifTool tests (`S0-T05`).
6. Prove typed Rust IPC reading an image and **non-image** fixture (`S0-T06`).
7. Complete and record `G0` evidence.
8. Build light/dark/system themed app shell, not a photo-editing mockup (`S1-T01`/`S1-T02`).
9. Implement keyboard/accessibility/dependency state and typed error boundary (`S1-T03`–`S1-T06`).
10. Continue sequentially to `G1`, then `S2` rather than building an untested advanced GUI prematurely.

### 17.2 Required agent completion report

At the end of **each** completed task, report in the PR/agent response:

```text
Task ID:
What changed (source locations):
Acceptance criteria met (each, with evidence):
Automated tests added/modified (@req IDs):
Commands executed and actual pass/fail:
Real ExifTool version/OS used (when relevant):
Security/backups/side effects reviewed:
Known limits/blockers:
SPEC.md checkbox/requirement change:
Next eligible task:
```

Do not replace test evidence with a general statement such as "everything works". A task with an unresolved blocker must not be checked off.

### 17.3 Stage-completion rules

An AI agent may mark a stage complete only after **all** stage task criteria, test evidence and relevant manual/CI acceptance are satisfied. An agent working on Linux may not mark S7 or S8 complete by inference from code structure. A release package is not validated unless it has been run as an **installed application** in the target environment.

---

## 18. Decision log (in-document ADR substitute)

| Decision ID | Date | Decision | Rationale / alternatives rejected | Status |
|---|---|---|---|---|
| DEC-001 | 2026-10-28 | Desktop-only Linux/macOS/Windows | Keep product focused; avoid mobile/PWA and filesystem feature gaps | Active |
| DEC-002 | 2026-10-28 | Tauri v2 + Rust + React + TypeScript | Native system WebView with robust Rust process and filesystem layer | Active |
| DEC-003 | 2026-10-28 | Linux-first MVP, cross-platform stages later | Primary niche and actual early test environment | Active |
| DEC-004 | 2026-10-28 | System-installed ExifTool Linux/macOS | No independent Perl distribution; upstream package-manager maintenance | Active |
| DEC-005 | 2026-10-28 | Official Windows ExifTool executable + companion files | No separately assembled Perl runtime, works without prerequisite install | Active |
| DEC-006 | 2026-10-28 | No fixed file-format/photo restriction | ExifTool is a general-purpose metadata tool; discover capabilities dynamically | Active |
| DEC-007 | 2026-10-28 | Conservative staged writes, ExifTool backups by default | File safety and transparency more important than minimal clicks | Active |
| DEC-008 | 2026-10-28 | One canonical versioned SDD plus executable test evidence | Minimize Markdown rot, enforce traceability in CI | Active |
| DEC-009 | 2026-10-28 | Light/dark/system with semantic theme tokens | Desktop accessibility and usability | Active |
| DEC-010 | 2026-10-28 | Advanced ExifTool arguments, **not** general shell | Preserve broad capability without arbitrary command execution | Active |
| DEC-011 | 2026-10-28 | MIT ExifBee source with separate third-party notices | Keep project permissive without relicensing ExifTool | Active |
| DEC-012 | 2026-10-28 | Canonical SDD lives at `docs/SPEC.md` (S0-T02 and §4.2 originally named root `SPEC.md`) | Maintainer committed it under `docs/`; one canonical file is what matters, not its folder | Active |
| DEC-013 | 2026-10-28 | Linux CI quality job runs in an `archlinux:base` container whose pacman mirror is pinned to one Arch Linux Archive date (`ARCH_SNAPSHOT` in `.github/workflows/ci.yml`); Rust toolchain pinned the same way (`RUST_TOOLCHAIN`) | Ubuntu runner packages are older than the tested ExifTool minimum (Ubuntu 24.04 ships 12.76), and S0-T05 requires ExifTool from a package manager; a dated snapshot makes every system package, including ExifTool and WebKitGTK, a fixed version, so CI has no mutable dependencies. Raise the snapshot date deliberately in a reviewed change | Superseded by DEC-014 |
| DEC-014 | 2026-10-28 | Linux CI runs on the pinned `ubuntu-24.04` runner with apt system packages (Tauri v2 prerequisites), a pinned Rust toolchain and a Cargo cache; real-ExifTool integration tests run as a matrix of the Ubuntu 24.04 apt package (12.76) and the official release (13.55, fetched from SourceForge and checked against CPAN's SHA-256); the ExifTool minimum becomes 12.76 | Ubuntu is the standard, cheapest-to-provision base and matches the oldest-glibc rule for future Linux packages (S5-T05); testing the oldest distribution package plus the tested release turns the minimum into evidence instead of a guess; the Arch container (DEC-013) existed only to satisfy a 13.55 floor no stable Debian/Ubuntu release ships | Active |
| DEC-015 | 2026-10-28 | Canonical read arguments are `-json -a -G1:4 -s -- <absolute path>`, run through the single bounded runner `adapter/exiftool/process.rs` that the `-ver` probe also uses | `-G1:4` keeps both the family-1 group and the copy number, so same-name tags in different groups and repeated instances stay distinct; `-G4` alone (previously in §4.3) drops the group name; one runner avoids two competing execution paths | Active |
| DEC-016 | 2026-10-28 | Maintainer exception: S1 work may start while gate `G0` waits only on S0-T05's first CI run, which the maintainer deferred to the MVP draft PR | All other S0 tasks are done with local and manual evidence; G0 stays open and is not claimed until that CI run passes and proves failing changes are blocked; any S0-T05 fallout (e.g. the ExifTool 12.76 leg) is fixed before G1 is claimed | Active |
| DEC-017 | 2026-10-29 | Renderer E2E tier uses plain `@playwright/test` (Chromium, mocked Tauri bridge) with two projects: `behavior` (runs anywhere) and `snapshots` (pixel baselines generated and compared only in the pinned `mcr.microsoft.com/playwright` image, locally via Docker and in CI); the served app is a production build (`vite preview`) | Spec allowed WebdriverIO browser mode or Playwright; Playwright has first-class screenshot comparison, auto-waiting and request routing (used to prove theme pre-paint); pinned container makes fonts and browser identical between machines; production build loads CSS as `<link>` like the packaged app. Not chosen: `tauri-plugin-playwright` and `tauri-pilot` drive the real webview through an in-app control server, so they compete for the native tier and are evaluated at S3-T07, not here. The mock replaces Tauri internals (`window.__TAURI_INTERNALS__`); move it onto the S1-T05 typed IPC seam when that lands | Active |

**To record a future decision:** add a row with a new `DEC-###` ID, date, adopted choice, tradeoff and supersession reference; edit relevant requirement, task and tests together. Do not erase a superseded decision or create a separate `.md` ADR file.

---

## 19. Authoritative external references (implementation documentation, not copied specs)

Use official upstream sources when implementing or updating behaviors. APIs and versions may evolve; **verify these against the pinned dependency versions** and add integration tests rather than assuming doc examples will always hold.

- ExifTool official homepage and file support matrix: https://exiftool.org/
- ExifTool official installation instructions and Windows companion-file requirements: https://exiftool.org/install.html
- ExifTool application options and read/write/backup/advanced argument semantics: https://exiftool.org/exiftool_pod.html
- ExifTool tag tables, descriptions and read/write capability: https://exiftool.org/TagNames/
- Tauri v2 sidecar/external executable bundling: https://v2.tauri.app/develop/sidecar/
- Tauri v2 testing guidance: https://v2.tauri.app/develop/tests/
- Tauri v2 security and plugin permission guidance: https://v2.tauri.app/learn/security/using-plugin-permissions/
- Tauri v2 filesystem plugin behavior: https://v2.tauri.app/plugin/file-system/
- Tauri v2 dialog plugin: https://v2.tauri.app/plugin/dialog/
- WebdriverIO Tauri service (verify support and version before use): https://webdriver.io/docs/tauri-service/
- ExifToolGUI historic external ExifTool dependency model: https://exiftool.org/gui/index.html

---

## 20. Final definitions of success

**A successful Linux MVP is not a pretty viewer.** It is an installed, offline ExifTool frontend that can inspect arbitrary supported file families; safely plan, execute and verify real metadata changes in batches; preserve user recovery options; display exact command intent and truthful per-file outcomes; pass real automated tests; and work in both dark and light themes.

**A successful stable ExifBee release is not a claim that all ExifTool tags are editable.** It is a truthful, dynamic and complete-access interface to the **capabilities that a particular installed/bundled ExifTool actually provides**, including a safe advanced escape hatch and clear limits, on verified Linux, macOS and Windows packages.

**A successful SDD process is not the number of checked boxes.** It is an auditable invariant: requirements remain stable and intentional, tests assert user-visible behavior, CI verifies those tests, release gates reflect the platform actually exercised, and documentation stays small enough to remain accurate.

**End of ExifBee SDD v1.0.10.**
