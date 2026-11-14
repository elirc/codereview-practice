import { DateTime } from "luxon";

export interface Clock {
  now(): DateTime;
}

/**
 * The process clock. Route handlers and jobs read the time here once per request or job
 * and pass it down; domain and service code never reads the system clock itself.
 */
export const clock: Clock = {
  now: () => DateTime.utc(),
};
