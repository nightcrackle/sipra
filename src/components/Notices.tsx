import { useEffect } from 'react';

import { CloseIcon, WarningIcon } from './Icons';
import { useStore } from '../state/store';

/** Informational notices clear themselves; problems wait to be read. */
const AUTO_DISMISS_MS = 7000;

export function Notices(): JSX.Element | null {
  const notices = useStore((state) => state.notices);
  const dismiss = useStore((state) => state.dismissNotice);

  useEffect(() => {
    const timers = notices
      .filter((notice) => notice.level === 'info')
      .map((notice) => setTimeout(() => dismiss(notice.id), AUTO_DISMISS_MS));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [notices, dismiss]);

  if (notices.length === 0) return null;

  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice notice--${notice.level}`}>
          {notice.level !== 'info' ? <WarningIcon size={15} /> : null}
          <div className="grow">
            <p className="notice__title">{notice.title}</p>
            <p className="notice__body">{notice.message}</p>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--sm"
            onClick={() => dismiss(notice.id)}
            aria-label="Dismiss"
          >
            <CloseIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default Notices;
