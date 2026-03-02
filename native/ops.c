#include "ops.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32

/* ---- Windows implementation ---- */

#define EPOCH_DIFF_100NS 116444736000000000ULL

static double filetime_to_ms(FILETIME ft) {
    ULARGE_INTEGER u;
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return (double)(u.QuadPart - EPOCH_DIFF_100NS) / 10000.0;
}

static uint32_t win32_mode(DWORD attr) {
    uint32_t m = 0;
    if (attr & FILE_ATTRIBUTE_DIRECTORY) m |= 0040755;
    else if (attr & FILE_ATTRIBUTE_READONLY) m |= 0100444;
    else m |= 0100644;
    return m;
}

static void set_errno_from_win32(void) {
    switch (GetLastError()) {
        case ERROR_FILE_NOT_FOUND:
        case ERROR_PATH_NOT_FOUND:  errno = ENOENT;  break;
        case ERROR_ACCESS_DENIED:   errno = EACCES;  break;
        case ERROR_ALREADY_EXISTS:
        case ERROR_FILE_EXISTS:     errno = EEXIST;  break;
        case ERROR_NOT_ENOUGH_MEMORY:
        case ERROR_OUTOFMEMORY:     errno = ENOMEM;  break;
        case ERROR_INVALID_HANDLE:  errno = EBADF;   break;
        case ERROR_INVALID_PARAMETER: errno = EINVAL; break;
        case ERROR_DIRECTORY:       errno = ENOTDIR; break;
        default:                    errno = EIO;     break;
    }
}

static wchar_t *utf8_to_wide(const char *s) {
    int len = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (len <= 0) return NULL;
    wchar_t *w = malloc(len * sizeof(wchar_t));
    MultiByteToWideChar(CP_UTF8, 0, s, -1, w, len);
    return w;
}

static char *wide_to_utf8(const wchar_t *w) {
    int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (len <= 0) return NULL;
    char *s = malloc(len);
    WideCharToMultiByte(CP_UTF8, 0, w, -1, s, len, NULL, NULL);
    return s;
}

/* ---- File descriptor table (Windows: HANDLEs) ---- */

typedef struct { char *id; HANDLE h; } fd_entry;
static fd_entry *fd_table = NULL;
static size_t fd_count = 0;
static int fd_next_id = 0;

static const char *fdt_add(HANDLE h) {
    fd_table = realloc(fd_table, (fd_count + 1) * sizeof(fd_entry));
    char buf[32];
    snprintf(buf, sizeof(buf), "fd-%d", fd_next_id++);
    fd_table[fd_count].id = strdup(buf);
    fd_table[fd_count].h = h;
    fd_count++;
    return fd_table[fd_count - 1].id;
}

static HANDLE fdt_get(const char *id) {
    for (size_t i = 0; i < fd_count; i++)
        if (strcmp(fd_table[i].id, id) == 0) return fd_table[i].h;
    return INVALID_HANDLE_VALUE;
}

static void fdt_remove(const char *id) {
    for (size_t i = 0; i < fd_count; i++) {
        if (strcmp(fd_table[i].id, id) == 0) {
            CloseHandle(fd_table[i].h);
            free(fd_table[i].id);
            fd_count--;
            if (i < fd_count) fd_table[i] = fd_table[fd_count];
            return;
        }
    }
}

/* ---- Operations ---- */

