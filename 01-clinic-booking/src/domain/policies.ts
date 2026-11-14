import type { DateTime } from "luxon";
import { isBeyondHorizon, isTooSoon, type BookingWindow } from "./slots";

export type AppointmentStatus = "BOOKED" | "CANCELLED" | "COMPLETED" | "NO_SHOW";

export const CANCELLATION_NOTICE_HOURS = 24;
const HOUR_MS = 3_600_000;

export type BookingWindowViolation = "in_past" | "too_soon" | "beyond_horizon";

/**
 * Checks a slot start against the clinic's booking window. Staff and admins skip the lead
 * time but still cannot book a start that is not in the future.
 */
export function checkBookingWindow(
  startsAt: DateTime,
  window: BookingWindow,
  leadTimeExempt: boolean,
): BookingWindowViolation | null {
  if (leadTimeExempt) {
    if (startsAt.toMillis() <= window.now.toMillis()) return "in_past";
  } else if (isTooSoon(startsAt, window)) {
    return "too_soon";
  }
  return isBeyondHorizon(startsAt, window) ? "beyond_horizon" : null;
}

export type CancellerRole = "PATIENT" | "STAFF" | "ADMIN";

export type CancellationDecision =
  | { allowed: true; lateCancel: boolean }
  | { allowed: false; code: "cancellation_window_closed" | "already_started" };

export function evaluateCancellation(
  role: CancellerRole,
  startsAt: DateTime,
  now: DateTime,
): CancellationDecision {
  const noticeMs = startsAt.toMillis() - now.toMillis();
  const requiredMs = CANCELLATION_NOTICE_HOURS * HOUR_MS;
  if (role === "PATIENT") {
    return noticeMs >= requiredMs
      ? { allowed: true, lateCancel: false }
      : { allowed: false, code: "cancellation_window_closed" };
  }
  if (noticeMs <= 0) return { allowed: false, code: "already_started" };
  return { allowed: true, lateCancel: noticeMs < requiredMs };
}

/** Why an appointment cannot be marked COMPLETED or NO_SHOW yet, if it cannot. */
export function outcomeProblem(
  status: AppointmentStatus,
  startsAt: DateTime,
  now: DateTime,
): "invalid_state" | "not_started" | null {
  if (status !== "BOOKED") return "invalid_state";
  if (now.toMillis() < startsAt.toMillis()) return "not_started";
  return null;
}
