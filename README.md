# ExifBee

Offline desktop interface for [ExifTool](https://exiftool.org/) by Phil Harvey. ExifBee is an independent project, not affiliated with or endorsed by ExifTool's author.

Status: early development, Linux first. The product and architecture specification is [docs/SPEC.md](docs/SPEC.md); task status lives there.

## Development setup (Linux)

| Tool             | Version                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Node.js          | 24.21.0 (pinned in `.node-version` and `package.json` `engines`)                                             |
| npm              | 11.19.0 (ships with Node 24.21.0)                                                                            |
| Rust             | 1.90 or newer (`rust-version` in `src-tauri/Cargo.toml`), installed with rustup                              |
| System libraries | WebKitGTK 4.1, GTK 3 and the [Tauri v2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) |
| ExifTool         | 13.55 or newer (provisional minimum, see below); integration tests use it                                    |

### 1. System packages

Debian / Ubuntu (apt):

```bash
sudo apt update
sudo apt install build-essential curl file git libwebkit2gtk-4.1-dev libxdo-dev libssl-dev librsvg2-dev libimage-exiftool-perl
```

Arch / CachyOS / Manjaro (pacman; `paru -S` or `yay -S` take the same names):

```bash
sudo pacman -S --needed base-devel curl file git openssl webkit2gtk-4.1 librsvg xdotool appmenu-gtk-module rustup perl-image-exiftool
```

ExifBee has no tray icon, so Tauri's optional appindicator package is not needed. CI installs the Debian/Ubuntu list on Ubuntu 24.04; the Arch list is the equivalent set of Arch packages.

### 2. Rust and Node.js

- Rust: Arch installs `rustup` above, then run `rustup default stable`. On Debian/Ubuntu install rustup from <https://rustup.rs> (the apt `rustc` is too old).
- Node.js 24.21.0: use a version manager that reads `.node-version`, such as [fnm](https://github.com/Schniz/fnm) (`fnm install` in the repo) or [mise](https://mise.jdx.dev/). Distribution `nodejs` packages are a different version on both families.

### 3. ExifTool version

ExifBee needs ExifTool 12.76 or newer, the Ubuntu 24.04 package; CI tests that package and the official 13.55 release. The apt and pacman packages above are new enough on Ubuntu 24.04+, Debian 13+ and Arch. Debian 12 ships 12.57, which ExifBee reports as unsupported; there, use an official release (exiftool.org hosts only the latest; SourceForge keeps every version). It needs only Perl:

```bash
curl -L -o Image-ExifTool-13.55.tar.gz https://sourceforge.net/projects/exiftool/files/Image-ExifTool-13.55.tar.gz/download
tar -xzf Image-ExifTool-13.55.tar.gz
export EXIFTOOL="$PWD/Image-ExifTool-13.55/exiftool"
```

`EXIFTOOL` (an absolute path) tells the tests which ExifTool to use; otherwise they find it the same way the app does.

### 4. Build and run

```bash
npm ci
npm run dev     # development window with hot reload
npm run build   # release binary at src-tauri/target/release/exifbee
npm test        # unit + real-ExifTool integration tests
```

Installers (AppImage, `.deb`, `.rpm`) are not produced yet; bundling is disabled until task S5-T05 in the spec.

Renderer end-to-end tests (Playwright, see spec §6.1.1): `npm run test:e2e:renderer` runs the behavior tests locally (first run `npx playwright install chromium`); `npm run test:e2e:renderer:docker` runs everything, including screenshot comparisons, in the pinned Playwright Docker image and writes any missing baselines. If Docker needs root on your machine, run `DOCKER="sudo docker" npm run test:e2e:renderer:docker` so only Docker runs as root and the files stay yours.

Other scripts: `npm run fixtures` (regenerate `tests/fixtures`), `npm run test:unit`, `npm run test:integration`, `npm run coverage` (needs `cargo-llvm-cov`), `npm run audit:deps` (needs `cargo-audit`), `npm run lint`, `npm run typecheck`, `npm run format`, `npm run format:check`.

## License

MIT for ExifBee source ([LICENSE](LICENSE)). ExifTool is separate software under its own license; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
