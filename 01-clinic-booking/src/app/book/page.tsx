import Link from "next/link";
import { notFound } from "next/navigation";
import { formatAppointmentTime } from "@/domain/emails";
import { addDays, isLocalDate, localDateOf } from "@/domain/time";
import type { Actor } from "@/server/auth/actor";
import { requirePageActor } from "@/server/auth/page";
import { clock } from "@/server/clock";
import { fromDbInstant, isoInstant } from "@/server/dates";
import { AppError } from "@/server/errors";
import { uuid } from "@/server/validation";
import { getAppointment } from "@/services/appointments";
import { getProfile } from "@/services/auth";
import { getClinic, listClinicProviders, listClinics } from "@/services/clinics";
import { getProviderSlots } from "@/services/slots";
import { longDate, slotLabel } from "../_lib/format";
import { SlotButton } from "./SlotButton";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DAYS_SHOWN = 7;

function pick(value: string | string[] | undefined, valid: (v: string) => boolean) {
  const single = Array.isArray(value) ? value[0] : value;
  return single && valid(single) ? single : undefined;
}

const isUuid = (value: string) => uuid.safeParse(value).success;

function bookHref(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return `/book?${query.toString()}`;
}

function notFoundOnAppError(err: unknown): never {
  if (err instanceof AppError && err.code === "not_found") notFound();
  throw err;
}

async function loadRescheduleTarget(actor: Actor, id: string | undefined) {
  if (!id) return null;
  return getAppointment(actor, id).catch(notFoundOnAppError);
}

export default async function BookPage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await requirePageActor("PATIENT");
  const params = await searchParams;
  const profile = await getProfile(actor);
  const patientZone = profile.patient?.timezone ?? "UTC";
  const now = clock.now();

  const reschedule = await loadRescheduleTarget(actor, pick(params.reschedule, isUuid));
  const clinicId = reschedule?.provider.clinicId ?? pick(params.clinicId, isUuid);
  const providerId = pick(params.providerId, isUuid);
  const keep = { clinicId, reschedule: reschedule?.id };

  const heading = reschedule ? (
    <>
      <h1>Reschedule</h1>
      <p>
        Moving your appointment with {reschedule.provider.displayName} on{" "}
        {formatAppointmentTime(
          fromDbInstant(reschedule.startsAt),
          patientZone,
          reschedule.provider.clinic.timezone,
        )}
        .
      </p>
    </>
  ) : (
    <h1>Book an appointment</h1>
  );

  if (!clinicId) {
    const clinics = await listClinics();
    return (
      <>
        {heading}
        <h2>Choose a clinic</h2>
        <ul>
          {clinics.map((clinic) => (
            <li key={clinic.id}>
              <Link href={bookHref({ clinicId: clinic.id })}>{clinic.name}</Link>{" "}
              <span className="muted">({clinic.timezone})</span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  const clinic = await getClinic(clinicId).catch(notFoundOnAppError);
  const providers = await listClinicProviders(actor, clinic.id);
  const provider = providers.find((p) => p.id === providerId);

  if (!provider) {
    return (
      <>
        {heading}
        <h2>{clinic.name}: choose a provider</h2>
        <ul>
          {providers.map((p) => (
            <li key={p.id}>
              <Link href={bookHref({ ...keep, providerId: p.id })}>{p.displayName}</Link>{" "}
              <span className="muted">{p.specialty}</span>
            </li>
          ))}
        </ul>
        {!reschedule && <Link href="/book">Back to clinics</Link>}
      </>
    );
  }

  const today = localDateOf(now, clinic.timezone);
  const from = pick(params.date, isLocalDate) ?? today;
  const to = addDays(from, DAYS_SHOWN - 1);
  const { days } = await getProviderSlots(provider.id, from, to, now);
  const nav = { ...keep, providerId: provider.id };

  return (
    <>
      {heading}
      <h2>
        {provider.displayName} at {clinic.name}
      </h2>
      <p className="muted">
        Times are shown in your time zone ({patientZone}); dates follow the clinic&apos;s calendar (
        {clinic.timezone}).
      </p>
      <p>
        <Link href={bookHref({ ...nav, date: addDays(from, -DAYS_SHOWN) })}>Previous week</Link>
        {" · "}
        <Link href={bookHref({ ...nav, date: addDays(from, DAYS_SHOWN) })}>Next week</Link>
        {" · "}
        <Link href={bookHref({ ...keep })}>Other providers</Link>
      </p>
      {days.map((day) => {
        const open = day.slots.filter((slot) => slot.available);
        return (
          <section key={day.date}>
            <h3>{longDate(day.date)}</h3>
            {open.length === 0 ? (
              <p className="muted">No open slots.</p>
            ) : (
              <div className="slots">
                {open.map((slot) => {
                  const startsAt = isoInstant(slot.startsAt);
                  return (
                    <SlotButton
                      key={startsAt}
                      providerId={provider.id}
                      startsAt={startsAt}
                      label={slotLabel(startsAt, patientZone, clinic.timezone)}
                      rescheduleId={reschedule?.id}
                    />
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
