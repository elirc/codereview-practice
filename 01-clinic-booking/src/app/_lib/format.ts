import { DateTime } from "luxon";

function at(instant: Date | string, zone: string): DateTime {
  const value =
    typeof instant === "string" ? DateTime.fromISO(instant) : DateTime.fromJSDate(instant);
  return value.setZone(zone).setLocale("en-US");
}

/** `9:30 AM EDT` in the given zone. */
export function timeIn(instant: Date | string, zone: string): string {
  return at(instant, zone).toFormat("h:mm a ZZZZ");
}

/** `Mon 6 Jul, 9:30 AM EDT` in the given zone. */
export function dateTimeIn(instant: Date | string, zone: string): string {
  return at(instant, zone).toFormat("ccc d LLL, h:mm a ZZZZ");
}

/** A slot time for a patient, with the clinic's wall time when the offsets differ. */
export function slotLabel(instant: string, patientZone: string, clinicZone: string): string {
  const forPatient = at(instant, patientZone);
  const forClinic = at(instant, clinicZone);
  const label = forPatient.toFormat("ccc d LLL, h:mm a ZZZZ");
  if (forPatient.offset === forClinic.offset) return label;
  return `${label} (${forClinic.toFormat("h:mm a ZZZZ")} clinic)`;
}

/** `Monday 6 July 2026` for a clinic-local date. */
export function longDate(date: string): string {
  return DateTime.fromISO(date, { zone: "utc" }).setLocale("en-US").toFormat("cccc d LLLL yyyy");
}
