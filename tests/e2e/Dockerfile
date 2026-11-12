# Native E2E environment (DEC-027): Ubuntu 24.04, which packages WebKitWebDriver; Arch does not.
# The base is the Playwright image the repo already pins, for its Node and because it is cached.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea

ENV RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/opt/exiftool:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev build-essential curl file \
    libxdo-dev libssl-dev librsvg2-dev webkit2gtk-driver xvfb dbus \
  && curl -fsSL -o /tmp/exiftool.tar.gz https://sourceforge.net/projects/exiftool/files/Image-ExifTool-13.55.tar.gz/download \
  && echo '5f4c81d34ad406538c2871ad72dbfceb5d9b412b2f16cbbeb4d712d270846667  /tmp/exiftool.tar.gz' | sha256sum -c - \
  && mkdir /opt/exiftool && tar -xzf /tmp/exiftool.tar.gz -C /opt/exiftool --strip-components=1 \
  && curl -fsSL https://sh.rustup.rs | CARGO_HOME=/usr/local/cargo sh -s -- -y --profile minimal --default-toolchain 1.98.1 \
  && CARGO_HOME=/usr/local/cargo cargo install tauri-driver --version 2.1.0 --locked \
  && chmod -R a+rX /usr/local/rustup /usr/local/cargo
