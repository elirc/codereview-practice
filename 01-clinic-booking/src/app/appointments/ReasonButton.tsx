"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiRequest, describeError } from "../_components/api";

interface Props {
  appointmentId: string;
  current: string | null;
}

export function ReasonButton({ appointmentId, current }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function edit() {
    const reason = window.prompt("What is the visit about?", current ?? "");
    if (reason === null) return;
    setPending(true);
    const result = await apiRequest(`/api/appointments/${appointmentId}`, {
      method: "PATCH",
      body: { reason: reason.trim() || null },
    });
    setPending(false);
    if (!result.ok) {
      setError(describeError(result.error));
      return;
    }
    setError(null);
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={edit} disabled={pending}>
        {current ? "Edit reason" : "Add reason"}
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}
