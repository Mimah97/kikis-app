import { describe, expect, it } from 'vitest';
import { canonicalEncodeStrings, commitAllowlist } from '../proof';

describe('canonicalEncodeStrings', () => {
  it('encodes count and length-prefixed elements', () => {
    const encoded = canonicalEncodeStrings(['ab', 'c']);
    // u32 count = 2, u32 len = 2, 'ab', u32 len = 1, 'c'
    expect(Array.from(encoded)).toEqual([
      0, 0, 0, 2,
      0, 0, 0, 2, 0x61, 0x62,
      0, 0, 0, 1, 0x63,
    ]);
  });

  it('distinguishes lists that would collide under comma joining', () => {
    const a = canonicalEncodeStrings(['a,b', 'c']);
    const b = canonicalEncodeStrings(['a', 'b,c']);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('commitAllowlist', () => {
  const secret = 'witness-secret';

  it('is deterministic regardless of input order', () => {
    const first = commitAllowlist(['alice', 'bob', 'carol'], secret);
    const second = commitAllowlist(['carol', 'alice', 'bob'], secret);
    expect(first).toBe(second);
  });

  it('is immune to delimiter injection', () => {
    const injected = commitAllowlist(['alice,bob', 'carol'], secret);
    const split = commitAllowlist(['alice', 'bob', 'carol'], secret);
    expect(injected).not.toBe(split);
  });

  it('is immune to ambiguous-prefix collisions', () => {
    const a = commitAllowlist(['ab', 'c'], secret);
    const b = commitAllowlist(['a', 'bc'], secret);
    expect(a).not.toBe(b);
  });

  it('binds the witness secret', () => {
    const a = commitAllowlist(['alice'], 'secret-a');
    const b = commitAllowlist(['alice'], 'secret-b');
    expect(a).not.toBe(b);
  });
});
