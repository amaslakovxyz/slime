import type { Status } from '@/lib/endpoints';

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`badge badge-${status}`}>
      <i className="badge-dot" aria-hidden="true" />
      {status}
    </span>
  );
}
