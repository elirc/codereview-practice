# 05 — Event Ticketing with Waitlists

## 1. Purpose

Organisers publish events with ticket tiers of limited capacity. Customers place a time-limited hold on tickets, optionally apply promo codes, and check out. Sold-out tiers have a FIFO waitlist that is offered tickets as they free up. Read `../CONVENTIONS.md` first.

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Runtime | Ruby 3.3.6, Rails 8.0.1 |
| DB | PostgreSQL 16 (compose host port 5455), `pg` 1.5.9. Single database; Solid Queue tables live in it (`config/queue.yml`, `db/queue_schema.rb` merged into the main schema via a migration) |
| Jobs | Solid Queue 1.1.2 via Active Job; recurring tasks in `config/recurring.yml`; run with `bin/jobs` |
| UI | Server-rendered ERB, turbo-rails 2.0.11, stimulus-rails 1.3.4, importmap-rails 2.1.0, propshaft 1.1.0. Plain CSS |
| Auth | Rails 8 authentication generator shape, written by hand: `User has_secure_password` (bcrypt 3.1.20), `Session` model, `Current`, `Authentication` concern, signed permanent `session_id` cookie. Sign-up controller added |
| Authorisation | Plain policy objects in `app/policies` (no gem) called from controllers |
| Tests | Minitest (Rails default), fixtures, `ActiveSupport::Testing::TimeHelpers`; concurrency tests use threads with separate connections and `self.use_transactional_tests = false` |
| Lint | rubocop-rails-omakase 1.0.0 |
| Mail | Action Mailer; `:test` in test, letter logged in development |
| Payment | `PaymentGateway` interface in `app/services/payment_gateway.rb` with `FakeGateway` (configurable to succeed/decline); no real provider |

Business operations are service objects in `app/services` (`Holds::Create`, `Holds::Release`, `Holds::Expire`, `Checkout::Complete`, `Waitlist::Join`, `Waitlist::Promote`, `Promos::Apply`, `Pricing::Quote`, `Orders::Refund`, `Events::Cancel`). Controllers are thin. Money is integer cents (`*_cents`), single currency (USD).

A small JSON endpoint set exists for availability polling and uses the error envelope; HTML flows re-render with flash/field errors.

## 3. Roles and permissions

`customer`, `organizer`, `admin` (column `users.role`).

| Action | guest | customer | organizer | admin |
|---|---|---|---|---|
| Browse published events | yes | yes | yes | yes |
| Hold tickets, apply promo, check out, join/leave waitlist, view own orders | no | yes | yes | yes |
| Create/edit events, tiers, promo codes | no | no | own events | all |
| View attendee list, orders, waitlist for an event | no | no | own events | all |
| Refund an order, cancel an event | no | no | own events | all |
| Manage users | no | no | no | yes |

Draft events are visible only to their organiser and admins (others get 404). A customer requesting another user's hold, order or waitlist entry gets 404.

## 4. Domain model

- **User**: `email_address` (unique, normalised), `password_digest`, `name`, `role`.
- **Event**: `organizer_id`, `title`, `description`, `venue`, `time_zone` (IANA), `starts_at`, `ends_at`, `status` (`draft` | `published` | `cancelled`), `sales_close_at` (default `starts_at`).
- **TicketTier**: `event_id`, `name`, `price_cents` (≥ 0), `capacity` (≥ 0), `sold_count`, `held_count`, `per_order_limit` (default 6), `position`, `lock_version` not used (pessimistic locking only). DB checks: `sold_count >= 0`, `held_count >= 0`, `sold_count + held_count <= capacity`.
- **Hold**: `user_id`, `ticket_tier_id`, `quantity` (> 0), `unit_price_cents` (tier price when the hold was created), `status` (`active` | `converted` | `released` | `expired`), `expires_at`, `source` (`direct` | `waitlist`), `waitlist_entry_id?`, `order_id?`. Partial unique index: one `active` hold per `(user_id, ticket_tier_id)`.
- **HoldPromo**: `hold_id`, `promo_code_id`; unique pair. (Codes attached to a hold before checkout.)
- **Order**: `user_id`, `event_id`, `number` (`ORD-` + 8 base32 chars, unique), `status` (`paid` | `refunded`), `subtotal_cents`, `discount_cents`, `total_cents`, `payment_reference`, `refunded_at?`.
- **Ticket**: `order_id`, `ticket_tier_id`, `code` (unique, 12 random base32 chars), `status` (`valid` | `void`).
- **PromoCode**: `event_id?` (null = site-wide, admin only), `code` (stored upper-case, unique within event scope and unique among site-wide), `kind` (`percent` | `fixed`), `percent_off` (1–100) or `amount_off_cents` (> 0), `stackable` (bool), `max_redemptions?`, `redemptions_count`, `per_user_limit` (default 1), `starts_at?`, `ends_at?`, `min_subtotal_cents` (default 0), `active`. Join table `promo_code_tiers` (empty = all tiers of the event).
- **PromoRedemption**: `promo_code_id`, `order_id`, `user_id`, `amount_cents`; unique `(promo_code_id, order_id)`.
- **WaitlistEntry**: `user_id`, `ticket_tier_id`, `quantity` (1..`per_order_limit`), `status` (`waiting` | `offered` | `converted` | `expired` | `cancelled`), `offered_at?`, `offer_expires_at?`. Partial unique index: one entry in (`waiting`, `offered`) per `(user_id, ticket_tier_id)`. FIFO order is `(created_at, id)`.

