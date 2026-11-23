#pragma once

#include <QByteArray>

/**
 * Minimal gzip (RFC 1952) decompressor.
 *
 * The bundled `resources/xueprompts.db` stores each prompt body and description as a
 * gzip-compressed BLOB, and the Node oracle inflates them with `zlib.gunzipSync`. Qt
 * only exposes `qUncompress`, which understands the *zlib* wrapper (and validates an
 * Adler-32 that a gzip stream does not carry), so the raw DEFLATE decoder lives here
 * instead of adding a zlib dependency to the backend.
 *
 * Scope is deliberately small: one member per block type (stored, fixed Huffman,
 * dynamic Huffman), 32 KiB window, hard output cap. It is not a general-purpose
 * library and it is not used for anything but the prompt catalogue.
 */
namespace gzip {

/**
 * Inflate a gzip stream.
 *
 * Returns false for a malformed stream, a truncated stream, a CRC/length mismatch or an
 * output larger than `maxBytes`. The caller then falls back to reading the BLOB as
 * UTF-8, which is what the oracle does when `gunzipSync` throws (legacy rows were
 * written uncompressed).
 */
bool gunzip(const QByteArray &input, QByteArray *output, qint64 maxBytes = 8 * 1024 * 1024);

/**
 * Produce a real gzip stream.
 *
 * Used by the RPC log rotation: the previous implementation wrote `.jsonl.gz` files
 * that any gzip reader (including this one and the Node oracle) must be able to open, so
 * the deflate payload is wrapped with the gzip header and the CRC32/ISIZE trailer rather
 * than left in Qt's private `qCompress` envelope.
 */
bool gzipCompress(const QByteArray &input, QByteArray *output);

} // namespace gzip
