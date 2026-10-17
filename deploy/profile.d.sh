# Debian's /etc/profile resets PATH for login shells (bash -lc, used by Codex).
# Keep the run's toolchains and the harness wrappers visible there too.
export PATH="/data/cache/mise/shims:/usr/local/share/mise/shims:/usr/local/bin:$PATH"