Definitions: `available = capacity − sold_count − held_count`. A hold is **live** when `status = 'active' AND expires_at > now`.

## 5. Domain rules

### 5.1 Capacity and holds

- Every change to `sold_count`/`held_count` happens inside a transaction that holds a row lock on the tier (`tier.with_lock` / `lock!`), re-reading counts under the lock.
- Lock order, everywhere: tier → hold → promo codes (ascending id) → waitlist entries. An operation touching several tiers locks them in ascending id order.
- `Holds::Create(user, tier, quantity)`:
  1. Event `published`, `now < sales_close_at`; else `sales_closed`.
  2. `1 <= quantity <= per_order_limit`; else `quantity_invalid`.
  3. Per-user per-event cap: tickets in the user's `paid` orders for the event (valid tickets) + quantities of the user's live holds on the event's tiers (excluding a hold being replaced) + `quantity` ≤ 8; else `event_limit_exceeded`.
  4. If the tier has any `waiting` or `offered` waitlist entry, direct holds are refused with `waitlist_active` (freed tickets go to the waitlist).
  5. If the user already has an active hold on the tier it is replaced: under the lock, release the old quantity and take the new one as a single change; if the new quantity does not fit, the old hold is kept unchanged and `insufficient_capacity` is returned with `available`.
  6. Requires `available >= quantity`; `held_count += quantity`; hold `active`, `expires_at = now + 10.minutes`; enqueue `ExpireHoldJob` at `expires_at`.
- Expiry is authoritative by time, not by job: a hold with `expires_at <= now` cannot be checked out or have promos applied even if still `active` in the table. Its quantity still counts in `held_count` until `Holds::Expire` runs.
- `Holds::Expire(hold)` / `Holds::Release(hold)`: under tier lock then hold lock, only if `status = 'active'` (and for expire, `expires_at <= now`): set `expired`/`released`, `held_count -= quantity`, detach nothing else. Then enqueue `PromoteWaitlistJob(tier)`. Running either twice changes counts once.
- A hold's expiry is not extended by applying promos or viewing the checkout page.

### 5.2 Pricing and promo codes

`Pricing::Quote(hold, promo_codes)` is pure and returns `subtotal_cents`, per-code `amount_cents`, `discount_cents`, `total_cents`.

- `subtotal = hold.unit_price_cents × quantity`.
- Code validity (each has an error code): exists and `active` (`promo_not_found` — same error for inactive, wrong event, and unknown); within `[starts_at, ends_at)` when set (`promo_not_active`); tier eligible (`promo_not_applicable`); `subtotal >= min_subtotal_cents` (`promo_min_not_met`); `redemptions_count < max_redemptions` when set (`promo_exhausted`); the user's redemptions of the code across all their orders, refunded ones included, `< per_user_limit` (`promo_user_limit`).
- Codes are matched case-insensitively after stripping whitespace.
- Stacking: at most 2 codes on a hold. A non-stackable code cannot be combined with any other code. Two stackable codes may be combined only if they are not both `percent`. The same code cannot be applied twice. Violations → `promo_not_stackable`.
- Application order is fixed regardless of entry order: percent first, then fixed. Percent discount = `(subtotal × percent_off / 100)` rounded half up to a cent (integer arithmetic: `(subtotal * percent + 50) / 100`). Fixed discount = `min(amount_off_cents, remaining)` where `remaining` is the subtotal minus discounts so far. `total = subtotal − discounts`, never below 0.
- Attaching a code to a hold (`Promos::Apply`) validates but does not consume a redemption. Limits are enforced again at checkout.

