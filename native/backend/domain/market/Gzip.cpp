#include "Gzip.h"

#include <array>

#include <QByteArray>
#include <vector>

namespace gzip {
namespace {

/** LSB-first bit reader over the compressed stream. */
class BitReader {
public:
    BitReader(const unsigned char *data, qint64 size) : m_data(data), m_size(size) {}

    /** Read `count` bits (count <= 16). Returns false at end of input. */
    bool bits(int count, quint32 *value)
    {
        quint32 result = 0;
        for (int index = 0; index < count; ++index) {
            if (m_bitPos >= 8) {
                if (m_bytePos >= m_size) return false;
                m_current = m_data[m_bytePos++];
                m_bitPos = 0;
            }
            result |= quint32((m_current >> m_bitPos) & 1u) << index;
            ++m_bitPos;
        }
        *value = result;
        return true;
    }

    /** Discard the remaining bits of the current byte (stored blocks are aligned). */
    void alignToByte() { m_bitPos = 8; }

    bool readBytes(unsigned char *out, qint64 count)
    {
        for (qint64 index = 0; index < count; ++index) {
            if (m_bitPos >= 8) {
                if (m_bytePos >= m_size) return false;
                m_current = m_data[m_bytePos++];
                m_bitPos = 0;
            }
            out[index] = static_cast<unsigned char>((m_current >> m_bitPos) & 0xFFu);
            m_bitPos = 8;
        }
        return true;
    }

    qint64 remaining() const { return m_size - m_bytePos; }

private:
    const unsigned char *m_data;
    qint64 m_size;
    qint64 m_bytePos = 0;
    quint32 m_current = 0;
    int m_bitPos = 8;
};

constexpr int kMaxBits = 15;
constexpr int kMaxSymbols = 288;

/**
 * Canonical Huffman decoder.
 *
 * `counts[len]` is the number of codes of that length and `symbols` lists the symbols
 * ordered by (length, symbol). Decoding walks one bit at a time, which is slower than a
 * lookup table but trivially correct and fast enough for a few kilobytes per row.
 */
struct Huffman {
    std::array<int, kMaxBits + 1> counts{};
    std::vector<int> symbols;

    bool build(const std::vector<int> &lengths)
    {
        counts.fill(0);
        for (int length : lengths) {
            if (length < 0 || length > kMaxBits) return false;
            if (length > 0) counts[size_t(length)] += 1;
        }
        if (counts[0] == int(lengths.size())) return true; // no codes at all
        // Reject an over-subscribed set; an incomplete set is legal (one code).
        int left = 1;
        for (int length = 1; length <= kMaxBits; ++length) {
            left <<= 1;
            left -= counts[size_t(length)];
            if (left < 0) return false;
        }
        std::array<int, kMaxBits + 2> offsets{};
        offsets[1] = 0;
        for (int length = 1; length <= kMaxBits; ++length) {
            offsets[size_t(length) + 1] = offsets[size_t(length)] + counts[size_t(length)];
        }
        symbols.assign(lengths.size(), 0);
        for (size_t symbol = 0; symbol < lengths.size(); ++symbol) {
            const int length = lengths[symbol];
            if (length == 0) continue;
            symbols[size_t(offsets[size_t(length)]++)] = int(symbol);
        }
        return true;
    }

