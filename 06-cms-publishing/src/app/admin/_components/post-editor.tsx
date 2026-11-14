"use client";

import { useState, type FormEvent } from "react";
import { saveRevision } from "@/actions/posts";
import { ErrorMessage } from "./error-message";
import { useActionRunner } from "./use-action";

type Content = { title: string; excerpt: string; body: string; coverMediaId: string | null };

type Props = {
  postId: string;
  expectedVersion: number;
  initial: Content;
  coverOptions: Array<{ id: string; label: string }>;
  readOnly: boolean;
};

export function PostEditor({ postId, expectedVersion, initial, coverOptions, readOnly }: Props) {
  const { run, error, pending } = useActionRunner();
  const [content, setContent] = useState<Content>(initial);
  const [notice, setNotice] = useState<string | null>(null);

  function update<K extends keyof Content>(key: K, value: Content[K]) {
    setContent((current) => ({ ...current, [key]: value }));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    run(
      () => saveRevision({ postId, expectedVersion, ...content }),
      (saved) =>
        setNotice(
          saved.created ? `Saved revision ${saved.revisionNumber}.` : "No changes to save.",
        ),
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <label>
        Title
        <input
          value={content.title}
          maxLength={200}
          onChange={(e) => update("title", e.target.value)}
          disabled={readOnly}
          required
        />
      </label>
      <label>
        Excerpt
        <input
          value={content.excerpt}
          maxLength={500}
          onChange={(e) => update("excerpt", e.target.value)}
          disabled={readOnly}
        />
      </label>
      <label>
        Cover image
        <select
          value={content.coverMediaId ?? ""}
          onChange={(e) => update("coverMediaId", e.target.value || null)}
          disabled={readOnly}
        >
          <option value="">None</option>
          {coverOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Body (Markdown; reference uploads as media:&lt;id&gt;)
        <textarea
          value={content.body}
          maxLength={200_000}
          onChange={(e) => update("body", e.target.value)}
          disabled={readOnly}
        />
      </label>
      <ErrorMessage error={error} />
      {notice && <p className="muted">{notice}</p>}
      {!readOnly && (
        <button type="submit" disabled={pending}>
          Save revision
        </button>
      )}
    </form>
  );
}
