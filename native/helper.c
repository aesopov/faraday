/*
 * faraday-helper: lightweight elevated filesystem helper.
 *
 * Speaks a length-prefixed binary protocol over a Unix domain socket (macOS/Linux)
 * or a named pipe (Windows).
 * Wire format: [4:payload_len (u32 LE)][payload...]
 */

#include "io.h"
#include "ops.h"
#include "proto.h"
#include "watch.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
/* Windows includes */
#else
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif
#endif

static plat_fd g_sock_fd = PLAT_BAD_FD;
static volatile int should_exit = 0;

/* ---- Platform-specific signal / ctrl handling ---- */

#ifdef _WIN32
static BOOL WINAPI ctrl_handler(DWORD type) {
    (void)type;
    should_exit = 1;
    return TRUE;
}
#else
static void handle_signal(int sig) {
    (void)sig;
    should_exit = 1;
}
#endif

/* ---- Platform-specific connection ---- */

#ifdef _WIN32
static plat_fd connect_pipe(const char *name) {
    HANDLE h = CreateFileA(name, GENERIC_READ | GENERIC_WRITE,
                           0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        /* Pipe may not be ready yet — retry a few times */
        for (int i = 0; i < 10 && h == INVALID_HANDLE_VALUE; i++) {
            Sleep(200);
            h = CreateFileA(name, GENERIC_READ | GENERIC_WRITE,
                            0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
        }
    }
    return h;
}
#else
static plat_fd connect_socket(const char *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}
#endif

/* ---- Common protocol helpers ---- */

static int send_auth(plat_fd fd, const char *token) {
    size_t tlen = strlen(token);
    wbuf w;
    wbuf_init(&w);
    wbuf_u8(&w, MSG_AUTH);
    wbuf_raw(&w, token, tlen);
    int rc = msg_write(fd, w.data, w.len);
    wbuf_free(&w);
    return rc;
}

static void send_error(plat_fd fd, uint32_t id, const char *code, const char *message) {
    wbuf w;
    wbuf_init(&w);
    wbuf_u8(&w, MSG_ERROR);
    wbuf_u32(&w, id);
    wbuf_str(&w, code);
    wbuf_str(&w, message);
    msg_write(fd, w.data, w.len);
    wbuf_free(&w);
}

static void send_response(plat_fd fd, uint32_t id, wbuf *payload) {
    wbuf w;
    wbuf_init(&w);
    wbuf_u8(&w, MSG_RESPONSE);
    wbuf_u32(&w, id);
    if (payload->len > 0)
        wbuf_raw(&w, payload->data, payload->len);
    msg_write(fd, w.data, w.len);
    wbuf_free(&w);
}

static const char *errno_code(int e) {
    switch (e) {
        case ENOENT:  return "ENOENT";
        case EACCES:  return "EACCES";
        case EPERM:   return "EPERM";
#ifdef ENOTDIR
        case ENOTDIR: return "ENOTDIR";
#endif
#ifdef EISDIR
        case EISDIR:  return "EISDIR";
#endif
        case ENOMEM:  return "ENOMEM";
        case EEXIST:  return "EEXIST";
        case EBADF:   return "EBADF";
        case EINVAL:  return "EINVAL";
        case EIO:     return "EIO";
        default:      return "UNKNOWN";
    }
}

/* ---- Watch event callback ---- */

static void on_watch_event(const char *watch_id, const char *type_str, const char *name) {
    uint8_t type_code;
    if (strcmp(type_str, "appeared") == 0)         type_code = EVT_APPEARED;
    else if (strcmp(type_str, "disappeared") == 0) type_code = EVT_DISAPPEARED;
    else if (strcmp(type_str, "modified") == 0)    type_code = EVT_MODIFIED;
    else if (strcmp(type_str, "errored") == 0)     type_code = EVT_ERRORED;
    else                                           type_code = EVT_UNKNOWN;

    wbuf w;
    wbuf_init(&w);
    wbuf_u8(&w, MSG_EVENT);
    wbuf_str(&w, watch_id);
    wbuf_u8(&w, type_code);
    wbuf_u8(&w, name ? 1 : 0);
    if (name) wbuf_str(&w, name);
    msg_write(g_sock_fd, w.data, w.len);
    wbuf_free(&w);
}

/* ---- Request dispatch ---- */

static void handle_request(plat_fd fd, const uint8_t *msg, size_t msg_len) {
    rbuf r;
    rbuf_init(&r, msg, msg_len);

    uint32_t id = rbuf_u32(&r);
    uint8_t method = rbuf_u8(&r);

    wbuf out;
    wbuf_init(&out);
    int rc = 0;

    switch (method) {
        case METHOD_PING:
            break;
        case METHOD_ENTRIES: {
            char *p = rbuf_strdup(&r);
            if (p) { rc = op_entries(p, &out); free(p); }
            else { errno = EINVAL; rc = -1; }
            break;
        }
        case METHOD_STAT: {
            char *p = rbuf_strdup(&r);
            if (p) { rc = op_stat(p, &out); free(p); }
            else { errno = EINVAL; rc = -1; }
            break;
        }
        case METHOD_EXISTS: {
            char *p = rbuf_strdup(&r);
            if (p) { rc = op_exists(p, &out); free(p); }
            else { rc = op_exists("", &out); }
            break;
        }
        case METHOD_READFILE: {
            char *p = rbuf_strdup(&r);
            if (p) { rc = op_readfile(p, &out); free(p); }
            else { errno = EINVAL; rc = -1; }
            break;
        }
        case METHOD_OPEN: {
            char *p = rbuf_strdup(&r);
            if (p) { rc = op_open(p, &out); free(p); }
            else { errno = EINVAL; rc = -1; }
            break;
        }
        case METHOD_READ: {
            char *fid = rbuf_strdup(&r);
            double offset = rbuf_f64(&r);
            double length = rbuf_f64(&r);
            if (fid) { rc = op_read(fid, (long long)offset, (size_t)length, &out); free(fid); }
            else { errno = EINVAL; rc = -1; }
            break;
        }
        case METHOD_CLOSE: {
            char *fid = rbuf_strdup(&r);
            if (fid) { op_close(fid); free(fid); }
            break;
        }
        case METHOD_WATCH: {
            char *wid = rbuf_strdup(&r);
            char *p = rbuf_strdup(&r);
            if (wid && p) {
                int ok = watch_add(wid, p);
                wbuf_u8(&out, ok == 0 ? 1 : 0);
            } else {
                wbuf_u8(&out, 0);
            }
            free(wid);
            free(p);
            break;
        }
        case METHOD_UNWATCH: {
            char *wid = rbuf_strdup(&r);
            if (wid) { watch_remove(wid); free(wid); }
            break;
        }
        default:
            send_error(fd, id, "ENOSYS", "Unknown method");
            wbuf_free(&out);
            return;
    }

    if (rc == 0) {
        send_response(fd, id, &out);
    } else {
        int saved = errno;
        send_error(fd, id, errno_code(saved), strerror(saved));
    }
    wbuf_free(&out);
}

/* ---- Process all messages from the reader ---- */

static void drain_messages(plat_fd fd, msg_reader *reader) {
    size_t msg_len;
    uint8_t *msg;
    while ((msg = mr_next_msg(reader, &msg_len)) != NULL) {
        if (msg_len > 0 && msg[0] == MSG_REQUEST) {
            handle_request(fd, msg + 1, msg_len - 1);
        }
        free(msg);
    }
}

/* ==================================================================
 * Windows main loop — named pipe + WaitForMultipleObjects
 * ================================================================== */
#ifdef _WIN32

int main(int argc, char *argv[]) {
    const char *pipe_name = NULL;
    const char *token = NULL;
    DWORD ppid = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc)
            pipe_name = argv[++i];
        else if (strcmp(argv[i], "--token") == 0 && i + 1 < argc)
            token = argv[++i];
        else if (strcmp(argv[i], "--ppid") == 0 && i + 1 < argc)
            ppid = (DWORD)atoi(argv[++i]);
    }

    if (!pipe_name || !token) {
        fprintf(stderr, "Usage: faraday-helper --socket <pipe> --token <hex> [--ppid <pid>]\n");
        return 1;
    }

    SetConsoleCtrlHandler(ctrl_handler, TRUE);

    HANDLE pipe = connect_pipe(pipe_name);
    if (pipe == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "Failed to connect to %s\n", pipe_name);
        return 1;
    }
    g_sock_fd = pipe;

    if (send_auth(pipe, token) < 0) {
        fprintf(stderr, "Failed to send auth\n");
        CloseHandle(pipe);
        return 1;
    }

    watch_init();

    /* Parent process monitoring */
    HANDLE parent_handle = NULL;
    if (ppid) {
        parent_handle = OpenProcess(SYNCHRONIZE, FALSE, ppid);
    }

    /* Overlapped read setup */
    HANDLE read_event = CreateEvent(NULL, TRUE, FALSE, NULL);
    OVERLAPPED read_ovl = {0};
    read_ovl.hEvent = read_event;
    uint8_t read_buf[65536];

    /* Start first async read */
    ReadFile(pipe, read_buf, sizeof(read_buf), NULL, &read_ovl);

    msg_reader reader;
    mr_init(&reader, pipe);

    while (!should_exit) {
        HANDLE handles[64];
        int nh = 0;

        handles[nh++] = read_event;
        int parent_idx = -1;
        if (parent_handle) {
            parent_idx = nh;
            handles[nh++] = parent_handle;
        }
        int watch_base = nh;
        int nw = watch_get_handles((void **)(handles + nh), 64 - nh);
        nh += nw;

        DWORD r = WaitForMultipleObjects(nh, handles, FALSE, INFINITE);

        if (r == WAIT_OBJECT_0) {
            /* Pipe data ready */
            DWORD bytes = 0;
            if (!GetOverlappedResult(pipe, &read_ovl, &bytes, FALSE) || bytes == 0)
                break; /* pipe closed or error */

            mr_feed(&reader, read_buf, bytes);
            drain_messages(pipe, &reader);

            /* Re-issue async read */
            ResetEvent(read_event);
            memset(&read_ovl, 0, sizeof(read_ovl));
            read_ovl.hEvent = read_event;
            if (!ReadFile(pipe, read_buf, sizeof(read_buf), NULL, &read_ovl)) {
                if (GetLastError() != ERROR_IO_PENDING) break;
            }
        } else if (parent_idx >= 0 && r == (DWORD)(WAIT_OBJECT_0 + parent_idx)) {
            break; /* parent died */
        } else if (r >= (DWORD)(WAIT_OBJECT_0 + watch_base) &&
                   r <  (DWORD)(WAIT_OBJECT_0 + watch_base + nw)) {
            watch_process_at((int)(r - WAIT_OBJECT_0 - watch_base), on_watch_event);
        } else if (r == WAIT_FAILED) {
            break;
        }
    }

    op_close_all();
    watch_cleanup();
    mr_free(&reader);
    CloseHandle(read_event);
    CloseHandle(pipe);
    if (parent_handle) CloseHandle(parent_handle);
    return 0;
}

