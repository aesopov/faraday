#include "watch.h"

#include <stdlib.h>
#include <string.h>

/* ============================================================
 * macOS — kqueue
 * ============================================================ */
#ifdef __APPLE__

#include <sys/event.h>
#include <fcntl.h>
#include <unistd.h>

typedef struct {
    char *watch_id;
    char *dir_path;
    int dir_fd;
} watch_entry;

static int kq = -1;
static watch_entry *watches = NULL;
static size_t watch_count = 0;

int watch_init(void) {
    kq = kqueue();
    return kq;
}

void watch_cleanup(void) {
    for (size_t i = 0; i < watch_count; i++) {
        close(watches[i].dir_fd);
        free(watches[i].watch_id);
        free(watches[i].dir_path);
    }
    free(watches);
    watches = NULL;
    watch_count = 0;
    if (kq >= 0) { close(kq); kq = -1; }
}

int watch_add(const char *watch_id, const char *dir_path) {
    if (kq < 0) return -1;

    watch_remove(watch_id);

    int dir_fd = open(dir_path, O_RDONLY | O_EVTONLY);
    if (dir_fd < 0) return -1;

    struct kevent ev;
    EV_SET(&ev, dir_fd, EVFILT_VNODE,
           EV_ADD | EV_ENABLE | EV_CLEAR,
           NOTE_WRITE | NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE,
           0, NULL);

    if (kevent(kq, &ev, 1, NULL, 0, NULL) < 0) {
        close(dir_fd);
        return -1;
    }

    watches = realloc(watches, (watch_count + 1) * sizeof(watch_entry));
    watches[watch_count].watch_id = strdup(watch_id);
    watches[watch_count].dir_path = strdup(dir_path);
    watches[watch_count].dir_fd = dir_fd;
    watch_count++;
    return 0;
}

void watch_remove(const char *watch_id) {
    for (size_t i = 0; i < watch_count; i++) {
        if (strcmp(watches[i].watch_id, watch_id) == 0) {
            close(watches[i].dir_fd);
            free(watches[i].watch_id);
            free(watches[i].dir_path);
            watch_count--;
            if (i < watch_count)
                watches[i] = watches[watch_count];
            return;
        }
    }
}

static const char *find_watch_id(int fd) {
    for (size_t i = 0; i < watch_count; i++) {
        if (watches[i].dir_fd == fd) return watches[i].watch_id;
    }
    return NULL;
}

static int parent_dead = 0;
static pid_t monitored_ppid = 0;

void watch_process(watch_callback_t cb) {
    if (kq < 0) return;

    struct kevent events[32];
    struct timespec ts = { 0, 0 };
    int n = kevent(kq, NULL, 0, events, 32, &ts);

    for (int i = 0; i < n; i++) {
        if (events[i].filter == EVFILT_PROC) {
            parent_dead = 1;
            continue;
        }

        const char *wid = find_watch_id((int)events[i].ident);
        if (!wid) continue;

        if (events[i].fflags & (NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE)) {
            cb(wid, "errored", NULL);
        } else {
            cb(wid, "unknown", NULL);
        }
    }
}

int watch_fd(void) { return kq; }

int watch_parent(int ppid) {
    if (kq < 0) return -1;
    monitored_ppid = (pid_t)ppid;
    struct kevent ev;
    EV_SET(&ev, (uintptr_t)ppid, EVFILT_PROC, EV_ADD, NOTE_EXIT, 0, NULL);
    return kevent(kq, &ev, 1, NULL, 0, NULL) < 0 ? -1 : 0;
}

int watch_parent_died(void) { return parent_dead; }

int watch_get_handles(void **out, int max) { (void)out; (void)max; return 0; }
void watch_process_at(int index, watch_callback_t cb) { (void)index; (void)cb; }

/* ============================================================
 * Linux — inotify
 * ============================================================ */
#elif defined(__linux__)

#include <sys/inotify.h>
#include <errno.h>
#include <unistd.h>

typedef struct {
    char *watch_id;
    char *dir_path;
    int wd;
} watch_entry;

static int ifd = -1;
static watch_entry *watches = NULL;
static size_t watch_count = 0;

int watch_init(void) {
    ifd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    return ifd;
}

void watch_cleanup(void) {
    for (size_t i = 0; i < watch_count; i++) {
        inotify_rm_watch(ifd, watches[i].wd);
        free(watches[i].watch_id);
        free(watches[i].dir_path);
    }
    free(watches);
    watches = NULL;
    watch_count = 0;
    if (ifd >= 0) { close(ifd); ifd = -1; }
}

