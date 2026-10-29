# ExifBee

Offline desktop interface for [ExifTool](https://exiftool.org/) by Phil Harvey. ExifBee is an independent project, not affiliated with or endorsed by ExifTool's author.

Status: early development, Linux first. The product and architecture specification is [docs/SPEC.md](docs/SPEC.md); task status lives there.

## Development setup (Linux)

| Tool             | Version                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js          | 24.21.0 (pinned in `.node-version` and `package.json` `engines`)                                                                               |
| npm              | 11.19.0 (ships with Node 24.21.0)                                                                                                              |
| Rust             | 1.90 or newer (`rust-version` in `src-tauri/Cargo.toml`)                                                                                       |
| System libraries | WebKitGTK 4.1 and GTK 3 development packages, as listed in the [Tauri v2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) |

```bash
npm ci
npm run dev
```

Other scripts: `npm run build`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run format:check`.

## License

MIT for ExifBee source. ExifTool is separate software under its own license.