/* ==================================================================
 * Unix main loop — AF_UNIX socket + poll()
 * ================================================================== */
#else

int main(int argc, char *argv[]) {
    const char *sock_path = NULL;
    const char *token = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc)
            sock_path = argv[++i];
        else if (strcmp(argv[i], "--token") == 0 && i + 1 < argc)
            token = argv[++i];
    }

    if (!sock_path || !token) {
        fprintf(stderr, "Usage: faraday-helper --socket <path> --token <hex>\n");
        return 1;
    }

    /* Parent death detection */
    signal(SIGHUP, handle_signal);
    signal(SIGTERM, handle_signal);
#ifdef __linux__
    prctl(PR_SET_PDEATHSIG, SIGHUP);
    if (getppid() == 1) return 1;
#endif

    int fd = connect_socket(sock_path);
    if (fd < 0) {
        fprintf(stderr, "Failed to connect to %s\n", sock_path);
        return 1;
    }
    g_sock_fd = fd;

    if (send_auth(fd, token) < 0) {
        fprintf(stderr, "Failed to send auth\n");
        close(fd);
        return 1;
    }

    int wfd = watch_init();

    /* Monitor parent process on macOS via kqueue */
#ifdef __APPLE__
    if (wfd >= 0) {
        watch_parent(getppid());
    }
#endif

    struct pollfd pfds[2];
    int nfds = 1;
    pfds[0].fd = fd;
    pfds[0].events = POLLIN;
    if (wfd >= 0) {
        pfds[1].fd = wfd;
        pfds[1].events = POLLIN;
        nfds = 2;
    }

    msg_reader reader;
    mr_init(&reader, fd);

    while (!should_exit) {
        int rc = poll(pfds, (nfds_t)nfds, -1);
        if (rc < 0) {
            if (errno == EINTR) continue;
            break;
        }

        if (pfds[0].revents & POLLIN) {
            int n = mr_fill(&reader);
            if (n <= 0) break;
            drain_messages(fd, &reader);
        } else if (pfds[0].revents & (POLLHUP | POLLERR)) {
            break;
        }

        if (nfds > 1 && pfds[1].revents & POLLIN) {
            watch_process(on_watch_event);
            if (watch_parent_died()) break;
        }
    }

    op_close_all();
    watch_cleanup();
    mr_free(&reader);
    close(fd);
    return 0;
}

#endif
