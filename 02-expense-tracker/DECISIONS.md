# Decisions

Short records of places where the spec was ambiguous and the choice made.

## Error envelope key casing
The shared envelope example shows `requestId`, while this project's JSON is `snake_case`. The envelope uses `request_id` so that every key the API emits follows one convention.

## Local ports
The spec fixes only the Postgres host port (5452). The API listens on 8002 and the Vite dev server on 5172, proxying `/api` to the API so the session cookie stays same-origin.
