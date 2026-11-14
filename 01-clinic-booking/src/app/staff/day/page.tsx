import Link from "next/link";
import { addDays, isLocalDate, localDateOf, localDayRange } from "@/domain/time";
import type { Actor } from "@/server/auth/actor";
import { requirePageActor } from "@/server/auth/page";
import { clock } from "@/server/clock";
import { uuid } from "@/server/validation";
import type { AppointmentView } from "@/services/access";
import { listAppointments } from "@/services/appointments";
import { getClinic, listClinicProviders, listClinics } from "@/services/clinics";
import { ActionButton } from "../../_components/ActionButton";
import { longDate, timeIn } from "../../_lib/format";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function chooseClinic(actor: Actor, requested: string | undefined, clinics: { id: string }[]) {
  if (actor.role !== "ADMIN") return actor.clinicId;
  if (requested && uuid.safeParse(requested).success) return requested;
  return clinics[0]?.id ?? null;
}

interface CardProps {
  appointment: AppointmentView;
  zone: string;
  canCancel: boolean;
}

function AppointmentCard({ appointment: a, zone, canCancel }: CardProps) {
  const base = `/api/appointments/${a.id}`;
  return (
    <div className={`card status-${a.status}`}>
      <strong>
        {timeIn(a.startsAt, zone)} – {timeIn(a.endsAt, zone)}
      </strong>
      <div>{a.patient.fullName}</div>
      <div className="muted">
        {a.status}
        {a.lateCancel && " (late cancellation)"}
        {a.reason && ` · ${a.reason}`}
      </div>
      {a.status === "BOOKED" && (
        <div>
          <ActionButton path={`${base}/complete`} label="Completed" />{" "}
          <ActionButton path={`${base}/no-show`} label="No-show" />{" "}
          {canCancel && (
            <ActionButton path={`${base}/cancel`} label="Cancel" confirm="Cancel this visit?" />
          )}
        </div>
      )}
    </div>
  );
}

export default async function DayViewPage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await requirePageActor("STAFF", "PROVIDER", "ADMIN");
  const params = await searchParams;
  const clinics = actor.role === "ADMIN" ? await listClinics() : [];
  const clinicId = chooseClinic(actor, first(params.clinicId), clinics);
  if (!clinicId) return <p>No clinics have been set up yet.</p>;

  const clinic = await getClinic(clinicId);
  const zone = clinic.timezone;
  const requestedDate = first(params.date);
  const date =
    requestedDate && isLocalDate(requestedDate) ? requestedDate : localDateOf(clock.now(), zone);
  const { start, end } = localDayRange(date, zone);
  const hours = end.diff(start, "hours").hours;

  const providers = (await listClinicProviders(actor, clinic.id)).filter(
    (provider) => actor.role !== "PROVIDER" || provider.id === actor.providerId,
  );
  const appointments = await listAppointments(actor, { scope: "clinic", date, clinicId });
  const canCancel = actor.role === "STAFF" || actor.role === "ADMIN";
  const link = (day: string) =>
    `/staff/day?${new URLSearchParams({ clinicId: clinic.id, date: day }).toString()}`;

  return (
    <>
      <h1>
        {clinic.name}: {longDate(date)}
      </h1>
      <p className="muted">
        Times in {zone}.{hours !== 24 && ` This day is ${hours} hours long.`}
      </p>
      <form method="get" className="api-form">
        {actor.role === "ADMIN" && (
          <label>
            <span>Clinic</span>
            <select name="clinicId" defaultValue={clinic.id}>
              {clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>Date</span>
          <input type="date" name="date" defaultValue={date} />
        </label>
        <button type="submit">Show</button>
        <Link href={link(addDays(date, -1))}>Previous day</Link>
        <Link href={link(addDays(date, 1))}>Next day</Link>
      </form>

      <div className="day-columns">
        {providers.map((provider) => {
          const own = appointments.filter((a) => a.providerId === provider.id);
          return (
            <section key={provider.id}>
              <h2>{provider.displayName}</h2>
              <p>
                <Link href={`/staff/providers/${provider.id}/availability`}>Availability</Link>
                {!provider.active && <span className="muted"> (inactive)</span>}
              </p>
              {own.length === 0 && <p className="muted">No appointments.</p>}
              {own.map((a) => (
                <AppointmentCard key={a.id} appointment={a} zone={zone} canCancel={canCancel} />
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
