'use client';

import { useEffect, useState } from 'react';

/** True after the component has mounted (avoids SSR/client text mismatches). */
export function useHydrated() {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  return hydrated;
}
