# The dedicated VM remains the host boundary. Allow bubblewrap to construct
# nested user/mount/network namespaces without granting container capabilities.
# Ubuntu otherwise transitions unconfined user namespaces into a profile that
# denies bubblewrap's namespaced NET_ADMIN and SETPCAP operations.
profile kiln-container flags=(unconfined) {
  userns,
}
