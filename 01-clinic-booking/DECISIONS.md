# Decisions

Points where the specification left room for interpretation, and what was chosen.

## Error code for CSRF rejections

The spec requires mutating handlers to check `Content-Type` and `Origin` but names no error code. Both failures return `403 csrf_failed`, so clients can tell a policy rejection apart from a role failure (`403 forbidden`).

## Duplicate registration

Registering an email that already exists returns `409 email_taken`. Self-registration necessarily reveals that an email is in use; login failures still never do.

## Malformed path ids

A path id that is not a UUID cannot exist, so it returns `404 not_found` exactly like a missing row. This keeps "foreign id" and "unknown id" responses identical without a separate `400` shape for appointment ids.

## Second exception for the same date

`(providerId, localDate)` is unique, but the spec does not say what a second `POST` for the same date does. It returns `409 exception_exists` rather than replacing the first; staff delete and re-create to change it.

## Latest wall time

Rule and exception times are `00:00`–`23:59`; `24:00` is not accepted. Windows may not cross midnight, so a window cannot offer a slot that ends exactly at midnight.

## Which appointments are "affected"

`affectedAppointments` lists the provider's `BOOKED` appointments that start at or after the current time and no longer coincide (start and end) with a generated slot. Past appointments are not reported because nothing can be done about them.

## Slot availability for staff callers

`GET /providers/:id/slots` always annotates availability with the clinic's lead time, as a patient would see it. Staff and admin may still book a `too_soon` slot through `POST /appointments`, where their exemption applies.

## `patientId` sent by a patient

Patients always book for themselves. A `patientId` in a patient's booking request is ignored rather than rejected, so the request cannot target anyone else either way.

## Codes the spec does not name

- Marking an appointment `COMPLETED` or `NO_SHOW` before it starts returns `422 not_started`.
- Rescheduling to a provider in a different clinic returns `422 provider_not_in_clinic`.

## Reschedule response

`POST /appointments/:id/reschedule` creates a new appointment, so it answers `201` with that appointment. The old row is cancelled with `cancelReason = "Rescheduled"`; whether it counts as a late cancellation follows the normal cancellation rule for the caller.

## Rescheduled email job

The spec asks for one "rescheduled" email after commit but lists only `email.cancellation` among the queues. A matching `email.rescheduled` queue is added and handled exactly like `email.cancellation`.

## Listing scopes

`scope=mine` is for patients only; other roles use `scope=clinic`. A `date` filter is interpreted in the zone of the clinic named by `clinicId`, else the caller's own clinic, else the clinic of `providerId`. Admins filtering by date without either id get `400 validation_failed`, because "a day" is undefined across clinics in different zones.

## Cancellation and reschedule emails go through an outbox table

The spec has the web process enqueue `email.cancellation` through pg-boss after the transaction commits, which loses the email if the enqueue fails or the process stops between commit and enqueue. Instead the cancel and reschedule transactions write an `appointment_notifications` row (unique per appointment and kind), so the email exists exactly when the change commits and a rolled-back change leaves none. The minute `reminders.dispatch` run claims pending rows with `FOR UPDATE SKIP LOCKED` and enqueues one `email.cancellation` or `email.rescheduled` job per row, and the job handler uses the reminder semantics: it acts only on a `SENDING` row, marks it `SENT` conditionally, records mail failures on the row, retries on the next dispatch and gives up as `FAILED` after five attempts; claims older than ten minutes return to `PENDING`. The web process therefore no longer talks to pg-boss, and pg-boss's own retry is used only for unexpected handler errors. Delivery is at-least-once, like reminders. There is no staleness cut-off for these emails.

## Retry timing for failed reminders

The spec returns a failed reminder to `PENDING` without saying when it is retried. It is picked up by the next dispatch run (about a minute later) with its original `scheduledFor`, so the 30-minute staleness rule still applies to retries: a reminder that keeps failing past that point is `SKIPPED` rather than sent late.

## Clinic time zone and provider clinic are fixed after creation

Rules are stored as clinic wall time and appointments as instants, so changing a clinic's zone (or moving a provider to another clinic) would silently shift every future slot away from existing bookings. `PATCH /admin/clinics/:id` accepts name, lead time and horizon only, and `PATCH /admin/providers/:id` accepts display name, specialty and `active`. Unknown fields are rejected with `400 validation_failed`.