int op_entries(const char *dir_path, wbuf *out) {
    wchar_t *wdir = utf8_to_wide(dir_path);
    if (!wdir) { errno = EINVAL; return -1; }

    size_t dlen = wcslen(wdir);
    wchar_t *pattern = malloc((dlen + 3) * sizeof(wchar_t));
    wcscpy(pattern, wdir);
    if (dlen > 0 && wdir[dlen - 1] != L'\\' && wdir[dlen - 1] != L'/')
        wcscat(pattern, L"\\");
    wcscat(pattern, L"*");
    free(wdir);

    WIN32_FIND_DATAW ffd;
    HANDLE hFind = FindFirstFileW(pattern, &ffd);
    free(pattern);
    if (hFind == INVALID_HANDLE_VALUE) { set_errno_from_win32(); return -1; }

    size_t count_pos = out->len;
    wbuf_u32(out, 0);
    uint32_t count = 0;

    do {
        if (wcscmp(ffd.cFileName, L".") == 0 || wcscmp(ffd.cFileName, L"..") == 0)
            continue;

        char *name = wide_to_utf8(ffd.cFileName);
        if (!name) continue;

        int is_dir = (ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        int is_link = (ffd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
        double size = (double)((uint64_t)ffd.nFileSizeHigh << 32 | ffd.nFileSizeLow);
        double mtime = filetime_to_ms(ffd.ftLastWriteTime);
        uint32_t mode = win32_mode(ffd.dwFileAttributes);

        wbuf_str(out, name);
        wbuf_u8(out, is_dir ? 1 : 0);
        wbuf_f64(out, size);
        wbuf_f64(out, mtime);
        wbuf_u32(out, mode);
        wbuf_u8(out, is_link ? 1 : 0);
        count++;
        free(name);
    } while (FindNextFileW(hFind, &ffd));

    FindClose(hFind);

    out->data[count_pos]     = (uint8_t)(count & 0xFF);
    out->data[count_pos + 1] = (uint8_t)((count >> 8) & 0xFF);
    out->data[count_pos + 2] = (uint8_t)((count >> 16) & 0xFF);
    out->data[count_pos + 3] = (uint8_t)(count >> 24);
    return 0;
}

int op_stat(const char *file_path, wbuf *out) {
    wchar_t *w = utf8_to_wide(file_path);
    if (!w) { errno = EINVAL; return -1; }
    WIN32_FILE_ATTRIBUTE_DATA attr;
    BOOL ok = GetFileAttributesExW(w, GetFileExInfoStandard, &attr);
    free(w);
    if (!ok) { set_errno_from_win32(); return -1; }
    double size = (double)((uint64_t)attr.nFileSizeHigh << 32 | attr.nFileSizeLow);
    wbuf_f64(out, size);
    wbuf_f64(out, filetime_to_ms(attr.ftLastWriteTime));
    return 0;
}

int op_exists(const char *file_path, wbuf *out) {
    wchar_t *w = utf8_to_wide(file_path);
    if (!w) { wbuf_u8(out, 0); return 0; }
    DWORD attr = GetFileAttributesW(w);
    free(w);
    wbuf_u8(out, attr != INVALID_FILE_ATTRIBUTES ? 1 : 0);
    return 0;
}

int op_readfile(const char *file_path, wbuf *out) {
    wchar_t *w = utf8_to_wide(file_path);
    if (!w) { errno = EINVAL; return -1; }
    HANDLE h = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    free(w);
    if (h == INVALID_HANDLE_VALUE) { set_errno_from_win32(); return -1; }

    LARGE_INTEGER li;
    if (!GetFileSizeEx(h, &li)) { CloseHandle(h); set_errno_from_win32(); return -1; }
    size_t total = (size_t)li.QuadPart;
    uint8_t *data = malloc(total);
    if (!data) { CloseHandle(h); errno = ENOMEM; return -1; }

    size_t off = 0;
    while (off < total) {
        DWORD n = 0;
        if (!ReadFile(h, data + off, (DWORD)(total - off), &n, NULL)) {
            free(data); CloseHandle(h); set_errno_from_win32(); return -1;
        }
        if (n == 0) break;
        off += n;
    }
    CloseHandle(h);
    wbuf_bytes(out, data, (uint32_t)off);
    free(data);
    return 0;
}

int op_open(const char *file_path, wbuf *out) {
    wchar_t *w = utf8_to_wide(file_path);
    if (!w) { errno = EINVAL; return -1; }
    HANDLE h = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    free(w);
    if (h == INVALID_HANDLE_VALUE) { set_errno_from_win32(); return -1; }
    const char *id = fdt_add(h);
    wbuf_str(out, id);
    return 0;
}

int op_read(const char *fd_id, long long offset, size_t length, wbuf *out) {
    HANDLE h = fdt_get(fd_id);
    if (h == INVALID_HANDLE_VALUE) { errno = EBADF; return -1; }

    uint8_t *buf = malloc(length);
    if (!buf) { errno = ENOMEM; return -1; }

    OVERLAPPED ovl = {0};
    ovl.Offset = (DWORD)(offset & 0xFFFFFFFF);
    ovl.OffsetHigh = (DWORD)((uint64_t)offset >> 32);
    DWORD n = 0;
    BOOL ok = ReadFile(h, buf, (DWORD)length, &n, &ovl);
    if (!ok && GetLastError() != ERROR_HANDLE_EOF) {
        free(buf); set_errno_from_win32(); return -1;
    }

    wbuf_bytes(out, buf, n);
    free(buf);
    return 0;
}

void op_close(const char *fd_id) {
    fdt_remove(fd_id);
}

void op_close_all(void) {
    for (size_t i = 0; i < fd_count; i++) {
        CloseHandle(fd_table[i].h);
        free(fd_table[i].id);
    }
    free(fd_table);
    fd_table = NULL;
    fd_count = 0;
}

#else /* Unix */

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef __APPLE__
#define MTIME_MS(st) ((double)(st).st_mtimespec.tv_sec * 1000.0 + (double)(st).st_mtimespec.tv_nsec / 1000000.0)
#else
#define MTIME_MS(st) ((double)(st).st_mtim.tv_sec * 1000.0 + (double)(st).st_mtim.tv_nsec / 1000000.0)
#endif

/* ---- File descriptor table ---- */

typedef struct {
    char *id;
    int fd;
} fd_entry;

static fd_entry *fd_table = NULL;
static size_t fd_count = 0;
static int fd_next_id = 0;

static const char *fdt_add(int fd) {
    fd_table = realloc(fd_table, (fd_count + 1) * sizeof(fd_entry));
    char buf[32];
    snprintf(buf, sizeof(buf), "fd-%d", fd_next_id++);
    fd_table[fd_count].id = strdup(buf);
    fd_table[fd_count].fd = fd;
    fd_count++;
    return fd_table[fd_count - 1].id;
}

static int fdt_get(const char *id) {
    for (size_t i = 0; i < fd_count; i++) {
        if (strcmp(fd_table[i].id, id) == 0)
            return fd_table[i].fd;
    }
    return -1;
}

static void fdt_remove(const char *id) {
    for (size_t i = 0; i < fd_count; i++) {
        if (strcmp(fd_table[i].id, id) == 0) {
            close(fd_table[i].fd);
            free(fd_table[i].id);
            fd_count--;
            if (i < fd_count)
                fd_table[i] = fd_table[fd_count];
            return;
        }
    }
}

/* ---- Operations ---- */

int op_entries(const char *dir_path, wbuf *out) {
    DIR *d = opendir(dir_path);
    if (!d) return -1;

    size_t count_pos = out->len;
    wbuf_u32(out, 0);
    uint32_t count = 0;

    size_t base_len = strlen(dir_path);
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0)
            continue;

        int is_dir = 0, is_link = 0;
#ifdef _DIRENT_HAVE_D_TYPE
        if (ent->d_type != DT_UNKNOWN) {
            is_dir = (ent->d_type == DT_DIR);
            is_link = (ent->d_type == DT_LNK);
        } else
#endif
        {
            size_t name_len = strlen(ent->d_name);
            char *full = malloc(base_len + 1 + name_len + 1);
            memcpy(full, dir_path, base_len);
            full[base_len] = '/';
            memcpy(full + base_len + 1, ent->d_name, name_len + 1);
            struct stat lst;
            if (lstat(full, &lst) == 0) {
                is_dir = S_ISDIR(lst.st_mode);
                is_link = S_ISLNK(lst.st_mode);
            }
            free(full);
        }

        size_t name_len = strlen(ent->d_name);
        char *full = malloc(base_len + 1 + name_len + 1);
        memcpy(full, dir_path, base_len);
        full[base_len] = '/';
        memcpy(full + base_len + 1, ent->d_name, name_len + 1);

        double size = 0, mtime_ms = 0;
        int mode = 0;
        struct stat st;
        if (stat(full, &st) == 0) {
            size = (double)st.st_size;
            mtime_ms = MTIME_MS(st);
            mode = (int)st.st_mode;
        }
        free(full);

        wbuf_str(out, ent->d_name);
        wbuf_u8(out, is_dir ? 1 : 0);
        wbuf_f64(out, size);
        wbuf_f64(out, mtime_ms);
        wbuf_u32(out, (uint32_t)mode);
        wbuf_u8(out, is_link ? 1 : 0);
        count++;
    }
    closedir(d);

    out->data[count_pos]     = (uint8_t)(count & 0xFF);
    out->data[count_pos + 1] = (uint8_t)((count >> 8) & 0xFF);
    out->data[count_pos + 2] = (uint8_t)((count >> 16) & 0xFF);
    out->data[count_pos + 3] = (uint8_t)(count >> 24);
    return 0;
}

