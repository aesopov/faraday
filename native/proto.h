#ifndef FARADAY_PROTO_H
#define FARADAY_PROTO_H

#include <stddef.h>
#include <stdint.h>

/* Message types */
#define MSG_AUTH     0x01
#define MSG_REQUEST  0x02
#define MSG_RESPONSE 0x82
#define MSG_ERROR    0x83
#define MSG_EVENT    0x84

/* Method codes */
#define METHOD_ENTRIES   0x01
#define METHOD_STAT      0x02
#define METHOD_EXISTS    0x03
#define METHOD_READFILE  0x04
#define METHOD_OPEN      0x05
#define METHOD_READ      0x06
#define METHOD_CLOSE     0x07
#define METHOD_WATCH     0x08
#define METHOD_UNWATCH   0x09
#define METHOD_PING      0x0A

/* Event type codes */
#define EVT_APPEARED    0x00
#define EVT_DISAPPEARED 0x01
#define EVT_MODIFIED    0x02
#define EVT_ERRORED     0x03
#define EVT_UNKNOWN     0x04

/* ---- Write buffer ---- */

typedef struct {
    uint8_t *data;
    size_t len, cap;
} wbuf;

void wbuf_init(wbuf *w);
void wbuf_free(wbuf *w);
void wbuf_reset(wbuf *w);

void wbuf_u8(wbuf *w, uint8_t v);
void wbuf_u16(wbuf *w, uint16_t v);
void wbuf_u32(wbuf *w, uint32_t v);
void wbuf_f64(wbuf *w, double v);
void wbuf_str(wbuf *w, const char *s);                     /* [2:len][data] */
void wbuf_bytes(wbuf *w, const void *data, uint32_t len);  /* [4:len][data] */
void wbuf_raw(wbuf *w, const void *data, size_t len);      /* raw append */

/* ---- Read buffer ---- */

typedef struct {
    const uint8_t *data;
    size_t len, pos;
} rbuf;

void     rbuf_init(rbuf *r, const uint8_t *data, size_t len);
uint8_t  rbuf_u8(rbuf *r);
uint16_t rbuf_u16(rbuf *r);
uint32_t rbuf_u32(rbuf *r);
double   rbuf_f64(rbuf *r);

/* Returns pointer into buffer (not null-terminated). Sets *out_len. */
const char *rbuf_str(rbuf *r, uint16_t *out_len);

/* Returns a null-terminated malloc'd copy. Caller must free(). */
char *rbuf_strdup(rbuf *r);

#endif
