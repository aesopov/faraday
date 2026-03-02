#ifndef FARADAY_OPS_H
#define FARADAY_OPS_H

#include "proto.h"

/* All ops write results to `out`. Return 0 on success, -1 on error (errno set). */

int  op_entries(const char *dir_path, wbuf *out);
int  op_stat(const char *file_path, wbuf *out);
int  op_exists(const char *file_path, wbuf *out);
int  op_readfile(const char *file_path, wbuf *out);
int  op_open(const char *file_path, wbuf *out);
int  op_read(const char *fd_id, long long offset, size_t length, wbuf *out);
void op_close(const char *fd_id);
void op_close_all(void);

#endif
