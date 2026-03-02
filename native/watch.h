#ifndef FARADAY_WATCH_H
#define FARADAY_WATCH_H

#include "platform.h"

typedef void (*watch_callback_t)(const char *watch_id, const char *type, const char *name);

/* Initialize the watch subsystem. Returns the pollable fd (Unix), or 0 (Windows), or -1 on failure. */
int  watch_init(void);

/* Clean up all watches and the watch fd. */
void watch_cleanup(void);

/* Add a directory watch. Returns 0 on success, -1 on error. */
int  watch_add(const char *watch_id, const char *dir_path);

/* Remove a watch by ID. */
void watch_remove(const char *watch_id);

/* Process pending watch events, calling cb for each. */
void watch_process(watch_callback_t cb);

/* Return the pollable fd (kqueue/inotify). Returns -1 on Windows. */
int  watch_fd(void);

/* Monitor parent process for exit. Events appear on watch_fd() (macOS). */
int  watch_parent(int ppid);

/* Returns non-zero if parent process has exited. */
int  watch_parent_died(void);

/* Windows: get event HANDLEs for WaitForMultipleObjects. Returns count. */
int  watch_get_handles(void **out, int max);

/* Windows: process the watch that fired at the given index from watch_get_handles(). */
void watch_process_at(int index, watch_callback_t cb);

#endif
