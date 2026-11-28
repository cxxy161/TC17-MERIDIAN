import { useEffect, useState } from 'react';

export const PORTRAIT_MEDIA_QUERY =
  '(max-width: 767px), ((orientation: portrait) and (max-width: 1024px))';

export function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia(PORTRAIT_MEDIA_QUERY).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(PORTRAIT_MEDIA_QUERY);
    const update = () => setPortrait(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return portrait;
}
