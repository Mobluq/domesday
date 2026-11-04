/**
 * DMS-086: every report has a verification code. Anyone with the code can confirm the
 * report is genuine and unchanged without seeing its contents.
 *
 * The code is the first 60 bits of the SHA-256 digest of the report's text, written in
 * Crockford base32 (no I, L, O or U, so it reads aloud and types cleanly) as three
 * groups of four: "7F3A K29Q 0C4E". Hashing happens in the caller (WebCrypto or the
 * server), so this package stays free of input and output.
 */

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const VERIFICATION_CODE_LENGTH = 12;

/** The first `chars` base32 characters of `bytes`, most significant bit first. */
export function crockfordBase32(bytes: Uint8Array, chars: number): string {
  if (!Number.isInteger(chars) || chars < 1) throw new RangeError('chars must be a whole number of 1 or more');
  if (bytes.length * 8 < chars * 5) throw new RangeError('not enough bytes for that many characters');
  let out = '';
  for (let i = 0; i < chars; i += 1) {
    let value = 0;
    for (let b = 0; b < 5; b += 1) {
      const bit = i * 5 + b;
      const byte = bytes[bit >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
    }
    out += CROCKFORD_ALPHABET[value];
  }
  return out;
}

/** "7F3AK29Q0C4E" as "7F3A K29Q 0C4E". */
export function formatVerificationCode(code: string): string {
  return code.match(/.{1,4}/g)?.join(' ') ?? code;
}

/** The verification code for a SHA-256 digest, unformatted. */
export function verificationCodeFromDigest(digest: Uint8Array): string {
  if (digest.length !== 32) throw new RangeError('expected a 32-byte SHA-256 digest');
  return crockfordBase32(digest, VERIFICATION_CODE_LENGTH);
}

/**
 * Read a code as a person typed it: any case, spaces or hyphens, and the letters people
 * confuse with digits (O for 0, I and L for 1). Returns null when it cannot be a code.
 */
export function normaliseVerificationCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== VERIFICATION_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CROCKFORD_ALPHABET.includes(ch)) return null;
  return cleaned;
}

/** Collapse whitespace so the same words always hash the same, whatever the layout. */
export function canonicalReportText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}
