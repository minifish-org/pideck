import { useEffect, useState } from 'react';
import { Icon } from './Icons';

export function RunClock({ startedAt, endedAt }: { startedAt: number; endedAt?: number }) {
  const [now, setNow] = useState(() => endedAt ?? Date.now());
  useEffect(() => {
    if (endedAt !== undefined) return;
    const update = () => setNow(Date.now());
    const visible = () => { if (document.visibilityState === 'visible') update(); };
    update();
    const interval = window.setInterval(update, 1_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [startedAt, endedAt]);

  const seconds = Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = String(Math.floor(seconds % 3_600 / 60)).padStart(2, '0');
  const elapsed = `${hours ? `${hours}:` : ''}${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  return <span className="run-clock" role="timer" aria-label="Elapsed time" aria-live="off"
    data-started-at={startedAt} data-ended-at={endedAt} title="Elapsed time">
    <Icon name="timer" width={13} height={13} /><span>{elapsed}</span>
  </span>;
}
