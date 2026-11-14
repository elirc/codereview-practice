import Link from "next/link";
import { formatAppointmentTime } from "@/domain/emails";
import { requirePageActor } from "@/server/auth/page";
import { clock } from "@/server/clock";
import { fromDbInstant } from "@/server/dates";
import type { AppointmentView } from "@/services/access";
import { listAppointments } from "@/services/appointments";
import { getProfile } from "@/services/auth";
import { CancelButton } from "./CancelButton";

const STATUS_LABELS = {
  BOOKED: "Booked",
  CANCELLED: "Cancelled",
  COMPLETED: "Completed",
  NO_SHOW: "Missed",
} as const;

function rescheduleHref(appointment: AppointmentView): string {
  const query = new URLSearchParams({
    clinicId: appointment.provider.clinicId,
    providerId: appointment.providerId,
    reschedule: appointment.id,
  });
  return `/book?${query.toString()}`;
}

export default async function AppointmentsPage() {
  const actor = await requirePageActor("PATIENT");
  const profile = await getProfile(actor);
  const patientZone = profile.patient?.timezone ?? "UTC";
  const now = clock.now();
  const appointments = await listAppointments(actor, { scope: "mine" });

  const isUpcoming = (a: AppointmentView) =>
    a.status === "BOOKED" && a.startsAt.getTime() > now.toMillis();
  const upcoming = appointments.filter(isUpcoming);
  const history = appointments.filter((a) => !isUpcoming(a)).reverse();

  const when = (a: AppointmentView) =>
    formatAppointmentTime(fromDbInstant(a.startsAt), patientZone, a.provider.clinic.timezone);

  return (
    <>
      <h1>My appointments</h1>
      <p className="muted">
        Times are shown in {patientZone}. Online cancellation closes 24 hours before the start.
      </p>

      <h2>Upcoming</h2>
      {upcoming.length === 0 ? (
        <p>
          Nothing booked. <Link href="/book">Book an appointment</Link>.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Provider</th>
              <th>Clinic</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {upcoming.map((a) => (
              <tr key={a.id}>
                <td>{when(a)}</td>
                <td>{a.provider.displayName}</td>
                <td>{a.provider.clinic.name}</td>
                <td>
                  <Link href={rescheduleHref(a)}>Reschedule</Link>{" "}
                  <CancelButton appointmentId={a.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>History</h2>
      {history.length === 0 ? (
        <p className="muted">No past or cancelled appointments.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Provider</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {history.map((a) => (
              <tr key={a.id} className={`status-${a.status}`}>
                <td>{when(a)}</td>
                <td>{a.provider.displayName}</td>
                <td>
                  {STATUS_LABELS[a.status]}
                  {a.cancelReason ? ` (${a.cancelReason})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
