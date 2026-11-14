# Decisions

Places where the spec left room for interpretation, what was chosen, and why.

1. **Solid Queue schema.** The spec says `db/queue_schema.rb` is merged into the main schema via a migration. The Solid Queue tables are created by `20261114090000_create_solid_queue_tables` and appear in `db/schema.rb`; no separate `queue_schema.rb` is kept, so there is one schema file for the one database.

2. **Site-wide promo codes have no screen.** The model, lookup and pricing support codes with no event, but the route table lists promo codes only under `manage/events`. Admins create site-wide codes from seeds or the console rather than through a new, unspecified route.

3. **Event code beats site-wide code.** When an event code and a site-wide code share the same text, applying it on that event uses the event's code. Uniqueness is per scope, so both can exist.

4. **`available` in `insufficient_capacity`.** The detail is the tier's free count (`capacity − sold − held`), not counting the user's own hold that would have been replaced.

5. **Error codes the spec does not name.** Joining a waitlist twice returns `already_waitlisted` (409); leaving an entry that is no longer open returns `waitlist_entry_closed` (409); refunding a refunded order returns `already_refunded` (409); a provider refund failure returns `refund_failed` (422); publishing or deleting a non-draft returns `event_not_draft` (409).

6. **Checkout on a cancelled event.** Edge case 33 says live holds can be checked out after sales close unless the event is cancelled. Checkout refuses with `event_cancelled` once the event is cancelled, even before the cancel job has released the hold. Changes to tiers, promo codes and event details are also refused on cancelled events.

7. **`waitlist_open` in the availability JSON** is true when the event is on sale and the tier either has pending entries or no free tickets, i.e. when a one-ticket join would be accepted.

8. **Cancelled events stay visible.** Their public page shows that they are cancelled; the event list shows published events only, and the availability endpoint answers 404 for anything not published.

9. **Leaving the waitlist always runs promotion**, including leaving a `waiting` entry: a large entry at the front of the queue can be what blocks smaller entries behind it.

10. **Cancellation mail** is sent to each refunded order's customer. Released holds and cancelled waitlist entries are not mailed.

11. **What the per-event cap counts.** The 8-ticket cap is checked when holding and when joining a waitlist, and counts valid paid tickets, live holds and the quantities of the user's `waiting` entries on the event. An offered entry is counted through its hold, so an offer and a checkout only move quantity between already-counted buckets and need no re-check.

12. **Stale direct hold during promotion.** If a waiting user has an active direct hold that is already past its expiry (not yet swept), promotion expires it in place before offering, since the one-active-hold-per-tier index would otherwise block the offer.

13. **Replaced holds** get status `released`.

14. **Fake gateway idempotency.** `FakeGateway` remembers approved charges by idempotency key; declines are not remembered, and voiding a charge forgets its key, so a hold whose checkout was voided or declined can be paid again under the same `hold-<id>` key.

15. **Mail in production** uses the same log delivery as development, since no mail provider is in scope.

16. **Error envelope key casing.** The shared example shows `requestId`; this is a Ruby project, whose JSON uses snake_case, so the key is `request_id`.

17. **Money input.** Organiser forms take prices and discounts in integer cents to keep floats out of the money path.

18. **Status codes.** Capacity, expiry and duplicate-state conflicts (`insufficient_capacity`, `hold_expired`, `already_waitlisted`, …) are 409; other business-rule failures (`sales_closed`, `quantity_invalid`, promo errors, `payment_declined`, …) are 422.
