#ifndef FARADAY_IO_H
#define FARADAY_IO_H

#include "platform.h"
#include <stddef.h>
#include <stdint.h>

/* Length-prefixed binary message reader. */
typedef struct {
    plat_fd fd;       /* used by mr_fill() on Unix; unused on Windows */
    uint8_t *buf;
    size_t len, cap;
} msg_reader;

void mr_init(msg_reader *r, plat_fd fd);
void mr_free(msg_reader *r);

/* Read available data into buffer via the stored fd. Returns bytes read, 0 on EOF, -1 on error.
   (Unix only — on Windows use mr_feed() from external read.) */
int mr_fill(msg_reader *r);

/* Append externally-read data into the reader buffer.
   (Used on Windows where reads are done via overlapped I/O.) */
void mr_feed(msg_reader *r, const uint8_t *data, size_t len);

/* Extract next complete message from buffer. Returns malloc'd payload, sets *msg_len.
   Returns NULL if no complete message available. */
uint8_t *mr_next_msg(msg_reader *r, size_t *msg_len);

/* Write a length-prefixed message: [4:len][data...]. Returns 0 on success, -1 on error. */
int msg_write(plat_fd fd, const uint8_t *data, size_t len);

#endif
