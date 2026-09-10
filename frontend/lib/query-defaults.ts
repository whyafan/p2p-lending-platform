/**
 * Root cause of BUG-VIS (cross-account loan visibility): React Query pauses
 * polling for unfocused tabs by default, which is exactly the two-window
 * setup used to test "does account B see account A's loan". These three
 * options keep every query polling live regardless of window focus — do not
 * relax them without re-verifying the two-account case.
 */
export const REALTIME_QUERY_DEFAULTS = {
  refetchIntervalInBackground: true,
  refetchOnWindowFocus: true,
  staleTime: 0,
  retry: 1,
} as const;
