import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import { PRIORITY_LABELS, STATUSES, type IssueDetail, type IssueStatus } from '../api/types';
import { useMe } from '../auth/session';
import { CommentsSection } from '../issues/CommentsSection';
import { useIssueMutation } from '../issues/useIssueMutation';
import {
  atLeast,
  useLabels,
  useMemberOptions,
  useMemberSearch,
  useProjects,
  useRole,
} from '../org/queries';

export function IssueDetailPage() {
  const { orgSlug = '', projectKey = '', number = '' } = useParams();
  const issueNumber = Number(number);
  const issue = useQuery({
    queryKey: queryKeys.issue(orgSlug, projectKey, issueNumber),
    queryFn: () => endpoints.getIssue(orgSlug, projectKey, issueNumber),
  });

  if (issue.isPending) return <p>Loading…</p>;
  if (issue.error) {
    const missing = issue.error instanceof ApiError && issue.error.status === 404;
    return <p className="error">{missing ? 'Issue not found.' : issue.error.message}</p>;
  }
  return <IssueEditor orgSlug={orgSlug} issue={issue.data} />;
}

function IssueEditor({ orgSlug, issue }: { orgSlug: string; issue: IssueDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe();
  const role = useRole(orgSlug);
  const projects = useProjects(orgSlug);
  const labels = useLabels(orgSlug);
  const members = useMemberOptions(orgSlug);
  const [memberQuery, setMemberQuery] = useState('');
  const matches = useMemberSearch(orgSlug, memberQuery.trim());
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description);
  const [moveTo, setMoveTo] = useState('');

  useEffect(() => setTitle(issue.title), [issue.title]);
  useEffect(() => setDescription(issue.description), [issue.description]);

  const mutation = useIssueMutation(orgSlug, issue, {
    onConflict: () =>
      setNotice('This issue was changed by someone else. You are now seeing the latest version.'),
  });
  const remove = useMutation({
    mutationFn: () => endpoints.deleteIssue(orgSlug, issue.projectKey, issue.number),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issueLists(orgSlug) });
      navigate(`/o/${orgSlug}/issues`);
    },
  });

  const project = projects.data?.find((p) => p.key === issue.projectKey);
  const archived = !!project?.archivedAt;
  const canEdit = atLeast(role, 'member') && !archived;
  const candidates = memberQuery.trim() ? matches.data : members.data;
  const assignable = (candidates ?? [])
    .filter((m) => m.role !== 'viewer')
    .map((m) => ({ id: m.userId, name: m.name }));
  // Keep the current assignee selectable even when the search does not match them.
  if (issue.assignee && !assignable.some((m) => m.id === issue.assignee?.id)) {
    assignable.unshift(issue.assignee);
  }
  const otherProjects = projects.data?.filter((p) => !p.archivedAt && p.key !== issue.projectKey);
  const mutationError =
    mutation.error instanceof ApiError && mutation.error.code === 'version_conflict'
      ? null
      : mutation.error;

  const saveTitle = () => {
    const next = title.trim();
    if (next && next !== issue.title) {
      mutation.mutate({ kind: 'patch', patch: { title: next }, preview: { title: next } });
    }
  };

  const toggleLabel = (labelId: string, checked: boolean) => {
    const ids = new Set(issue.labels.map((l) => l.id));
    if (checked) ids.add(labelId);
    else ids.delete(labelId);
    const next = (labels.data ?? []).filter((l) => ids.has(l.id));
    mutation.mutate({ kind: 'labels', labelIds: [...ids], preview: { labels: next } });
  };

  const move = () => {
    if (!moveTo) return;
    mutation.mutate(
      { kind: 'patch', patch: { projectKey: moveTo }, preview: {} },
      {
        onSuccess: (moved) =>
          navigate(`/o/${orgSlug}/issues/${moved.projectKey}/${moved.number}`),
      },
    );
  };

  return (
    <article>
      <p>
        <Link to={`/o/${orgSlug}/issues`}>← Issues</Link> · {issue.identifier}
        {archived && ' · archived project (read-only)'}
      </p>
      {notice && (
        <p className="notice" role="status">
          {notice}{' '}
          <button type="button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
      {mutationError && <p className="error">{mutationError.message}</p>}

      <input
        aria-label="Title"
        className="title"
        value={title}
        maxLength={200}
        disabled={!canEdit}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => e.key === 'Enter' && saveTitle()}
      />

      <div className="inline">
        <label>
          Status
          <select
            value={issue.status}
            disabled={!canEdit}
            onChange={(e) => {
              const status = e.target.value as IssueStatus;
              mutation.mutate({ kind: 'patch', patch: { status }, preview: { status } });
            }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            value={issue.priority}
            disabled={!canEdit}
            onChange={(e) => {
              const priority = Number(e.target.value);
              mutation.mutate({ kind: 'patch', patch: { priority }, preview: { priority } });
            }}
          >
            {PRIORITY_LABELS.map((label, value) => (
              <option key={label} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assignee
          <select
            value={issue.assignee?.id ?? ''}
            disabled={!canEdit}
            onChange={(e) => {
              const member = assignable.find((m) => m.id === e.target.value);
              mutation.mutate({
                kind: 'patch',
                patch: { assigneeId: member?.id ?? null },
                preview: { assignee: member ?? null },
              });
            }}
          >
            <option value="">Unassigned</option>
            {assignable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <input
            type="search"
            aria-label="Find member"
            placeholder="Find member"
            value={memberQuery}
            disabled={!canEdit}
            onChange={(e) => setMemberQuery(e.target.value)}
          />
        </label>
      </div>

      <fieldset disabled={!canEdit}>
        <legend>Labels</legend>
        {labels.data?.map((label) => (
          <label key={label.id} className="inline">
            <input
              type="checkbox"
              checked={issue.labels.some((l) => l.id === label.id)}
              onChange={(e) => toggleLabel(label.id, e.target.checked)}
            />
            <span className="label-chip" style={{ background: label.color }}>
              {label.name}
            </span>
          </label>
        ))}
      </fieldset>

      <label>
        Description
        <textarea
          rows={8}
          value={description}
          maxLength={20_000}
          disabled={!canEdit}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {canEdit && description !== issue.description && (
        <button
          type="button"
          onClick={() =>
            mutation.mutate({ kind: 'patch', patch: { description }, preview: { description } })
          }
        >
          Save description
        </button>
      )}

      <p>
        Reported by {issue.reporter.name} · created {new Date(issue.createdAt).toLocaleString()} ·
        updated {new Date(issue.updatedAt).toLocaleString()}
      </p>

      {canEdit && otherProjects && otherProjects.length > 0 && (
        <div className="inline">
          <select aria-label="Move to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="">Move to project…</option>
            {otherProjects.map((p) => (
              <option key={p.id} value={p.key}>
                {p.key}
              </option>
            ))}
          </select>
          <button type="button" onClick={move} disabled={!moveTo}>
            Move
          </button>
        </div>
      )}
      {atLeast(role, 'admin') && !archived && (
        <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending}>
          Delete issue
        </button>
      )}
      {remove.error && <p className="error">{remove.error.message}</p>}

      {me.data && (
        <CommentsSection
          orgSlug={orgSlug}
          projectKey={issue.projectKey}
          number={issue.number}
          me={{ id: me.data.user.id, name: me.data.user.name }}
          canComment={canEdit}
          canDeleteAny={atLeast(role, 'admin') && !archived}
        />
      )}
    </article>
  );
}
