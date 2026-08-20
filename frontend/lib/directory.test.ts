import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSearchQuery,
  buildLikePattern,
  normalizeWalletAddressParam,
  shapeDirectoryProfile,
  mergeSearchResults,
  type PublicProfileRow,
} from './directory.ts';

describe('normalizeSearchQuery', () => {
  it('returns null for null input', () => {
    assert.equal(normalizeSearchQuery(null), null);
  });
  it('returns null for empty string', () => {
    assert.equal(normalizeSearchQuery(''), null);
  });
  it('returns null for a single trimmed character', () => {
    assert.equal(normalizeSearchQuery(' a '), null);
  });
  it('trims and returns strings of 2+ characters', () => {
    assert.equal(normalizeSearchQuery('  ali  '), 'ali');
  });
  it('returns null when trimming drops the length below 2 characters', () => {
    assert.equal(normalizeSearchQuery(' a  '), null);
  });
});

describe('buildLikePattern', () => {
  it('wraps the query in wildcards', () => {
    assert.equal(buildLikePattern('ali'), '%ali%');
  });
  it('escapes literal percent signs', () => {
    assert.equal(buildLikePattern('50%'), '%50\\%%');
  });
  it('escapes literal underscores', () => {
    assert.equal(buildLikePattern('a_b'), '%a\\_b%');
  });
  it('escapes literal backslashes', () => {
    assert.equal(buildLikePattern('a\\b'), '%a\\\\b%');
  });
  it('escapes literal asterisks, which PostgREST otherwise treats as an alias for %', () => {
    // PostgREST substitutes every unescaped '*' in a like/ilike value for '%'
    // before it reaches Postgres, so an unescaped '**' search would become
    // the match-everything pattern '%%%%%'. Escaped, each '*' survives
    // PostgREST's substitution as '\%' (a literal-percent match), not as a
    // wildcard - it no longer matches everything.
    assert.equal(buildLikePattern('**'), '%\\*\\*%');
  });
});

describe('normalizeWalletAddressParam', () => {
  it('lowercases a valid mixed-case address', () => {
    assert.equal(
      normalizeWalletAddressParam('0xAbC123000000000000000000000000000000dEaD'),
      '0xabc123000000000000000000000000000000dead',
    );
  });
  it('rejects a value missing the 0x prefix', () => {
    assert.equal(normalizeWalletAddressParam('abc123000000000000000000000000000000dead'), null);
  });
  it('rejects a value of the wrong length', () => {
    assert.equal(normalizeWalletAddressParam('0xabc123'), null);
  });
  it('rejects non-hex characters', () => {
    assert.equal(normalizeWalletAddressParam('0xzzz123000000000000000000000000000000dead'), null);
  });
  it('rejects an address with too few hex characters', () => {
    assert.equal(normalizeWalletAddressParam('0x123456789abcdef'), null);
  });
  it('rejects an address with too many hex characters', () => {
    assert.equal(normalizeWalletAddressParam('0x123456789abcdef0123456789abcdef0123456789'), null);
  });
});

describe('shapeDirectoryProfile', () => {
  it('converts a snake_case row to camelCase', () => {
    const row: PublicProfileRow = {
      id: 'user-1',
      display_name: 'Alice',
      kyc_status: 'APPROVED',
      user_role: 'borrower',
      wallet_address: '0xabc123000000000000000000000000000000dead',
    };
    assert.deepEqual(shapeDirectoryProfile(row), {
      id: 'user-1',
      displayName: 'Alice',
      kycStatus: 'APPROVED',
      userRole: 'borrower',
      walletAddress: '0xabc123000000000000000000000000000000dead',
    });
  });
  it('passes through a null display name and null role', () => {
    const row: PublicProfileRow = {
      id: 'user-2',
      display_name: null,
      kyc_status: 'NOT_STARTED',
      user_role: null,
      wallet_address: '0xdead00000000000000000000000000000000beef',
    };
    const shaped = shapeDirectoryProfile(row);
    assert.equal(shaped.displayName, null);
    assert.equal(shaped.userRole, null);
  });
});

describe('mergeSearchResults', () => {
  const alice: PublicProfileRow = {
    id: 'u1', display_name: 'Alice', kyc_status: 'APPROVED', user_role: 'borrower',
    wallet_address: '0x11111111111111111111111111111111111111aa',
  };
  const bob: PublicProfileRow = {
    id: 'u2', display_name: 'Bob', kyc_status: 'APPROVED', user_role: 'lender',
    wallet_address: '0x22222222222222222222222222222222222222bb',
  };

  it('deduplicates a row that matched both queries by id', () => {
    const result = mergeSearchResults([alice], [alice], 20);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'u1');
  });
  it('sorts by display name', () => {
    const result = mergeSearchResults([bob], [alice], 20);
    assert.deepEqual(result.map((r) => r.id), ['u1', 'u2']);
  });
  it('respects the limit after merging', () => {
    const result = mergeSearchResults([bob], [alice], 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'u1');
  });
  it('returns camelCase shapes, not raw rows', () => {
    const result = mergeSearchResults([alice], [], 20);
    assert.equal(result[0].displayName, 'Alice');
  });
  it('sorts null display names before named records', () => {
    const charlie: PublicProfileRow = {
      id: 'u3', display_name: null, kyc_status: 'APPROVED', user_role: 'borrower',
      wallet_address: '0x33333333333333333333333333333333333333cc',
    };
    const result = mergeSearchResults([alice], [charlie], 20);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'u3');
    assert.equal(result[0].displayName, null);
    assert.equal(result[1].id, 'u1');
  });
});
