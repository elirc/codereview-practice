"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiRequest, describeError } from "./api";

interface Props {
  path: string;
  method?: "POST" | "DELETE";
  label: string;
  confirm?: string;
  /** JSON body to send with the request. */
  body?: unknown;
}

/** A single-click API call (cancel, complete, delete) that refreshes the page afterwards. */
export function ActionButton({ path, method = "POST", label, confirm, body }: Props) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setPending(true);
    const result = await apiRequest<{ affectedAppointments?: string[] }>(path, { method, body });
    setPending(false);
    if (!result.ok) {
      setMessage(describeError(result.error));
      return;
    }
    const affected = result.data.affectedAppointments ?? [];
    setMessage(affected.length ? `No longer matching a slot: ${affected.join(", ")}` : null);
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={run} disabled={pending}>
        {label}
      </button>
      {message && <span className="error"> {message}</span>}
    </>
  );
}
