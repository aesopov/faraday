#include "proto.h"
#include <stdlib.h>
#include <string.h>

/* ---- Write buffer ---- */

void wbuf_init(wbuf *w) { w->data = NULL; w->len = 0; w->cap = 0; }
void wbuf_free(wbuf *w) { free(w->data); w->data = NULL; w->len = 0; w->cap = 0; }
void wbuf_reset(wbuf *w) { w->len = 0; }

static void wbuf_grow(wbuf *w, size_t need) {
    if (w->len + need <= w->cap) return;
    size_t cap = w->cap ? w->cap * 2 : 256;
    while (cap < w->len + need) cap *= 2;
    w->data = realloc(w->data, cap);
    w->cap = cap;
}

void wbuf_u8(wbuf *w, uint8_t v) {
    wbuf_grow(w, 1);
    w->data[w->len++] = v;
}

void wbuf_u16(wbuf *w, uint16_t v) {
    wbuf_grow(w, 2);
    w->data[w->len++] = (uint8_t)(v & 0xFF);
    w->data[w->len++] = (uint8_t)(v >> 8);
}

void wbuf_u32(wbuf *w, uint32_t v) {
    wbuf_grow(w, 4);
    w->data[w->len++] = (uint8_t)(v & 0xFF);
    w->data[w->len++] = (uint8_t)((v >> 8) & 0xFF);
    w->data[w->len++] = (uint8_t)((v >> 16) & 0xFF);
    w->data[w->len++] = (uint8_t)(v >> 24);
}

void wbuf_f64(wbuf *w, double v) {
    wbuf_grow(w, 8);
    memcpy(w->data + w->len, &v, 8);
    w->len += 8;
}

void wbuf_str(wbuf *w, const char *s) {
    uint16_t slen = (uint16_t)strlen(s);
    wbuf_u16(w, slen);
    wbuf_grow(w, slen);
    memcpy(w->data + w->len, s, slen);
    w->len += slen;
}

void wbuf_bytes(wbuf *w, const void *data, uint32_t len) {
    wbuf_u32(w, len);
    wbuf_grow(w, len);
    memcpy(w->data + w->len, data, len);
    w->len += len;
}

void wbuf_raw(wbuf *w, const void *data, size_t len) {
    wbuf_grow(w, len);
    memcpy(w->data + w->len, data, len);
    w->len += len;
}

/* ---- Read buffer ---- */

void rbuf_init(rbuf *r, const uint8_t *data, size_t len) {
    r->data = data;
    r->len = len;
    r->pos = 0;
}

uint8_t rbuf_u8(rbuf *r) {
    if (r->pos >= r->len) return 0;
    return r->data[r->pos++];
}

uint16_t rbuf_u16(rbuf *r) {
    if (r->pos + 2 > r->len) return 0;
    uint16_t v = (uint16_t)r->data[r->pos] | ((uint16_t)r->data[r->pos + 1] << 8);
    r->pos += 2;
    return v;
}

uint32_t rbuf_u32(rbuf *r) {
    if (r->pos + 4 > r->len) return 0;
    uint32_t v = (uint32_t)r->data[r->pos]
               | ((uint32_t)r->data[r->pos + 1] << 8)
               | ((uint32_t)r->data[r->pos + 2] << 16)
               | ((uint32_t)r->data[r->pos + 3] << 24);
    r->pos += 4;
    return v;
}

double rbuf_f64(rbuf *r) {
    if (r->pos + 8 > r->len) return 0;
    double v;
    memcpy(&v, r->data + r->pos, 8);
    r->pos += 8;
    return v;
}

const char *rbuf_str(rbuf *r, uint16_t *out_len) {
    uint16_t slen = rbuf_u16(r);
    if (out_len) *out_len = slen;
    if (r->pos + slen > r->len) return NULL;
    const char *s = (const char *)(r->data + r->pos);
    r->pos += slen;
    return s;
}

char *rbuf_strdup(rbuf *r) {
    uint16_t slen = rbuf_u16(r);
    if (r->pos + slen > r->len) return NULL;
    char *s = malloc(slen + 1);
    if (!s) return NULL;
    memcpy(s, r->data + r->pos, slen);
    s[slen] = '\0';
    r->pos += slen;
    return s;
}
