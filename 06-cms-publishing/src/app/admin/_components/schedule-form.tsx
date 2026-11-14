"use client";

import { useState, type FormEvent } from "react";
import { schedulePost } from "@/actions/workflow";
import { ErrorMessage } from "./error-message";
import { useActionRunner } from "./use-action";

type Props = { postId: string; revisionId: string; expectedVersion: number; label?: string };

export function ScheduleForm({ postId, revisionId, expectedVersion, label = "Schedule" }: Props) {
  const { run, error, setError, pending } = useActionRunner();
  const [when, setWhen] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    // datetime-local is in the browser's zone; send the instant as UTC.
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) {
      setError({ code: "validation_failed", message: "Pick a date and time.", requestId: "" });
      return;
    }
    const scheduledFor = at.toISOString();
    run(() => schedulePost({ postId, revisionId, expectedVersion, scheduledFor }));
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <input
        type="datetime-local"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        required
      />
      <button type="submit" disabled={pending}>
        {label}
      </button>
      <ErrorMessage error={error} />
    </form>
  );
}