int watch_add(const char *watch_id, const char *dir_path) {
    if (ifd < 0) return -1;
    watch_remove(watch_id);

    int wd = inotify_add_watch(ifd, dir_path,
        IN_CREATE | IN_DELETE | IN_MODIFY | IN_MOVED_FROM | IN_MOVED_TO |
        IN_DELETE_SELF | IN_MOVE_SELF);
    if (wd < 0) return -1;

    watches = realloc(watches, (watch_count + 1) * sizeof(watch_entry));
    watches[watch_count].watch_id = strdup(watch_id);
    watches[watch_count].dir_path = strdup(dir_path);
    watches[watch_count].wd = wd;
    watch_count++;
    return 0;
}

void watch_remove(const char *watch_id) {
    for (size_t i = 0; i < watch_count; i++) {
        if (strcmp(watches[i].watch_id, watch_id) == 0) {
            inotify_rm_watch(ifd, watches[i].wd);
            free(watches[i].watch_id);
            free(watches[i].dir_path);
            watch_count--;
            if (i < watch_count)
                watches[i] = watches[watch_count];
            return;
        }
    }
}

static const char *find_watch_id(int wd) {
    for (size_t i = 0; i < watch_count; i++) {
        if (watches[i].wd == wd) return watches[i].watch_id;
    }
    return NULL;
}

void watch_process(watch_callback_t cb) {
    if (ifd < 0) return;

    char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
    ssize_t n = read(ifd, buf, sizeof(buf));
    if (n <= 0) return;

    for (char *ptr = buf; ptr < buf + n; ) {
        struct inotify_event *ev = (struct inotify_event *)ptr;
        const char *wid = find_watch_id(ev->wd);
        if (wid) {
            const char *name = ev->len ? ev->name : NULL;
            if (ev->mask & (IN_DELETE_SELF | IN_MOVE_SELF)) {
                cb(wid, "errored", NULL);
            } else if (ev->mask & (IN_CREATE | IN_MOVED_TO)) {
                cb(wid, "appeared", name);
            } else if (ev->mask & (IN_DELETE | IN_MOVED_FROM)) {
                cb(wid, "disappeared", name);
            } else if (ev->mask & IN_MODIFY) {
                cb(wid, "modified", name);
            } else {
                cb(wid, "unknown", name);
            }
        }
        ptr += sizeof(struct inotify_event) + ev->len;
    }
}

int watch_fd(void) { return ifd; }

static int parent_dead_flag = 0;

int watch_parent(int ppid) {
    (void)ppid;
    return 0;
}

int watch_parent_died(void) { return parent_dead_flag; }

int watch_get_handles(void **out, int max) { (void)out; (void)max; return 0; }
void watch_process_at(int index, watch_callback_t cb) { (void)index; (void)cb; }

/* ============================================================
 * Windows — ReadDirectoryChangesW
 * ============================================================ */
#elif defined(_WIN32)

typedef struct {
    char *watch_id;
    HANDLE dir_handle;
    HANDLE event;
    OVERLAPPED overlapped;
    uint8_t buffer[8192];
    int active;
} watch_entry;

static watch_entry *watches = NULL;
static size_t watch_count = 0;

static wchar_t *utf8_to_wide_w(const char *s) {
    int len = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (len <= 0) return NULL;
    wchar_t *w = malloc(len * sizeof(wchar_t));
    MultiByteToWideChar(CP_UTF8, 0, s, -1, w, len);
    return w;
}

static char *wide_to_utf8_w(const wchar_t *w, int cch) {
    int len = WideCharToMultiByte(CP_UTF8, 0, w, cch, NULL, 0, NULL, NULL);
    if (len <= 0) return NULL;
    char *s = malloc(len + 1);
    WideCharToMultiByte(CP_UTF8, 0, w, cch, s, len, NULL, NULL);
    s[len] = '\0';
    return s;
}

static void issue_read(watch_entry *we) {
    memset(&we->overlapped, 0, sizeof(we->overlapped));
    we->overlapped.hEvent = we->event;
    we->active = ReadDirectoryChangesW(
        we->dir_handle, we->buffer, sizeof(we->buffer), FALSE,
        FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME |
        FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE |
        FILE_NOTIFY_CHANGE_CREATION,
        NULL, &we->overlapped, NULL);
}

int watch_init(void) { return 0; /* no global resource on Windows */ }

void watch_cleanup(void) {
    for (size_t i = 0; i < watch_count; i++) {
        if (watches[i].active) CancelIo(watches[i].dir_handle);
        CloseHandle(watches[i].dir_handle);
        CloseHandle(watches[i].event);
        free(watches[i].watch_id);
    }
    free(watches);
    watches = NULL;
    watch_count = 0;
}

