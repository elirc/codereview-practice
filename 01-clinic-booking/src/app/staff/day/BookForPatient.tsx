"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiRequest, describeError } from "../../_components/api";

interface Props {
  providerId: string;
  startsAt: string;
  label: string;
}

interface PatientLookup {
  patient: { id: string; fullName: string };
}

/** Books an open slot for a patient identified by the email on their account. */
export function BookForPatient({ providerId, startsAt, label }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function book() {
    const email = window.prompt(`Book ${label} for which patient? Enter their email address.`);
    if (!email || !email.trim()) return;
    setPending(true);
    setError(null);
    const query = new URLSearchParams({ email: email.trim() });
    const lookup = await apiRequest<PatientLookup>(`/api/patients?${query.toString()}`, {
      method: "GET",
    });
    if (!lookup.ok) {
      setPending(false);
      setError(describeError(lookup.error));
      return;
    }
    const { patient } = lookup.data;
    if (!window.confirm(`Book ${label} for ${patient.fullName}?`)) {
      setPending(false);
      return;
    }
    const result = await apiRequest("/api/appointments", {
      body: { providerId, startsAt, patientId: patient.id },
    });
    setPending(false);
    if (!result.ok) setError(describeError(result.error));
    router.refresh();
  }

  return (
    <span>
      <button type="button" onClick={book} disabled={pending}>
        {label}
      </button>
      {error && <span className="error"> {error}</span>}
    </span>
  );
}
