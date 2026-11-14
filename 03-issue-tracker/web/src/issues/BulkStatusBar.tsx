import { useState } from 'react';
import { STATUSES, type IssueFilters, type IssueStatus } from '../api/types';
import { useBulkStatus } from './useBulkStatus';

interface Props {
  orgSlug: string;
  filters: IssueFilters;
  issueIds: string[];
  onDone: () => void;
}

export function BulkStatusBar({ orgSlug, filters, issueIds, onDone }: Props) {
  const bulk = useBulkStatus(orgSlug, filters);
  const [status, setStatus] = useState<IssueStatus>('done');

  if (issueIds.length === 0) return null;

  return (
    <div className="inline">
      <span>{issueIds.length} selected</span>
      <select
        aria-label="Bulk status"
        value={status}
        onChange={(e) => setStatus(e.target.value as IssueStatus)}
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={bulk.isPending}
        onClick={() => bulk.mutate({ issueIds, status }, { onSuccess: onDone })}
      >
        Set status
      </button>
      {bulk.error && <span className="error">{bulk.error.message}</span>}
    </div>
  );
}
