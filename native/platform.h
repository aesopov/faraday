#ifndef FARADAY_PLATFORM_H
#define FARADAY_PLATFORM_H

#ifdef _WIN32
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
  typedef HANDLE plat_fd;
  #define PLAT_BAD_FD INVALID_HANDLE_VALUE

  typedef HANDLE fd_native_t;
  #define FD_NATIVE_BAD INVALID_HANDLE_VALUE
  #define fd_native_close(h) CloseHandle(h)
#else
  typedef int plat_fd;
  #define PLAT_BAD_FD (-1)

  typedef int fd_native_t;
  #define FD_NATIVE_BAD (-1)
  #define fd_native_close(fd) close(fd)
#endif

#endif