### 5.3 Checkout

`Checkout::Complete(hold, payment_token)` in one transaction:

1. Lock tier, then hold. Hold must belong to the user, be `active` and `expires_at > now`; else `hold_expired` (and nothing else changes).
2. Lock attached promo codes in id order; re-validate every rule in 5.2 against current counts; any failure aborts with that error; the hold stays active with its original expiry.
3. Compute the quote. If `total_cents > 0`, call the gateway with an idempotency key of `hold-<id>`; a decline aborts with `payment_declined`, hold stays. A zero total skips the gateway.
4. `held_count -= q`, `sold_count += q`; hold `converted`; create order, `q` tickets, redemptions (`redemptions_count += 1` each); waitlist entry (if any) `converted`.
5. After commit, send the confirmation mail (`deliver_later`).

The gateway call happens inside the transaction while the tier lock is held (accepted trade-off for this app; documented in README). If the transaction fails after a successful charge, `Checkout::Complete` calls `gateway.void(reference)` in a rescue and re-raises.

A second submission of the same checkout form after success finds the hold `converted` and redirects to the existing order rather than charging again.

### 5.4 Waitlist

- `Waitlist::Join(user, tier, quantity)`: allowed only when event is on sale and `available < quantity` or the tier has a non-empty waitlist; otherwise `tickets_available` (user should hold directly). The per-event cap (5.1 step 3) applies counting the requested quantity. One open entry per user per tier.
- `Waitlist::Promote(tier)` under tier lock: loop over `waiting` entries in FIFO order:
  - If the event is no longer on sale, stop.
  - If `available >= entry.quantity`: create a hold (`source: waitlist`, `expires_at = now + 30.minutes`), `held_count += quantity`, entry → `offered` with `offered_at`, `offer_expires_at`; enqueue `ExpireHoldJob`; send offer mail after commit; continue with the next entry.
  - Otherwise stop. There is no skipping ahead to a smaller later entry.
  - If the user already has a live direct hold on this tier (possible only from before the waitlist formed), the entry is marked `cancelled` and the loop continues.
- When a waitlist hold expires or is released: entry → `expired` (it does not go back in the queue), then promotion runs again.
- Leaving the waitlist: `waiting` → `cancelled`; `offered` → releases the hold, entry `cancelled`, promotion runs.
- Promotion is triggered after: hold expire/release, order refund, tier capacity increase, waitlist leave. It is idempotent and safe to run concurrently or redundantly.

### 5.5 Refunds, tier edits, event cancellation

- `Orders::Refund(order)`: full refunds only. Order → `refunded`, tickets `void`, `sold_count -= n` under tier lock, gateway refund, then promotion. Promo redemptions and `redemptions_count` are unchanged. Refunding twice is a no-op with an error flash.
- Tier `capacity` may be raised freely (then promotion runs); lowering below `sold_count + held_count` is refused (`capacity_below_committed`). A `price_cents` change applies only to holds created afterwards: each hold stores `unit_price_cents` at creation and all pricing uses the hold's value.
- `Events::Cancel(event)`: event → `cancelled`; all active holds released; all open waitlist entries `cancelled`; all `paid` orders refunded; mails sent. Runs as `CancelEventJob`, processing orders in batches, each order in its own transaction; safe to re-run.

## 6. Routes

HTML (resourceful):

| Route | Notes |
|---|---|
| `GET /`, `GET /events/:id` | Published events; tier availability shown as `available`, "sold out", or "waitlist" |
| `resource :session`, `resource :registration` | Sign in/out, sign up |
| `POST /tiers/:tier_id/holds` | `quantity`; redirects to `GET /holds/:id` |
| `GET /holds/:id` | Checkout page: countdown (Stimulus), quote, promo form |
| `DELETE /holds/:id` | Release |
| `POST /holds/:id/promos`, `DELETE /holds/:id/promos/:promo_code_id` | Turbo Stream replaces the quote frame |
| `POST /holds/:id/checkout` | `payment_token` |
| `GET /orders`, `GET /orders/:number` | Own orders; tickets with codes |
| `POST /tiers/:tier_id/waitlist_entries`, `DELETE /waitlist_entries/:id` | |
| `namespace :manage` → `events` (CRUD, `publish`, `cancel`), nested `tiers`, `promo_codes`, `orders` (index, show, `refund`), `waitlist_entries` (index) | Organiser/admin |
| `namespace :admin` → `users` (index, update role) | |

