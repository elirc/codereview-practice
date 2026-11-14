"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiRequest, describeError } from "../_components/api";

export function CancelButton({ appointmentId }: { appointmentId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function cancel() {
    const reason = window.prompt("Cancel this appointment? You may add a reason.");
    if (reason === null) return;
    setPending(true);
    const trimmed = reason.trim();
    const result = await apiRequest(`/api/appointments/${appointmentId}/cancel`, {
      body: trimmed ? { reason: trimmed } : {},
    });
    setPending(false);
    if (!result.ok) {
      setError(describeError(result.error));
      return;
    }
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={cancel} disabled={pending}>
        Cancel
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}
