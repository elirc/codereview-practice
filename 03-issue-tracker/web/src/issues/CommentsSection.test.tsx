import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import type { Comment, Page } from '../api/types';
import { createTestQueryClient, deferred, wrapperFor } from '../test/utils';
import { CommentsSection } from './CommentsSection';

const ME = { id: 'u-me', name: 'Mia Member' };

const EXISTING: Comment = {
  id: 'c1',
  body: 'I can reproduce this.',
  author: { id: 'u-other', name: 'Tom' },
  createdAt: '2026-03-02T09:00:00.000Z',
  editedAt: null,
};

function renderSection() {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(queryKeys.comments('acme', 'ENG', 1), {
    pages: [{ items: [EXISTING], nextCursor: null }],
    pageParams: [null],
  });
  const Wrapper = wrapperFor(queryClient);
  render(
    <Wrapper>
      <CommentsSection
        orgSlug="acme"
        projectKey="ENG"
        number={1}
        me={ME}
        canComment
        canDeleteAny={false}
      />
    </Wrapper>,
  );
  return queryClient;
}

function typeAndSubmit(text: string) {
  fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
}

describe('CommentsSection', () => {
  it('shows a pending comment immediately and replaces it with the saved one', async () => {
    const saved: Comment = {
      id: 'c2',
      body: 'Fixed in staging.',
      author: ME,
      createdAt: '2026-03-02T10:00:00.000Z',
      editedAt: null,
    };
    const response = deferred<Comment>();
    vi.spyOn(endpoints, 'addComment').mockReturnValue(response.promise);
    vi.spyOn(endpoints, 'listComments').mockResolvedValue({
      items: [EXISTING, saved],
      nextCursor: null,
    } satisfies Page<Comment>);
    renderSection();

    typeAndSubmit('Fixed in staging.');

    await waitFor(() => expect(screen.getAllByTestId('comment')).toHaveLength(2));
    const pending = screen.getAllByTestId('comment')[1];
    expect(pending.className).toBe('pending');
    expect(pending.textContent).toContain('Fixed in staging.');
    expect((screen.getByLabelText('Add a comment') as HTMLTextAreaElement).value).toBe('');

    await act(async () => response.resolve(saved));
    await waitFor(() =>
      expect(screen.getAllByTestId('comment')[1].className).not.toBe('pending'),
    );
    expect(screen.getAllByTestId('comment')).toHaveLength(2);
  });

  it('removes the pending comment and restores the text when posting fails', async () => {
    const response = deferred<Comment>();
    vi.spyOn(endpoints, 'addComment').mockReturnValue(response.promise);
    vi.spyOn(endpoints, 'listComments').mockResolvedValue({ items: [EXISTING], nextCursor: null });
    renderSection();

    typeAndSubmit('This will fail');
    await waitFor(() => expect(screen.getAllByTestId('comment')).toHaveLength(2));

    await act(async () =>
      response.reject(new ApiError(403, 'forbidden', 'You do not have permission to do that.')),
    );

    await waitFor(() => expect(screen.getAllByTestId('comment')).toHaveLength(1));
    expect(screen.getByRole('alert').textContent).toBe('You do not have permission to do that.');
    expect((screen.getByLabelText('Add a comment') as HTMLTextAreaElement).value).toBe(
      'This will fail',
    );
  });
});
