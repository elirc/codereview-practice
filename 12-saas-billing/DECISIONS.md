# Decisions

Points the spec leaves open, the choice made, and why.

- **Schema objects outside the EF model.** Partial unique indexes, check constraints, the exclusion constraint and the two triggers are created with `migrationBuilder.Sql` and are not declared in the model, so the model snapshot lists only keys, foreign keys and plain indexes. Chosen because the spec asks for these objects as raw SQL; keeping them out of the model avoids two sources for one object.
- **Pending-model-changes check.** EF Core reports a mismatch between the model and the hand-written snapshot as a warning that is logged instead of thrown. The snapshot is maintained by hand, and a cosmetic difference should not stop `migrate` from applying the hand-written SQL.
- **Extra columns.** `plan_items.position` orders plan items (and therefore invoice lines) deterministically; `credit_notes.refund_attempts` counts refund tries for the five-try limit; `credit_balance_transactions.description` stores the reason of a manual adjustment; `created_at` is kept on products, plans, meters and tax rates. None changes a business rule.