JSON: `GET /api/events/:id/availability` → `{ tiers: [{ id, available, waitlist_open }] }` (public, published events only; error envelope on failure).

## 7. Background jobs

Solid Queue; all jobs take ids; all are idempotent.

| Job | Trigger | Semantics |
|---|---|---|
| `ExpireHoldJob(hold_id)` | scheduled at `expires_at` on hold creation | Calls `Holds::Expire`; no-op if hold is not active or not yet expired. `retry_on ActiveRecord::Deadlocked, ActiveRecord::LockWaitTimeout, wait: :polynomially_longer, attempts: 5`; `discard_on ActiveRecord::RecordNotFound` |
| `SweepExpiredHoldsJob` | recurring, every minute | Finds `active` holds with `expires_at <= now` in batches of 100 and expires each in its own transaction; rescues and logs per-hold errors. Backstop for lost/late `ExpireHoldJob`s |
| `PromoteWaitlistJob(tier_id)` | after capacity frees | `Waitlist::Promote`. Same retry policy |
| `SweepWaitlistJob` | recurring, every 5 minutes | Enqueues `PromoteWaitlistJob` for tiers that have `waiting` entries and `available > 0` |
| `CancelEventJob(event_id)` | event cancel | 5.5; `attempts: 3` |
| Mailer jobs | `deliver_later` | Default Active Job retry; mail failure never affects ticket state |

Jobs are enqueued after the surrounding transaction commits (`enqueue_after_transaction_commit` set to `:always` in the application job base class, or explicit `after_commit` hooks in services).

## 8. Edge cases

1. Two users concurrently hold the last 2 tickets each wanting 2: exactly one succeeds.
2. Hold quantity equal to `available` succeeds; `available + 1` fails with the available count.
3. `sold_count + held_count` never exceeds capacity; the DB check constraint is the backstop and a violation surfaces as `insufficient_capacity`, not a 500.
4. Checkout at `expires_at` exactly (now == expires_at) fails; one second before succeeds.
5. Hold expired by time but sweep not yet run: checkout and promo apply are refused; tickets remain unavailable to others until expiry runs.
6. `ExpireHoldJob` and `SweepExpiredHoldsJob` processing the same hold concurrently decrement `held_count` once.
7. Expire job racing with checkout on a hold near expiry: either the order exists and the hold is `converted`, or the hold is `expired`; never both, counts consistent.
8. `ExpireHoldJob` running early (clock skew, before `expires_at`) does nothing; the sweep later expires it.
9. Replacing a hold of 2 with 4 when only 1 more is available keeps the original hold of 2 and its original expiry.
10. Replacing a hold resets `expires_at` to now + 10 minutes only when the replacement succeeds; attached promos are dropped on replacement.
11. Double-submit of checkout: one order, one charge, one set of tickets.
12. Payment declined: hold remains active with unchanged expiry; no order, no redemption.
13. Promo with `max_redemptions = 1` attached to two users' holds: first checkout succeeds; second fails with `promo_exhausted` and can continue after removing the code.
14. Two concurrent checkouts with the last redemption of a code: one succeeds.
15. `per_user_limit` counts the user's earlier orders including refunded ones.
16. Code typed as ` summer10 ` matches `SUMMER10`.
17. Non-stackable + any other code → rejected whichever is added first.
18. Two stackable percent codes → rejected; stackable percent + stackable fixed → allowed; fixed applied after percent regardless of entry order.
19. Fixed discount larger than the remaining total → total 0, redemption `amount_cents` is the amount actually discounted; gateway not called.
20. Percent rounding: 15% of 3,333 cents = 499.95 → 500; 10% of 1,005 = 100.5 → 101.
21. Promo `ends_at` passes between apply and checkout → checkout fails with `promo_not_active`.
22. Promo restricted to tier A applied to a hold on tier B → `promo_not_applicable`; a code from another event → `promo_not_found`.
23. Join waitlist when tickets are available and no waitlist exists → refused.
24. With a non-empty waitlist, a direct hold attempt is refused even when `available > 0`.
25. FIFO strictness: entries [A wants 4, B wants 1], 2 tickets free → nobody is offered; when 2 more free → A is offered, then B if capacity remains.
26. One freed batch large enough for several entries offers all that fit in order, in one promotion run.
27. Two `PromoteWaitlistJob`s for one tier concurrently do not double-offer an entry or exceed capacity.
28. Offered hold expires → entry `expired`, next entry offered.
29. User with an offer leaves the waitlist → hold released, next entry offered.
30. Per-event cap counts live holds and paid tickets across tiers; an expired-by-time hold does not count.
31. Refund frees capacity and triggers promotion; second refund attempt changes nothing.
32. Lowering capacity below committed is refused; raising it triggers promotion.
33. Sales closed (`now >= sales_close_at`) or event cancelled: holds, waitlist joins and promotion all stop; existing live holds can still check out until they expire unless the event is cancelled.
34. Event cancel is resumable: re-running after a failure midway refunds only orders still `paid`.
35. Tier price edited while a hold exists: checkout uses the hold's stored unit price.
36. Customer requesting another user's `/holds/:id` or `/orders/:number` gets 404; organiser cannot manage another organiser's event.