    bool decode(BitReader *reader, int *symbol) const
    {
        int code = 0;
        int first = 0;
        int index = 0;
        for (int length = 1; length <= kMaxBits; ++length) {
            quint32 bit = 0;
            if (!reader->bits(1, &bit)) return false;
            code |= int(bit);
            const int count = counts[size_t(length)];
            if (code - first < count) {
                *symbol = symbols[size_t(index + (code - first))];
                return true;
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        return false;
    }
};

const std::array<int, 29> &lengthBase()
{
    static const std::array<int, 29> table = {3,  4,  5,  6,  7,  8,  9,  10, 11, 13,
                                              15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
                                              67, 83, 99, 115, 131, 163, 195, 227, 258};
    return table;
}

const std::array<int, 29> &lengthExtra()
{
    static const std::array<int, 29> table = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2,
                                              2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
    return table;
}

const std::array<int, 30> &distanceBase()
{
    static const std::array<int, 30> table = {1,    2,    3,    4,    5,    7,     9,     13,
                                              17,   25,   33,   49,   65,   97,    129,   193,
                                              257,  385,  513,  769,  1025, 1537,  2049,  3073,
                                              4097, 6145, 8193, 12289, 16385, 24577};
    return table;
}

const std::array<int, 30> &distanceExtra()
{
    static const std::array<int, 30> table = {0, 0, 0, 0, 1, 1, 2, 2,  3,  3,  4,  4,  5,  5,  6,
                                              6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13};
    return table;
}

bool inflateBlockData(BitReader *reader, const Huffman &literal, const Huffman &distance,
                      QByteArray *output, qint64 maxBytes)
{
    while (true) {
        int symbol = 0;
        if (!literal.decode(reader, &symbol)) return false;
        if (symbol < 256) {
            if (output->size() >= maxBytes) return false;
            output->append(char(symbol));
            continue;
        }
        if (symbol == 256) return true;
        const int lengthIndex = symbol - 257;
        if (lengthIndex < 0 || lengthIndex >= int(lengthBase().size())) return false;
        quint32 extra = 0;
        if (!reader->bits(lengthExtra()[size_t(lengthIndex)], &extra)) return false;
        const int length = lengthBase()[size_t(lengthIndex)] + int(extra);

        int distanceSymbol = 0;
        if (!distance.decode(reader, &distanceSymbol)) return false;
        if (distanceSymbol < 0 || distanceSymbol >= int(distanceBase().size())) return false;
        if (!reader->bits(distanceExtra()[size_t(distanceSymbol)], &extra)) return false;
        const int distanceValue = distanceBase()[size_t(distanceSymbol)] + int(extra);
        if (distanceValue <= 0 || distanceValue > output->size()) return false;
        if (output->size() + length > maxBytes) return false;
        const qint64 start = output->size() - distanceValue;
        for (int index = 0; index < length; ++index) {
            output->append(output->at(qsizetype(start + index)));
        }
    }
}

bool buildFixed(Huffman *literal, Huffman *distance)
{
    std::vector<int> literalLengths(288, 0);
    for (int symbol = 0; symbol < 144; ++symbol) literalLengths[size_t(symbol)] = 8;
    for (int symbol = 144; symbol < 256; ++symbol) literalLengths[size_t(symbol)] = 9;
    for (int symbol = 256; symbol < 280; ++symbol) literalLengths[size_t(symbol)] = 7;
    for (int symbol = 280; symbol < 288; ++symbol) literalLengths[size_t(symbol)] = 8;
    std::vector<int> distanceLengths(30, 5);
    return literal->build(literalLengths) && distance->build(distanceLengths);
}

bool buildDynamic(BitReader *reader, Huffman *literal, Huffman *distance)
{
    quint32 hlit = 0;
    quint32 hdist = 0;
    quint32 hclen = 0;
    if (!reader->bits(5, &hlit) || !reader->bits(5, &hdist) || !reader->bits(4, &hclen)) return false;
    const int literalCount = int(hlit) + 257;
    const int distanceCount = int(hdist) + 1;
    const int codeCount = int(hclen) + 4;
    if (literalCount > 286 || distanceCount > 30) return false;

    static const std::array<int, 19> kOrder = {16, 17, 18, 0, 8,  7, 9,  6, 10, 5,
                                               11, 4,  12, 3, 13, 2, 14, 1, 15};
    std::vector<int> codeLengths(19, 0);
    for (int index = 0; index < codeCount; ++index) {
        quint32 value = 0;
        if (!reader->bits(3, &value)) return false;
        codeLengths[size_t(kOrder[size_t(index)])] = int(value);
    }
    Huffman codeHuffman;
    if (!codeHuffman.build(codeLengths)) return false;

    std::vector<int> lengths;
    lengths.reserve(size_t(literalCount + distanceCount));
    while (int(lengths.size()) < literalCount + distanceCount) {
        int symbol = 0;
        if (!codeHuffman.decode(reader, &symbol)) return false;
        if (symbol < 16) {
            lengths.push_back(symbol);
            continue;
        }
        int repeat = 0;
        int value = 0;
        if (symbol == 16) {
            if (lengths.empty()) return false;
            quint32 extra = 0;
            if (!reader->bits(2, &extra)) return false;
            repeat = 3 + int(extra);
            value = lengths.back();
        } else if (symbol == 17) {
            quint32 extra = 0;
            if (!reader->bits(3, &extra)) return false;
            repeat = 3 + int(extra);
        } else if (symbol == 18) {
            quint32 extra = 0;
            if (!reader->bits(7, &extra)) return false;
            repeat = 11 + int(extra);
        } else {
            return false;
        }
        if (int(lengths.size()) + repeat > literalCount + distanceCount) return false;
        for (int index = 0; index < repeat; ++index) lengths.push_back(value);
    }

    std::vector<int> literalLengths(lengths.begin(), lengths.begin() + literalCount);
    std::vector<int> distanceLengths(lengths.begin() + literalCount, lengths.end());
    // A single distance code of length 0 is legal for a block with no matches.
    if (distanceLengths.size() == 1 && distanceLengths[0] == 0) distanceLengths[0] = 1;
    return literal->build(literalLengths) && distance->build(distanceLengths);
}

quint32 crc32(const QByteArray &data)
{
    static std::array<quint32, 256> table = [] {
        std::array<quint32, 256> values{};
        for (quint32 index = 0; index < 256; ++index) {
            quint32 value = index;
            for (int bit = 0; bit < 8; ++bit) {
                value = (value & 1u) ? (0xEDB88320u ^ (value >> 1)) : (value >> 1);
            }
            values[index] = value;
        }
        return values;
    }();
    quint32 value = 0xFFFFFFFFu;
    for (char byte : data) {
        value = table[(value ^ quint32(static_cast<unsigned char>(byte))) & 0xFFu] ^ (value >> 8);
    }
    return value ^ 0xFFFFFFFFu;
}

} // namespace

bool gunzip(const QByteArray &input, QByteArray *output, qint64 maxBytes)
{
    if (output == nullptr) return false;
    const auto *data = reinterpret_cast<const unsigned char *>(input.constData());
    const qint64 size = input.size();
    if (size < 18) return false;
    // Fixed header: magic, method, flags, mtime, extra flags, OS.
    if (data[0] != 0x1F || data[1] != 0x8B || data[2] != 0x08) return false;
    const int flags = data[3];
    if (flags & 0xE0) return false; // reserved bits must be zero
    qint64 offset = 10;
    if (flags & 0x04) { // FEXTRA
        if (offset + 2 > size) return false;
        const int extraLength = data[offset] | (data[offset + 1] << 8);
        offset += 2 + extraLength;
    }
    if (flags & 0x08) { // FNAME
        while (offset < size && data[offset] != 0) ++offset;
        ++offset;
    }
    if (flags & 0x10) { // FCOMMENT
        while (offset < size && data[offset] != 0) ++offset;
        ++offset;
    }
    if (flags & 0x02) offset += 2; // FHCRC
    if (offset >= size) return false;

    // The trailer is CRC32 + ISIZE and is not part of the DEFLATE stream.
    const qint64 trailerStart = size - 8;
    if (trailerStart <= offset) return false;

    BitReader reader(data + offset, trailerStart - offset);
    QByteArray inflated;
    bool final = false;
    while (!final) {
        quint32 finalBit = 0;
        quint32 type = 0;
        if (!reader.bits(1, &finalBit) || !reader.bits(2, &type)) return false;
        final = finalBit != 0;
        if (type == 0) {
            reader.alignToByte();
            unsigned char header[4];
            if (!reader.readBytes(header, 4)) return false;
            const int length = header[0] | (header[1] << 8);
            const int complement = header[2] | (header[3] << 8);
            if ((length ^ 0xFFFF) != complement) return false;
            if (inflated.size() + length > maxBytes) return false;
            QByteArray raw(length, Qt::Uninitialized);
            if (!reader.readBytes(reinterpret_cast<unsigned char *>(raw.data()), length)) return false;
            inflated.append(raw);
            continue;
        }
        Huffman literal;
        Huffman distance;
        if (type == 1) {
            if (!buildFixed(&literal, &distance)) return false;
        } else if (type == 2) {
            if (!buildDynamic(&reader, &literal, &distance)) return false;
        } else {
            return false;
        }
        if (!inflateBlockData(&reader, literal, distance, &inflated, maxBytes)) return false;
    }

    // CRC32 and ISIZE must match, otherwise the row is corrupt and the caller falls
    // back to the raw bytes exactly like the oracle's try/catch does.
    const auto *trailer = reinterpret_cast<const unsigned char *>(input.constData()) + trailerStart;
    const quint32 expectedCrc = quint32(trailer[0]) | (quint32(trailer[1]) << 8)
        | (quint32(trailer[2]) << 16) | (quint32(trailer[3]) << 24);
    const quint32 expectedSize = quint32(trailer[4]) | (quint32(trailer[5]) << 8)
        | (quint32(trailer[6]) << 16) | (quint32(trailer[7]) << 24);
    if (crc32(inflated) != expectedCrc) return false;
    if ((quint32(inflated.size()) & 0xFFFFFFFFu) != expectedSize) return false;
    *output = inflated;
    return true;
}

bool gzipCompress(const QByteArray &input, QByteArray *output)
{
    if (output == nullptr) return false;
    // qCompress emits a 4-byte size prefix followed by a zlib stream. Stripping the
    // 2-byte zlib header and the 4-byte Adler-32 trailer leaves the raw DEFLATE payload
    // that the gzip container expects.
    const QByteArray compressed = qCompress(input, 6);
    if (compressed.size() < 10) return false;
    const QByteArray deflate = compressed.mid(6, compressed.size() - 10);

    QByteArray result;
    result.append(char(0x1F));
    result.append(char(0x8B));
    result.append(char(0x08)); // deflate
    result.append(char(0x00)); // no flags
    result.append(QByteArray(4, '\0')); // mtime
    result.append(char(0x00)); // XFL
    result.append(char(0xFF)); // OS: unknown
    result.append(deflate);
    const quint32 checksum = crc32(input);
    const quint32 length = quint32(input.size());
    for (int shift = 0; shift < 32; shift += 8) result.append(char((checksum >> shift) & 0xFFu));
    for (int shift = 0; shift < 32; shift += 8) result.append(char((length >> shift) & 0xFFu));
    *output = result;
    return true;
}

} // namespace gzip
