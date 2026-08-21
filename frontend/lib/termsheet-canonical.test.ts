import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, termSheetHash } from './termsheet-canonical.ts';

describe('canonicalize', () => {
  it('is independent of key insertion order', () => {
    assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  });

  it('sorts keys recursively and emits no whitespace', () => {
    assert.equal(
      canonicalize({ z: { b: 1, a: [1, 'x'] }, a: true }),
      '{"a":true,"z":{"a":[1,"x"],"b":1}}',
    );
  });

  it('serializes bigints as decimal strings', () => {
    assert.equal(canonicalize({ wei: 1000000000000000000n }), '{"wei":"1000000000000000000"}');
  });

  it('preserves array order (arrays are positional, not sorted)', () => {
    assert.equal(canonicalize([2, 1]), '[2,1]');
  });

  it('drops undefined object values like JSON.stringify does', () => {
    assert.equal(canonicalize({ a: 1, gone: undefined }), '{"a":1}');
  });
});

describe('termSheetHash', () => {
  it('returns a 32-byte hex hash', () => {
    assert.match(termSheetHash({ a: 1 }), /^0x[0-9a-f]{64}$/);
  });

  it('is stable for equivalent objects and changes when a field changes', () => {
    assert.equal(termSheetHash({ a: 1, b: 2 }), termSheetHash({ b: 2, a: 1 }));
    assert.notEqual(termSheetHash({ a: 1 }), termSheetHash({ a: 2 }));
  });
});
