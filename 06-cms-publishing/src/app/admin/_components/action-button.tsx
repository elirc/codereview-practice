"use client";

import { useRouter } from "next/navigation";
import type { ActionResult } from "@/actions/result";
import { ErrorMessage } from "./error-message";
import { useActionRunner } from "./use-action";

type Props<I> = {
  label: string;
  action: (input: I) => Promise<ActionResult<unknown>>;
  input: I;
  confirmMessage?: string;
  redirectTo?: string;
};

export function ActionButton<I>({ label, action, input, confirmMessage, redirectTo }: Props<I>) {
  const router = useRouter();
  const { run, error, pending } = useActionRunner();

  function onClick() {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    run(() => action(input), redirectTo ? () => router.push(redirectTo) : undefined);
  }

  return (
    <span>
      <button type="button" onClick={onClick} disabled={pending}>
        {label}
      </button>
      <ErrorMessage error={error} />
    </span>
  );
}
