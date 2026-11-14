# Decisions

Short records of places where the spec was ambiguous and the choice made.

## Local ports
The spec fixes only the Postgres host port (5452). The API listens on 8002 and the Vite dev server on 5172, proxying `/api` to the API so the session cookie stays same-origin.

## Optimistic concurrency on line deletion
Every line change bumps the report version, and the spec asks for `expected_version` on edits. `DELETE /reports/{id}/lines/{line_id}` carries it as a required `expected_version` query parameter, since DELETE requests have no body. `DELETE /reports/{id}` takes none, as the spec lists it only for PATCH.

## Who can read exchange rates
The permissions table grants "manage exchange rates" to finance and admin and is silent on reading. Listing rates is limited to the same roles; employees see the effect of rates through the estimates on their own drafts.

## Line validation outcome for unknown currencies and future dates
Both are reported as `400 validation_failed` with the offending field path, alongside the schema errors, because the spec groups them with amount and format checks at the boundary.

## Employees named as manager approvers
The chain walks `manager_id` links without looking at roles, but the permissions table says employees cannot decide a manager step and can only view their own reports. A user whose current role is `employee` cannot decide a step even when named on it, and is never offered as a reassignment target. Admin reassignment is the remedy for such a step once the named user is deactivated.

## Steps of a withdrawn round
Withdrawal is allowed only while every step of the round is still pending. Those steps are marked `skipped` so the round reads as closed in the history; resubmission builds a new round.

## Reassignment targets
"The deactivated user's manager (or any active manager-role user if none)" is read as: when the deactivated approver has an active manager, that manager is the only valid target; otherwise any active user with role `manager` is. In both cases the target must not be the owner or an approver on another step of the round. Other choices return `422 invalid_reassignment`; a step whose approver is still active returns `422 approver_active`. A reassignment bumps the report version.

## Finance eligibility at submit
`no_eligible_approver` is raised exactly when no active finance user other than the owner exists, as written. A round in which the only other finance user is also a manager approver is still built; separation of duties then blocks that user from the finance step.

## Audit log scope by report
Audit events carry an extra nullable `report_id` column so that `GET /audit` can be filtered by report visibility and the report page can show one timeline. `entity_type=report&entity_id=<id>` returns the events of that report and of its lines, receipts and steps. Rate and user events have no report and are visible to finance and admin only.

## Error codes the spec leaves open
Deciding a step one is not entitled to returns `403 not_step_approver`; changing another user's report that one may view returns `403 not_report_owner`; a duplicate rate returns `409 rate_exists`; an unknown manager returns `422 unknown_manager`.

## Comparing Money across currencies
"Adding or comparing different currencies raises" is applied to equality as well as ordering, so `Money(1, "USD") == Money(1, "EUR")` raises instead of returning `False`.

## Audit trigger scope
The trigger rejects row-level `UPDATE` and `DELETE` as specified. `TRUNCATE` is not intercepted; the integration suite uses it to reset tables between tests.
