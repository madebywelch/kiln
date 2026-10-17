#!/bin/sh
# Offline toolchain checks under a run's minimal environment: a cold private
# HOME and TMPDIR plus the inherited cache locations, as the non-root user.
set -eu
work=$(mktemp -d /data/toolchain-smoke.XXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
export HOME="$work/home" TMPDIR="$work/tmp"
mkdir -p "$HOME" "$TMPDIR"

# Image defaults resolve without any repository pin, including from the login
# shell Codex uses. System installs are read-only.
node --version | grep '^v24\.21\.0$'
npm --version
pnpm --version | grep '^10\.33\.0$'
go version | grep ' go1\.27\.2 '
python3 --version
mise --version
/bin/bash -lc 'node --version; go version; cargo --version' | grep -c '' | grep '^3$'
test ! -w /usr/local/share/mise/installs/node/24.21.0/bin/node
test ! -w "$(rustc --print sysroot)"

# A repository's own pins select image-provided versions offline.
mkdir -p "$work/pinned" && cd "$work/pinned"
printf '24\n' > .node-version
node --version | grep '^v24\.21\.0$'
printf '{"name":"pin","private":true,"packageManager":"pnpm@10.33.0"}\n' > package.json
pnpm --version | grep '^10\.33\.0$'
cd "$work"

# Go builds use the shared module/build caches, not the private home. A go.mod
# `go` directive is a minimum, not a pin: the image's Go must serve it.
mkdir -p "$work/gohello" && cd "$work/gohello"
printf 'module hello\n\ngo 1.22\n' > go.mod
printf 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println(42) }\n' > main.go
go version | grep ' go1\.27\.2 '
go run . | grep '^42$'
test -d "$GOCACHE"
cd "$work"
# Nothing above may have reached for the network.
test ! -d "$MISE_DATA_DIR/installs"

# Rust: image-owned direct binaries, no rustup, no writable sysroot.
rustc --version | grep '^rustc 1\.99\.0 '
cargo --version | grep '^cargo 1\.99\.0 '
rustfmt --version
cargo clippy --version
# Stale shims in a home must not override image-owned components.
mkdir -p "$HOME/.cargo/bin"
printf '#!/bin/sh\nexit 91\n' > "$HOME/.cargo/bin/cargo-clippy"
chmod +x "$HOME/.cargo/bin/cargo-clippy"
/bin/bash -lc 'rustc --version; cargo --version; rustfmt --version; cargo clippy --version'
cargo init --quiet --vcs none --bin --name kiln_rust_smoke "$work/app"
cat > "$work/app/src/main.rs" <<'RS'
fn answer() -> u32 {
    42
}

fn main() {
    println!("{}", answer());
}

#[test]
fn computes_answer() {
    assert_eq!(answer(), 42);
}
RS
cargo test --offline --manifest-path "$work/app/Cargo.toml"
cargo fmt --check --manifest-path "$work/app/Cargo.toml"
cargo clippy --offline --manifest-path "$work/app/Cargo.toml" -- -D warnings
cargo run --offline --quiet --manifest-path "$work/app/Cargo.toml" | grep '^42$'

# Native toolchain and the libraries Tauri projects link against.
printf 'int main(void) { return 0; }\n' | cc -x c -o "$work/native-c" -
"$work/native-c"
printf 'int main() { return 0; }\n' | c++ -x c++ -o "$work/native-cpp" -
"$work/native-cpp"
pkg-config --exists openssl webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1 librsvg-2.0
# Temporary executables run from both the run TMPDIR and /tmp.
printf '#!/bin/sh\nexit 0\n' > "$TMPDIR/probe" && chmod +x "$TMPDIR/probe" && "$TMPDIR/probe"
printf '#!/bin/sh\nexit 0\n' > /tmp/kiln-probe && chmod +x /tmp/kiln-probe && /tmp/kiln-probe && rm /tmp/kiln-probe

if [ "${KILN_SMOKE_NETWORK-0}" = 1 ]; then
  # A pin the image does not carry is installed on first use into the cache.
  mkdir -p "$work/pin22" && cd "$work/pin22"
  printf '22.23.3\n' > .node-version
  node --version | grep '^v22\.23\.3$'
  test -d "$MISE_DATA_DIR/installs/node/22.23.3"
  cd "$work/pinned" && node --version | grep '^v24\.21\.0$'
  cd "$work"
fi
printf 'mise defaults, repository pins, Go, Rust, C/C++, Tauri libraries, and executable temporary directories verified.\n'
