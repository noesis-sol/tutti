/* A native helper compiled at run time by bun:ffi's cc (TinyCC), for the spike's `cc` scenario:
   C calls openat as the variadic function it is, so the mode reaches it on every ABI. No system
   headers, so that it compiles without a C SDK. */
int openat(int dirfd, const char *path, int flags, ...);

int helper_openat(int dirfd, const char *path, int flags, int mode) {
  return openat(dirfd, path, flags, mode);
}
