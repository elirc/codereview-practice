import Link from "next/link";
import { notFound } from "next/navigation";
import { SLOT_LENGTHS } from "@/domain/slots";
import { requirePageActor } from "@/server/auth/page";
import { AppError } from "@/server/errors";
import { serializeException, serializeRule } from "@/server/serialize";
import { uuid } from "@/server/validation";
import { getAvailability } from "@/services/availability";
import { ActionButton } from "../../../../_components/ActionButton";
import { ApiForm, type FieldSpec } from "../../../../_components/ApiForm";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const weekdayOptions = WEEKDAYS.map((label, index) => ({ value: String(index + 1), label }));
const slotOptions = SLOT_LENGTHS.map((minutes) => ({
  value: String(minutes),
  label: `${minutes} min`,
}));

function ruleFields(rule?: ReturnType<typeof serializeRule>): FieldSpec[] {
  return [
    {
      name: "weekday",
      label: "Weekday",
      type: "select",
      numeric: true,
      options: weekdayOptions,
      defaultValue: rule?.weekday ?? 1,
    },
    {
      name: "startLocal",
      label: "Start",
      type: "time",
      required: true,
      defaultValue: rule?.startLocal,
    },
    { name: "endLocal", label: "End", type: "time", required: true, defaultValue: rule?.endLocal },
    {
      name: "slotMinutes",
      label: "Slot length",
      type: "select",
      numeric: true,
      options: slotOptions,
      defaultValue: rule?.slotMinutes ?? 30,
    },
    {
      name: "validFrom",
      label: "Valid from",
      type: "date",
      required: true,
      defaultValue: rule?.validFrom,
    },
    {
      name: "validTo",
      label: "Valid to (inclusive, optional)",
      type: "date",
      defaultValue: rule?.validTo,
      empty: rule ? "null" : "omit",
    },
  ];
}

const exceptionFields: FieldSpec[] = [
  { name: "localDate", label: "Date", type: "date", required: true },
  {
    name: "kind",
    label: "Kind",
    type: "select",
    options: [
      { value: "CLOSED", label: "Closed all day" },
      { value: "CUSTOM_HOURS", label: "Custom hours" },
    ],
  },
  { name: "startLocal", label: "Start (custom hours)", type: "time" },
  { name: "endLocal", label: "End (custom hours)", type: "time" },
  {
    name: "slotMinutes",
    label: "Slot length (custom hours)",
    type: "select",
    numeric: true,
    options: [{ value: "", label: "—" }, ...slotOptions],
  },
];

export default async function AvailabilityPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePageActor("STAFF", "ADMIN", "PROVIDER");
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();

  const availability = await getAvailability(actor, id).catch((err: unknown) => {
    if (err instanceof AppError && err.code === "not_found") notFound();
    if (err instanceof AppError && err.code === "forbidden") return null;
    throw err;
  });
  if (!availability) {
    return <p className="error">You do not have access to this provider&apos;s availability.</p>;
  }

  const { provider, canManage } = availability;
  const rules = availability.rules.map(serializeRule);
  const exceptions = availability.exceptions.map(serializeException);

  return (
    <>
      <h1>{provider.displayName}: availability</h1>
      <p className="muted">
        Wall-clock times in {provider.clinic.timezone}. Changes never alter existing bookings;
        appointments that no longer fit are listed after saving.{" "}
        <Link href={`/staff/day?clinicId=${provider.clinicId}`}>Back to day view</Link>
      </p>

      <h2>Weekly rules</h2>
      <table>
        <thead>
          <tr>
            <th>Weekday</th>
            <th>Hours</th>
            <th>Slot</th>
            <th>Valid</th>
            {canManage && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <td>{WEEKDAYS[rule.weekday - 1]}</td>
              <td>
                {rule.startLocal}–{rule.endLocal}
              </td>
              <td>{rule.slotMinutes} min</td>
              <td>
                {rule.validFrom} to {rule.validTo ?? "open-ended"}
              </td>
              {canManage && (
                <td>
                  <details>
                    <summary>Edit</summary>
                    <ApiForm
                      action={`/api/availability-rules/${rule.id}`}
                      method="PATCH"
                      fields={ruleFields(rule)}
                      submitLabel="Save rule"
                    />
                  </details>
                  <ActionButton
                    path={`/api/availability-rules/${rule.id}`}
                    method="DELETE"
                    label="Delete"
                    confirm="Delete this rule?"
                  />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && (
        <>
          <h3>Add a rule</h3>
          <ApiForm
            action={`/api/providers/${provider.id}/availability-rules`}
            fields={ruleFields()}
            submitLabel="Add rule"
          />
        </>
      )}

      <h2>Exceptions</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Kind</th>
            <th>Hours</th>
            {canManage && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {exceptions.map((exception) => (
            <tr key={exception.id}>
              <td>{exception.localDate}</td>
              <td>{exception.kind === "CLOSED" ? "Closed" : "Custom hours"}</td>
              <td>
                {exception.kind === "CUSTOM_HOURS"
                  ? `${exception.startLocal}–${exception.endLocal}, ${exception.slotMinutes} min`
                  : "—"}
              </td>
              {canManage && (
                <td>
                  <ActionButton
                    path={`/api/exceptions/${exception.id}`}
                    method="DELETE"
                    label="Delete"
                    confirm="Delete this exception?"
                  />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && (
        <>
          <h3>Add an exception</h3>
          <ApiForm
            action={`/api/providers/${provider.id}/exceptions`}
            fields={exceptionFields}
            submitLabel="Add exception"
          />
        </>
      )}
    </>
  );
}
