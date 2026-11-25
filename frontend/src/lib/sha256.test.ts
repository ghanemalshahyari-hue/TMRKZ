import { describe, expect, it } from 'vitest';
import { sha256Bytes } from './sha256';

const enc = (s: string) => new TextEncoder().encode(s);

describe('sha256Bytes (ADR-104: the Update Center over plain http, without crypto.subtle)', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Bytes(enc(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Bytes(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Bytes(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('handles Arabic text and block boundaries', () => {
    expect(sha256Bytes(enc('تمركز'))).toHaveLength(64);
    for (const n of [55, 56, 63, 64, 65, 119, 120, 1000]) {
      expect(sha256Bytes(new Uint8Array(n).fill(97))).toHaveLength(64);
    }
    expect(sha256Bytes(new Uint8Array(1000000).fill(97))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
});
