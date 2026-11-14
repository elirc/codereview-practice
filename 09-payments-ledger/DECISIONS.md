# Decisions

Where the SPEC left a choice open, the choice made and why.

1. **Outbox table in V1.** The commit plan adds the outbox in step 9, but `LedgerService.post` writes outbox rows from step 3, so the table ships with the first schema migration; step 9 adds the relay, publisher, purge and stats.
2. **Idempotency for `POST /settlements`.** A settlement run commits once per merchant, so it cannot share one transaction with its key. The key row is committed as `in_progress` first and completed with the response afterwards; a repeat while it is still running gets `409 invalid_state`, a non-domain failure deletes the key. If the process dies mid-run the key stays `in_progress`; the caller retries with a new key (the run itself resumes safely), and the purge job removes such keys after the 7-day retention.
3. **`GET /entries/{id}` for service and merchant keys is `403`.** The permission table grants reading entries to operator and auditor only; the "foreign id is 404" rule is applied to accounts, balances, postings and holds.
4. **Holds take a `currency` field** that must equal the wallet's and the merchant account's currency (`422 currency_mismatch`), matching the shape of transfers.
5. **FX transfer between accounts of another owner** is `422 quote_owner_mismatch`; the SPEC names no code for this case.
6. **A second account with the same owner, type and currency** is `409 invalid_state`.
7. **`GET /fx/rates?sell=&buy=` returns the current rate** for the ordered pair (404 when none) and is readable by service, operator and auditor keys.
8. **Rate input:** `midRate` is a decimal string, greater than zero, with at most 12 integer and 8 fractional digits; `spreadBps` is 0–9999 so the customer rate stays positive.
9. **Zero-amount statement lines are invalid**, since a line must be either a credit or a debit.
10. **`details.lines[].lineNo` in `statement_invalid` is the CSV record number** (the `#HEADER` record is 1); `StatementLine.lineNo` counts data lines from 1.
11. **Statement continuity:** a statement date that is not after the latest one is `422 statement_gap`; one bank account code reports in one currency, and a statement in a different currency than earlier ones for that code is `statement_invalid`.
12. **Deposit to a closed account** posts kind `deposit` from `bank_cash` to `suspense` and leaves the line `unmatched` with that entry. Resolving such a line with `deposit_to_account` moves the money from `suspense`; `to_suspense` then posts nothing.
13. **A `RET-` credit whose expectation belongs to a closed account** is left `unmatched` with a note and posts nothing.
14. **`amount_mismatch` applies to open expectations only**; a debit whose reference names a matched, returned or cancelled expectation is `unmatched` whatever its amount.
15. **Reconciliation report:** unresolved lines are filtered by booking date in the half-open range `[from, to)`; overdue expectations are all open ones older than `EXPECTATION_OVERDUE_DAYS` at request time; the bank position uses each bank account's latest statement and counts lines without a posted entry as open items.
16. **Settlement failures:** when one merchant fails, the run logs it and continues with the remaining merchants; the batch stays `processing`. Skipped items store `max(0, payable)` as their amount. `POST /settlements` answers `200` with the batch and its items.
17. **`POST /withdrawals` answers with the entry only**, like transfers; the `WDR-` reference is on the bank expectation.
18. **Status changes on system accounts** (`freeze`, `unfreeze`, `close`) are `422 invalid_account_type`.
19. **Pending lines with the same statement date and line number** are ordered by statement id after `(statementDate, lineNo)`.
20. **Stored response for `POST /api-keys` omits the secret.** The live response carries `key` once; the response kept with the idempotency key (and returned on a repeat) has the key's metadata only, so secrets never sit in the database.
21. **Seed API keys** use fixed, documented development secrets so the README can list them; keys created through the API are random 256-bit secrets.
