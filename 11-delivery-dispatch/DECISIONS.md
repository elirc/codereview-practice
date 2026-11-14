# Decisions

Points the SPEC leaves open, the choice made, and why.

1. **Unnamed tariff defaults.** `CANCEL_FEE_MINOR`, `COURIER_BASE_MINOR`, `COURIER_SHARE_BPS` and `CANCEL_COMPENSATION_MINOR` have no values in the SPEC. Defaults are 500, 300, 8000 and 400; all are configurable.
2. **Inactive restaurant on a quote.** The SPEC says the restaurant must be active but names no code. Unknown restaurants are `404 not_found`; inactive ones are `422 restaurant_inactive`.
3. **Cancel retry timing.** The retry sweeper needs a due instant. Orders store `cancel_retry_at` (set to `now + CANCEL_REQUEST_RETRY` on every send) instead of deriving it from `cancel_requested_at` and the attempt count. The first send is attempt 1; the sweeper sends attempts 2–6, then logs and clears `cancel_retry_at`, leaving the request `pending` for ops.
4. **`attempt` in `order.cancel_requested`.** "Same data" for retries is read as the same order and requester; `attempt` carries the send number, and every send bumps the order version so its `sequence` increases.
5. **Cancel note.** `POST /orders/{id}/cancel` accepts an optional free-text `reason` (≤ 500 chars). It is stored as `cancel_note`; `cancel_reason` is always derived from who asked, as the SPEC requires.
6. **Every order update bumps the version and writes history**, including cancel-request changes that do not change the status, so history has one row per version.
7. **`delivery.cancel_rejected` applies its reason.** If the rejection (reason `picked_up` or `delivered`) arrives before the lower-sequence pickup/delivery event, that event would later be skipped. Applying "the event's meaning directly" therefore also moves the order to `picked_up`/`delivered`.
8. **`delivery.cancelled` without a requester.** If an order has no `cancel_requested_by` when the answer arrives, the reason is `ops` and no fee is charged.
9. **Suspension ends the shift.** Suspending clears `shift_zone_id` (the active delivery, if any, continues). This makes "reinstating does not start a shift" hold and makes the courier `offline` once the delivery ends.
10. **Courier creation emits `courier.status_changed`** (offline, `status_version` 1) so dispatch learns the vehicle, and every courier event has a sequence of at least 1. The seed command does the same for each seeded courier, with a new `status_version` on every run.
11. **Sequences of `courier.reserved` / `courier.reservation_rejected`.** They carry the courier's current `status_version` as the SPEC's event table says; a reservation bumps the version once, shared by `courier.reserved` and `courier.status_changed`.
12. **Projection rows for unknown couriers.** A location for an unseen courier creates an `offline` row with vehicle `bike` until a status event supplies the real vehicle.
13. **Reservation deadline when `courier.reserved` is handled.** A reserved answer handled at or after `reserve_deadline` is treated as the timeout (release, back to `searching`) even if the sweeper has not run, so the timeout takes effect at its instant.
14. **`courier.reserved` for a delivery this courier already holds.** If the delivery is already `assigned` or `picked_up` with the same courier the event is a no-op instead of a release, so an assigned courier stays attached. Every other case releases as the SPEC says.
15. **Search deadline.** The offer loop also picks searching deliveries whose `search_deadline` has passed even if `next_offer_at` is later, so the search timeout takes effect at its instant. An offer already made may still be accepted until it expires.
16. **Offer insert conflicts.** If the partial unique indexes refuse an offer, the insert is rolled back to a savepoint and the delivery retries on the next pass without spending an attempt.
17. **Fresh position for surge supply** uses the same `POSITION_MAX_AGE` as candidate selection.
18. **Order confirm on non-placed orders** is `409 invalid_state`, except an order cancelled by `confirm_timeout`, which keeps answering `409 confirm_window_closed`. Decline of a non-pending offer is `409 offer_not_pending`.
19. **Couriers use PostGIS** for the 50 m publish distance (they store positions); only orders uses the pure-Go great-circle distance. `dd_couriers` therefore also has the PostGIS extension.
20. **Dead letters** use a UUID primary key (CONVENTIONS default) and store the raw payload as `bytea` with a nullable `event_id`, so invalid envelopes can be kept too.
21. **Dispatch seed.** Dispatch has no seed data of its own (its tables are projections and event-driven); `dispatch seed` only prints tokens.
22. **End-to-end tests reset the JetStream streams** on `TEST_NATS_URL` before each test so messages from earlier runs cannot interfere. `compose.yaml` runs a separate `nats-test` server on 6395 for this, and `.env.example` points `TEST_NATS_URL` at it, so the development streams on 6393 are untouched.
23. **The outbox relay counts as a loop**: with `LOOPS_ENABLED=false`, `serve` runs HTTP and consumers but neither the relay nor the sweepers.
