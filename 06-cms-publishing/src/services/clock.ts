/**
 * The single source of "now" for request handlers and actions. Services take `now` as a
 * parameter instead of reading the clock, so tests can fix time by stubbing `clock.now`.
 */
export const clock = {
  now: (): Date => new Date(),
};