int watch_add(const char *watch_id, const char *dir_path) {
    watch_remove(watch_id);

    wchar_t *wpath = utf8_to_wide_w(dir_path);
    if (!wpath) return -1;

    HANDLE h = CreateFileW(wpath, FILE_LIST_DIRECTORY,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED, NULL);
    free(wpath);
    if (h == INVALID_HANDLE_VALUE) return -1;

    HANDLE evt = CreateEvent(NULL, TRUE, FALSE, NULL);
    if (!evt) { CloseHandle(h); return -1; }

    watches = realloc(watches, (watch_count + 1) * sizeof(watch_entry));
    watch_entry *we = &watches[watch_count];
    we->watch_id = strdup(watch_id);
    we->dir_handle = h;
    we->event = evt;
    we->active = 0;
    watch_count++;

    issue_read(we);
    return 0;
}

void watch_remove(const char *watch_id) {
    for (size_t i = 0; i < watch_count; i++) {
        if (strcmp(watches[i].watch_id, watch_id) == 0) {
            if (watches[i].active) CancelIo(watches[i].dir_handle);
            CloseHandle(watches[i].dir_handle);
            CloseHandle(watches[i].event);
            free(watches[i].watch_id);
            watch_count--;
            if (i < watch_count)
                watches[i] = watches[watch_count];
            return;
        }
    }
}

int watch_get_handles(void **out, int max) {
    int n = 0;
    for (size_t i = 0; i < watch_count && n < max; i++) {
        if (watches[i].active) out[n++] = watches[i].event;
    }
    return n;
}

void watch_process_at(int index, watch_callback_t cb) {
    /* Map index back to watch entry (only active entries are in handle array) */
    int idx = 0;
    watch_entry *we = NULL;
    for (size_t i = 0; i < watch_count; i++) {
        if (watches[i].active) {
            if (idx == index) { we = &watches[i]; break; }
            idx++;
        }
    }
    if (!we) return;

    DWORD bytes = 0;
    if (!GetOverlappedResult(we->dir_handle, &we->overlapped, &bytes, FALSE) || bytes == 0) {
        we->active = 0;
        cb(we->watch_id, "errored", NULL);
        return;
    }

    ResetEvent(we->event);

    FILE_NOTIFY_INFORMATION *fni = (FILE_NOTIFY_INFORMATION *)we->buffer;
    for (;;) {
        int cch = (int)(fni->FileNameLength / sizeof(wchar_t));
        char *name = wide_to_utf8_w(fni->FileName, cch);
        const char *type;
        switch (fni->Action) {
            case FILE_ACTION_ADDED:
            case FILE_ACTION_RENAMED_NEW_NAME: type = "appeared"; break;
            case FILE_ACTION_REMOVED:
            case FILE_ACTION_RENAMED_OLD_NAME: type = "disappeared"; break;
            case FILE_ACTION_MODIFIED:         type = "modified"; break;
            default:                           type = "unknown"; break;
        }
        cb(we->watch_id, type, name);
        free(name);
        if (fni->NextEntryOffset == 0) break;
        fni = (FILE_NOTIFY_INFORMATION *)((uint8_t *)fni + fni->NextEntryOffset);
    }

    issue_read(we);
}

/* process all signaled watches (non-blocking check) */
void watch_process(watch_callback_t cb) {
    for (size_t i = 0; i < watch_count; i++) {
        if (watches[i].active && WaitForSingleObject(watches[i].event, 0) == WAIT_OBJECT_0) {
            /* find the index among active entries */
            int idx = 0;
            for (size_t j = 0; j < i; j++)
                if (watches[j].active) idx++;
            watch_process_at(idx, cb);
        }
    }
}

int watch_fd(void) { return -1; }

int watch_parent(int ppid) { (void)ppid; return 0; }
int watch_parent_died(void) { return 0; }

/* ============================================================
 * Unsupported platform — stubs
 * ============================================================ */
#else

int  watch_init(void) { return -1; }
void watch_cleanup(void) {}
int  watch_add(const char *watch_id, const char *dir_path) { (void)watch_id; (void)dir_path; return -1; }
void watch_remove(const char *watch_id) { (void)watch_id; }
void watch_process(watch_callback_t cb) { (void)cb; }
int  watch_fd(void) { return -1; }
int  watch_parent(int ppid) { (void)ppid; return -1; }
int  watch_parent_died(void) { return 0; }
int  watch_get_handles(void **out, int max) { (void)out; (void)max; return 0; }
void watch_process_at(int index, watch_callback_t cb) { (void)index; (void)cb; }

#endif
