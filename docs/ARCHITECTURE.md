# Architecture and operating decisions

React frontend → Vercel serverless API → HMAC-signed Google Apps Script receiver → Sheets, Calendar, Mail and Drive. The serverless layer also synchronizes application state to Notion.

## Boundaries

- The browser receives public event data and record-scoped scheduling links. Administrative mutations require an authenticated session.
- The API signs bridge payloads; shared credentials remain server-side. Private scheduling links are scoped to an application.
- Apps Script owns serialized booking decisions and persisted application state. Calendar availability is checked before reservation.
- Notion is an operations projection, not the authority for payment or booking.

## State and recovery

A typical record progresses from `awaiting_payment` to `awaiting_schedule` to `confirmed`. An unverified record may expire. Verified late payment can restore the scheduling path. See the source for additional review, partial-session and notification states.

Stable IDs, provider-level locks, sync leases, and explicit retry states address repeated requests and partial failures. They do not create a distributed transaction across Google and Notion. Ambiguous mail delivery requires review; successful provider submission does not prove inbox receipt.

Test cleanup transitions through `test_deleting` to `test_deleted`. Calendar events must match the application ID before removal. Notion records are archived, and original data plus deletion evidence remain. Completed test records no longer block fresh applications with the same email. Financial refunds and already-sent messages are outside the cleanup flow.

## Trade-offs

A spreadsheet-backed store and Apps Script made the workflow practical for a small operator, with Google quotas, lock contention and storage limitations. Larger deployments would need measured capacity planning, a transactional database, durable work queues, richer monitoring, and a reviewed retention/erasure process. Those capabilities are not claimed as implemented here.

The integrated Apps Script file includes the booking logic also stored in `booking-v2.gs`. Changing booking behavior requires keeping them consistent; this snapshot preserves the delivery structure rather than introducing an unverified backend refactor.