int op_stat(const char *file_path, wbuf *out) {
    struct stat st;
    if (stat(file_path, &st) != 0) return -1;
    wbuf_f64(out, (double)st.st_size);
    wbuf_f64(out, MTIME_MS(st));
    return 0;
}

int op_exists(const char *file_path, wbuf *out) {
    wbuf_u8(out, access(file_path, F_OK) == 0 ? 1 : 0);
    return 0;
}

int op_readfile(const char *file_path, wbuf *out) {
    int fd = open(file_path, O_RDONLY);
    if (fd < 0) return -1;

    struct stat st;
    if (fstat(fd, &st) != 0) { close(fd); return -1; }

    size_t total_size = (size_t)st.st_size;
    uint8_t *data = malloc(total_size);
    if (!data) { close(fd); errno = ENOMEM; return -1; }

    size_t off = 0;
    while (off < total_size) {
        ssize_t n = read(fd, data + off, total_size - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            free(data);
            close(fd);
            return -1;
        }
        if (n == 0) break;
        off += (size_t)n;
    }
    close(fd);

    wbuf_bytes(out, data, (uint32_t)off);
    free(data);
    return 0;
}

int op_open(const char *file_path, wbuf *out) {
    int fd = open(file_path, O_RDONLY);
    if (fd < 0) return -1;
    const char *id = fdt_add(fd);
    wbuf_str(out, id);
    return 0;
}

int op_read(const char *fd_id, long long offset, size_t length, wbuf *out) {
    int fd = fdt_get(fd_id);
    if (fd < 0) { errno = EBADF; return -1; }

    uint8_t *buf = malloc(length);
    if (!buf) { errno = ENOMEM; return -1; }

    ssize_t n = pread(fd, buf, length, (off_t)offset);
    if (n < 0) { free(buf); return -1; }

    wbuf_bytes(out, buf, (uint32_t)n);
    free(buf);
    return 0;
}

void op_close(const char *fd_id) {
    fdt_remove(fd_id);
}

void op_close_all(void) {
    for (size_t i = 0; i < fd_count; i++) {
        close(fd_table[i].fd);
        free(fd_table[i].id);
    }
    free(fd_table);
    fd_table = NULL;
    fd_count = 0;
}

#endif /* Unix */
