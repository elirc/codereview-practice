# Decisions

Points the spec leaves open, the choice made, and why.

- **Schema objects outside the EF model.** Partial unique indexes, check constraints, the exclusion constraint and the two triggers are created with `migrationBuilder.Sql` and are not declared in the model, so the model snapshot lists only keys, foreign keys and plain indexes. Chosen because the spec asks for these objects as raw SQL; keeping them out of the model avoids two sources for one object.
- **Pending-model-changes check.** EF Core reports a mismatch between the model and the hand-written snapshot as a warning that is logged instead of thrown. The snapshot is maintained by hand, and a cosmetic difference should not stop `migrate` from applying the hand-written SQL.
- **Extra columns.** `plan_items.position` orders plan items (and therefore invoice lines) deterministically; `credit_notes.refund_attempts` counts refund tries for the five-try limit; `credit_balance_transactions.description` stores the reason of a manual adjustment; `created_at` is kept on products, plans, meters and tax rates. None changes a business rule.
- **Catalog reads.** The permission table does not list reading products, plans, meters and tax rates. Every role may read them, because subscribing by plan code needs them and they hold nothing sensitive; only `admin` may change them.
- **Duplicate natural keys.** A second customer with the same `externalId`, plan with the same `code` or meter with the same `code` is `409 already_exists`; the spec names no code for these.
- **Clearing a customer's region.** `PATCH /customers/{id}` treats a missing or null field as "leave unchanged", so an empty string clears `region`.
- **Customer payment token in responses.** The token is not returned; customer representations carry `hasPaymentMethod` instead.
- **Idempotency-Key format.** A missing header is `400 idempotency_key_required`; a header outside 8–128 characters is `400 validation_failed` on the `Idempotency-Key` path. Keys are scoped to the API key that sent them. `404` responses are not stored, since the spec lists only `2xx`, `409` and `422`.
- **Unknown plan code or customer on subscribe.** `404 not_found`; `422 plan_incompatible` is kept for plans that exist but are retired or in another currency.
