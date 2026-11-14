import type { DateTime } from "luxon";
import type { ReminderKind } from "./reminders";

export interface AppointmentEmailContext {
  patientName: string;
  patientZone: string;
  clinicName: string;
  clinicZone: string;
  providerName: string;
  startsAt: DateTime;
}

export interface EmailContent {
  subject: string;
  text: string;
}

const PATIENT_FORMAT = "cccc, LLLL d, yyyy 'at' h:mm a ZZZZ";
const CLINIC_FORMAT = "cccc, LLLL d 'at' h:mm a ZZZZ";

/**
 * Renders an instant in the patient's zone, adding the clinic's wall time when the two zones
 * have different offsets at that instant.
 */
export function formatAppointmentTime(
  startsAt: DateTime,
  patientZone: string,
  clinicZone: string,
): string {
  const forPatient = startsAt.setZone(patientZone).setLocale("en-US");
  const forClinic = startsAt.setZone(clinicZone).setLocale("en-US");
  const label = forPatient.toFormat(PATIENT_FORMAT);
  if (forPatient.offset === forClinic.offset) return label;
  return `${label} (${forClinic.toFormat(CLINIC_FORMAT)} clinic time)`;
}

function when(ctx: AppointmentEmailContext, startsAt = ctx.startsAt): string {
  return formatAppointmentTime(startsAt, ctx.patientZone, ctx.clinicZone);
}

function withWhom(ctx: AppointmentEmailContext): string {
  return `${ctx.providerName} at ${ctx.clinicName}`;
}

const SIGN_OFF = ["", "You can manage your appointments from the clinic booking site."];

export function reminderEmail(kind: ReminderKind, ctx: AppointmentEmailContext): EmailContent {
  const lead = kind === "T24H" ? "in 24 hours" : "in 2 hours";
  return {
    subject: `Reminder: your appointment with ${ctx.providerName} is ${lead}`,
    text: [
      `Hello ${ctx.patientName},`,
      "",
      `This is a reminder of your appointment with ${withWhom(ctx)} on ${when(ctx)}.`,
      ...SIGN_OFF,
    ].join("\n"),
  };
}

export function cancellationEmail(ctx: AppointmentEmailContext): EmailContent {
  return {
    subject: `Your appointment with ${ctx.providerName} has been cancelled`,
    text: [
      `Hello ${ctx.patientName},`,
      "",
      `Your appointment with ${withWhom(ctx)} on ${when(ctx)} has been cancelled.`,
      ...SIGN_OFF,
    ].join("\n"),
  };
}

export function rescheduledEmail(
  ctx: AppointmentEmailContext,
  previousStartsAt: DateTime | null,
): EmailContent {
  const previous = previousStartsAt
    ? ` It replaces the appointment on ${when(ctx, previousStartsAt)}.`
    : "";
  return {
    subject: `Your appointment with ${ctx.providerName} has been rescheduled`,
    text: [
      `Hello ${ctx.patientName},`,
      "",
      `Your appointment with ${withWhom(ctx)} is now on ${when(ctx)}.${previous}`,
      ...SIGN_OFF,
    ].join("\n"),
  };
}
