"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiRequest, describeError } from "./api";

export interface FieldSpec {
  name: string;
  label: string;
  type?: "text" | "email" | "password" | "number" | "date" | "time" | "select" | "checkbox";
  options?: { value: string; label: string }[];
  required?: boolean;
  defaultValue?: string | number | boolean | null;
  /** What an empty optional input sends: nothing (default) or an explicit null. */
  empty?: "omit" | "null";
  /** Send a select's value as a number. */
  numeric?: boolean;
}

interface Props {
  action: string;
  method?: "POST" | "PATCH";
  fields: FieldSpec[];
  submitLabel: string;
  /** Extra values sent with every submission, such as a fixed discriminator. */
  fixed?: Record<string, unknown>;
}

function collect(form: HTMLFormElement, fields: FieldSpec[]): Record<string, unknown> {
  const data = new FormData(form);
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === "checkbox") {
      body[field.name] = data.get(field.name) === "on";
      continue;
    }
    const raw = String(data.get(field.name) ?? "").trim();
    if (raw === "") {
      if (field.empty === "null") body[field.name] = null;
      continue;
    }
    body[field.name] = field.type === "number" || field.numeric ? Number(raw) : raw;
  }
  return body;
}

/** A plain form that submits its fields as JSON and shows API errors inline. */
export function ApiForm({ action, method = "POST", fields, submitLabel, fixed }: Props) {
  const router = useRouter();
  const [message, setMessage] = useState<{ kind: "error" | "notice"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    const result = await apiRequest<{ affectedAppointments?: string[] }>(action, {
      method,
      body: { ...fixed, ...collect(form, fields) },
    });
    setPending(false);
    if (!result.ok) {
      setMessage({ kind: "error", text: describeError(result.error) });
      return;
    }
    const affected = result.data.affectedAppointments ?? [];
    const warning = affected.length
      ? ` These booked appointments no longer match a slot: ${affected.join(", ")}`
      : "";
    setMessage({ kind: "notice", text: `Saved.${warning}` });
    if (method === "POST") form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="api-form">
      {fields.map((field) => (
        <label key={field.name}>
          <span>{field.label}</span>
          {field.type === "select" ? (
            <select
              name={field.name}
              required={field.required}
              defaultValue={String(field.defaultValue ?? "")}
            >
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : field.type === "checkbox" ? (
            <input name={field.name} type="checkbox" defaultChecked={Boolean(field.defaultValue)} />
          ) : (
            <input
              name={field.name}
              type={field.type ?? "text"}
              required={field.required}
              defaultValue={field.defaultValue === null ? "" : String(field.defaultValue ?? "")}
            />
          )}
        </label>
      ))}
      <button type="submit" disabled={pending}>
        {submitLabel}
      </button>
      {message && <p className={message.kind}>{message.text}</p>}
    </form>
  );
}
