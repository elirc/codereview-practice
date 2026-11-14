# Decisions

Short records of places where the spec was ambiguous and the choice made.

## Error envelope key casing
The shared envelope example shows `requestId`, while this project's JSON is `snake_case`. The envelope uses `request_id` so that every key the API emits follows one convention.

## Local ports
The spec fixes only the Postgres host port (5452). The API listens on 8002 and the Vite dev server on 5172, proxying `/api` to the API so the session cookie stays same-origin.

## Optimistic concurrency on line deletion
Every line change bumps the report version, and the spec asks for `expected_version` on edits. `DELETE /reports/{id}/lines/{line_id}` carries it as a required `expected_version` query parameter, since DELETE requests have no body. `DELETE /reports/{id}` takes none, as the spec lists it only for PATCH.

## Who can read exchange rates
The permissions table grants "manage exchange rates" to finance and admin and is silent on reading. Listing rates is limited to the same roles; employees see the effect of rates through the estimates on their own drafts.

## Line validation outcome for unknown currencies and future dates
Both are reported as `400 validation_failed` with the offending field path, alongside the schema errors, because the spec groups them with amount and format checks at the boundary.
