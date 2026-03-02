#include "io.h"

#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
/* Windows: overlapped write helper for pipe opened with FILE_FLAG_OVERLAPPED */
#else
#include <errno.h>
#include <unistd.h>
#endif

void mr_init(msg_reader *r, plat_fd fd) {
    r->fd = fd;
    r->buf = NULL;
    r->len = 0;
    r->cap = 0;
}

void mr_free(msg_reader *r) {
    free(r->buf);
    r->buf = NULL;
    r->len = 0;
    r->cap = 0;
}

static void mr_ensure(msg_reader *r, size_t extra) {
    if (r->len + extra <= r->cap) return;
    size_t cap = r->cap ? r->cap * 2 : 8192;
    while (cap < r->len + extra) cap *= 2;
    r->buf = realloc(r->buf, cap);
    r->cap = cap;
}

void mr_feed(msg_reader *r, const uint8_t *data, size_t len) {
    mr_ensure(r, len);
    memcpy(r->buf + r->len, data, len);
    r->len += len;
}

int mr_fill(msg_reader *r) {
    mr_ensure(r, 4096);
#ifdef _WIN32
    DWORD n = 0;
    if (!ReadFile(r->fd, r->buf + r->len, (DWORD)(r->cap - r->len), &n, NULL))
        return -1;
    if (n == 0) return 0;
    r->len += n;
    return (int)n;
#else
    ssize_t n = read(r->fd, r->buf + r->len, r->cap - r->len);
    if (n < 0) return -1;
    if (n == 0) return 0;
    r->len += (size_t)n;
    return (int)n;
#endif
}

uint8_t *mr_next_msg(msg_reader *r, size_t *msg_len) {
    if (r->len < 4) return NULL;

    uint32_t plen = (uint32_t)r->buf[0]
                  | ((uint32_t)r->buf[1] << 8)
                  | ((uint32_t)r->buf[2] << 16)
                  | ((uint32_t)r->buf[3] << 24);

    if (r->len < 4 + plen) return NULL;

    uint8_t *msg = malloc(plen);
    if (!msg) return NULL;
    memcpy(msg, r->buf + 4, plen);
    *msg_len = plen;

    size_t remaining = r->len - 4 - plen;
    if (remaining) memmove(r->buf, r->buf + 4 + plen, remaining);
    r->len = remaining;
    return msg;
}

#ifdef _WIN32
static int write_all(plat_fd fd, const void *data, size_t len) {
    const uint8_t *p = data;
    size_t off = 0;
    while (off < len) {
        DWORD n = 0;
        OVERLAPPED ovl = {0};
        ovl.hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
        BOOL ok = WriteFile(fd, p + off, (DWORD)(len - off), &n, &ovl);
        if (!ok) {
            if (GetLastError() == ERROR_IO_PENDING)
                ok = GetOverlappedResult(fd, &ovl, &n, TRUE);
        }
        CloseHandle(ovl.hEvent);
        if (!ok) return -1;
        off += n;
    }
    return 0;
}
#else
static int write_all(plat_fd fd, const void *data, size_t len) {
    const uint8_t *p = data;
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, p + off, len - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        off += (size_t)n;
    }
    return 0;
}
#endif

int msg_write(plat_fd fd, const uint8_t *data, size_t len) {
    uint8_t header[4];
    header[0] = (uint8_t)(len & 0xFF);
    header[1] = (uint8_t)((len >> 8) & 0xFF);
    header[2] = (uint8_t)((len >> 16) & 0xFF);
    header[3] = (uint8_t)((len >> 24) & 0xFF);
    if (write_all(fd, header, 4) < 0) return -1;
    if (len > 0 && write_all(fd, data, len) < 0) return -1;
    return 0;
}
