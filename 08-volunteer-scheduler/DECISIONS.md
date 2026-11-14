# Decisions

Choices made where the spec left room for interpretation.

## Recurrence candidate cap

**Unclear:** the 1,000-candidate cap would make a long-running uncounted series (for example a daily series that started three years ago) generate nothing for today's horizon if candidates were always counted from `dtstart`.
**Chosen:** when a rule has no `count`, generation starts at the period containing `rangeStart` (keeping the interval phase), so the cap bounds the work inside the requested range. Rules with a `count` always walk from `dtstart`, since the count is defined from there. A month without the requested day still counts as one examined candidate, which keeps impossible rules bounded.

## Series edits: effective date range and materialisation window

**Unclear:** "this and following" edits from date E keep one pattern per series, so later materialisation runs could create new-pattern shifts before E, or old-pattern shifts between the horizon end and E would never be created.
**Chosen:** E must lie between today and the end of the 60-day horizon. An edit first materialises the old pattern through the horizon, then applies the changes from E. Materialisation only fills dates after `materializedThrough`, so dates before E that are already stored are never revisited, and every date generated later is on or after E.

## Occurrences in the past

**Unclear:** whether materialisation should create occurrences whose start time has already passed (for example a series created at noon with a 09:00 start today), and whether a pattern change should cancel a shift that is already running.
**Chosen:** occurrences that would start at or before now are not inserted, and pattern changes, field changes and series deletion only touch shifts that have not started. Shifts that already started cannot be edited or cancelled either (`shift_started`).

## Pattern changes and previously cancelled dates

**Unclear:** whether a date that a pattern change re-adds should revive a shift that was cancelled earlier.
**Chosen:** no. A cancelled shift stays cancelled (its signups were already cancelled and notified); the insert is a no-op on the existing row.

## Deleting a series

**Unclear:** a series with a `count` cannot also have `until` (the schema allows only one).
**Chosen:** deleting sets `until` to yesterday and clears `count`.

## Exceptions

**Unclear:** whether exceptions can be changed after they are created.
**Chosen:** one exception per occurrence. A `modified` exception can be modified again or turned into a cancellation; a `cancelled` occurrence is final (`occurrence_cancelled`). Editing a series occurrence on the shift page writes a `modified` exception, so only location, time, duration and capacity can change there; the title belongs to the series.

## Sign-ups on an over-capacity shift

**Unclear:** a shift whose capacity was lowered below its confirmed count "takes no new signups", while the sign-up algorithm waitlists whenever the confirmed count is at or above capacity.
**Chosen:** follow the algorithm: new sign-ups are waitlisted (never confirmed) and promotions stay suspended until the confirmed count drops below capacity. The roster and the volunteer list show the shift as full or over capacity.

## Coordinators cancelling their own signups

**Unclear:** the two-hour cut-off is described for volunteers and the until-end rule for coordinators removing anyone.
**Chosen:** the rule follows the actor's role, so a coordinator or admin may cancel any signup, including their own, until the shift ends. The `signup-cancelled` notice is only sent when the actor is not the signup's owner.

## Job failure backoff

**Unclear:** whether `60 × 2^consecutiveFailures` uses the failure count before or after the failure being recorded.
**Chosen:** after: the counter is incremented first, so the first failure waits 120 s, the second 240 s, and so on, never more than the job's interval.
