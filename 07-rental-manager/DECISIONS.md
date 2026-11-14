# Decisions

Points the specification left open, and what was chosen.

1. **Rent posting covers ended leases.** 5.4 says `post-rent` processes active leases, but a lease ended with an end date before the end month's due date (or ended before the job ran that month) would otherwise never be billed for its final, prorated period. `post-rent` therefore processes `active` and `ended` leases; the schedule is bounded by the end month either way, so nothing is posted after it.

2. **Ending a lease requires `end_date <= today`** and, when the lease already has an end date, `end_date <=` that date. "May shorten" was read as "may not extend". An ended lease drops out of the active-only overlap constraint, so an ended lease with a future end date could be double-let; requiring the date to be today or earlier prevents that.

3. **Late-fee columns are always present.** `late_fee_flat_cents` and `late_fee_bps` are `NOT NULL DEFAULT 0`. Check constraints require a positive flat amount for `flat` and 1–2500 bps for `percent`; the unused value stays 0. A cap, when set, must be positive.

4. **Which reversals count for allocation.** For late fees (5.5, edge 22) a reversed entry and its reversal are ignored whatever their dates. For the rent roll, aging and dashboard as of a date D, the ledger as of D (entries dated on or before D) is used, so a reversal dated after D is not yet effective. This keeps "bucket totals plus credits reconcile to the sum of balances" true for past dates as well as today.

5. **Catch-up late-fee runs.** When one run assesses fees for several periods, each fee is added to the working ledger before later periods are decided, exactly as if it had been posted on its own date. A late run therefore produces the same ledger as daily runs (7, last bullet).

6. **Aging buckets.** 0–30, 31–60, 61–90 and "over 90" (91 days and more), so 90 days falls in 61–90, following the boundary rule given for 30 and 31.

7. **Manual entry keys.** The form's UUID is stored as the idempotency key as is. Replaying a key that belongs to another lease's entry is refused with `409 idempotency_key_conflict` instead of returning that entry. After a failed validation the form keeps its key; a malformed key is replaced.

8. **Draft leases may have no tenants.** Tenants (at least one, exactly one primary) are required to activate and on every edit of an active lease.

9. **Job runs on the dashboard.** Viewing job runs is admin-only, so the dashboard shows the last runs only to admins.

10. **Admins cannot demote or deactivate themselves** (`422 cannot_change_own_access`), so the last admin cannot lock everyone out.

11. **Manual job runs** from the admin screen run synchronously and are not cancelled if the browser disconnects. `as_of` must not be later than today. `run-job` exits non-zero unless the run finishes `ok`.

12. **Statement range defaults** to the lease start through today (or the start, if that is later). `from` after `to` is a validation error on `to`.

13. **Validation status codes.** Form re-renders use 422 with field messages; the JSON endpoint returns 400 `validation_failed` with `details.fields`. Business-rule failures on forms (for example an entry dated in the future) are shown on the form with 422.

14. **Error codes not named in the spec**: `lease_not_found`, `entry_not_found`, `forbidden`, `csrf_failed`, `unauthenticated`, `lease_not_postable`, `lease_not_draft`, `lease_not_active`, `lease_not_editable`, `tenants_required`, `unit_not_found`, `tenant_not_found`, `end_before_start`, `end_date_in_future`, `end_date_extends`, `reversal_not_reversible`, `reversal_window_closed`, `entry_date_out_of_range`, `entry_before_lease_start`, `invalid_entry_kind`, `invalid_date_range`, `idempotency_key_conflict`, `job_not_found`, `as_of_in_future`, `email_taken`, `user_not_found`, `cannot_change_own_access`, `malformed_request`, `payload_too_large`, `not_found`, `internal_error`.

15. **Sessions** use scs with `pgxstore`, which keys the `sessions` table by the session token itself; that is the library's design and the spec names it. Lifetime is 12 hours with a 2-hour idle timeout.

16. **Envelope key.** The shared error envelope keeps `requestId` exactly as specified; all other JSON keys are `snake_case`.

17. **HTTP port.** The spec names only the Postgres port; the server defaults to `:8087` (`HTTP_ADDR`).
