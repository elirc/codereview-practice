"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/actions/result";
import type { ErrorBody } from "@/http/errors";

/** Runs a server action, keeps its error for display and refreshes the page on success. */
export function useActionRunner() {
  const router = useRouter();
  const [error, setError] = useState<ErrorBody | null>(null);
  const [pending, startTransition] = useTransition();

  function run<T>(call: () => Promise<ActionResult<T>>, onSuccess?: (data: T) => void) {
    setError(null);
    startTransition(async () => {
      const result = await call();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (onSuccess) onSuccess(result.data);
      router.refresh();
    });
  }

  return { run, error, setError, pending };
}