## 9. Non-goals

Reserved seating, real payments, partial refunds, ticket transfer, QR scanning/check-in, multi-currency, taxes/fees, email verification, password reset, API for third parties.

## 10. Acceptance criteria

- Capacity can never be oversold under any interleaving of holds, checkouts, expiries, refunds and promotions.
- Holds stop being usable at their expiry time and their capacity is returned exactly once.
- Waitlist promotion is strictly FIFO as defined and never exceeds capacity.
- Promo totals match 5.2 exactly and redemption limits hold under concurrency.
- All edge cases in section 8 hold.

## 11. Required tests

Models/services (Minitest, `travel_to`):
- `Pricing::Quote`: each stacking rule, application order, rounding cases, floor at zero.
- Promo validity: every error code, window boundaries (`starts_at` inclusive, `ends_at` exclusive), case/whitespace normalisation.
- `Holds::Create`: limits, replace success/failure, waitlist-active refusal, per-event cap composition.
- `Holds::Expire`/`Release`: idempotence, early-run no-op.
- `Checkout::Complete`: success, expired by time, declined, promo exhausted at checkout, zero total, double submit, gateway void on post-charge failure.
- `Waitlist::Promote`: FIFO strictness, multi-offer, offer expiry cascade, leave with offer, sales closed.
- `Orders::Refund`, tier capacity edits, `Events::Cancel` re-run.

Concurrency (threads, non-transactional tests):
- N concurrent holds for limited capacity.
- Concurrent checkout vs expire on the same hold.
- Concurrent checkouts consuming the last promo redemption.
- Concurrent promotions for one tier.

Integration (controller/system-level with `ActionDispatch::IntegrationTest`):
- Full purchase flow with promo via Turbo Stream responses.
- Authorisation: 404 for foreign holds/orders/draft events; organiser scoping in `manage`.
- Availability JSON endpoint and error envelope.

Jobs: `ExpireHoldJob`, sweeps, `PromoteWaitlistJob` enqueueing after commit.

## 12. Commit plan

1. `chore`: Rails app skeleton (Gemfile, config, database/queue config, CI-ready bin scripts, compose, `.env.example`, RuboCop).
2. `feat`: authentication (User, Session, concern, sign-up) and roles/policies.
3. `feat`: events and ticket tiers — migrations with check constraints, `schema.rb`, organiser management UI.
4. `feat`: holds — create/replace/release/expire services, expiry job and sweep, customer hold page.
5. `feat`: promo codes — model, management UI, quote and apply services, Turbo quote frame.
6. `feat`: checkout — gateway interface, orders, tickets, redemptions, mailer.
7. `feat`: waitlist — join/leave, promotion service and jobs, offer mail.
8. `feat`: refunds, tier capacity edits, event cancellation job.
9. `feat`: public event pages, availability endpoint, Stimulus countdown, admin users.
10. `test`: concurrency suite and authorisation integration tests.
11. `docs`/`ci`: seeds, README, CI workflow.
