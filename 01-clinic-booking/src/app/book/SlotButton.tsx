"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiRequest, describeError } from "../_components/api";

interface Props {
  providerId: string;
  startsAt: string;
  label: string;
  /** When set, the slot replaces this appointment instead of creating a new booking. */
  rescheduleId?: string;
}

export function SlotButton({ providerId, startsAt, label, rescheduleId }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function choose() {
    setError(null);
    if (!rescheduleId) {
      setPending(true);
      const check = await apiRequest("/api/appointments/check", { body: { providerId, startsAt } });
      setPending(false);
      if (!check.ok) {
        setError(describeError(check.error));
        return;
      }
    }
    const verb = rescheduleId ? "Move your appointment to" : "Book";
    if (!window.confirm(`${verb} ${label}?`)) return;
    setPending(true);
    const result = rescheduleId
      ? await apiRequest(`/api/appointments/${rescheduleId}/reschedule`, {
          body: { providerId, startsAt },
        })
      : await apiRequest("/api/appointments", {
          body: { providerId, startsAt },
          headers: { "Idempotency-Key": `${providerId}:${startsAt}` },
        });
    setPending(false);
    if (!result.ok) {
      setError(describeError(result.error));
      router.refresh();
      return;
    }
    router.push("/appointments");
    router.refresh();
  }

  return (
    <span>
      <button type="button" onClick={choose} disabled={pending}>
        {label}
      </button>
      {error && <span className="error"> {error}</span>}
    </span>
  );
}
