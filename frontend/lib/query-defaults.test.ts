import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REALTIME_QUERY_DEFAULTS } from './query-defaults.ts';

// Regression check for BUG-VIS: cross-account loan visibility silently broke
// because React Query pauses polling for a backgrounded tab by default, and
// checking "does account B see account A's loan" always involves a second,
// backgrounded browser window. If any of these flip back to their React
// Query defaults, that regression comes back.
describe('REALTIME_QUERY_DEFAULTS (BUG-VIS regression guard)', () => {
  it('keeps polling while the tab is unfocused/backgrounded', () => {
    assert.equal(REALTIME_QUERY_DEFAULTS.refetchIntervalInBackground, true);
  });

  it('refetches immediately when a tab regains focus', () => {
    assert.equal(REALTIME_QUERY_DEFAULTS.refetchOnWindowFocus, true);
  });

  it('never treats cached loan data as fresh', () => {
    assert.equal(REALTIME_QUERY_DEFAULTS.staleTime, 0);
  });
});
