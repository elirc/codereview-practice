"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { ErrorBody } from "@/http/errors";
import { ErrorMessage } from "./error-message";

const UPLOAD_FAILED: ErrorBody = {
  code: "internal_error",
  message: "Upload failed.",
  requestId: "",
};

export function MediaUpload() {
  const router = useRouter();
  const [error, setError] = useState<ErrorBody | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError(null);
    setPending(true);
    try {
      const response = await fetch("/api/media", { method: "POST", body: new FormData(form) });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: ErrorBody } | null;
        setError(body?.error ?? UPLOAD_FAILED);
        return;
      }
      form.reset();
      router.refresh();
    } catch {
      setError(UPLOAD_FAILED);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <input
        type="file"
        name="file"
        accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
        required
      />
      <button type="submit" disabled={pending}>
        Upload
      </button>
      <ErrorMessage error={error} />
    </form>
  );
}
