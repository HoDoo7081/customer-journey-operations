# Validation

## Public snapshot regression coverage

`cd mockup && npm test` executes isolated Node.js scenarios covering:

- Unpaid booking denial, 12-hour expiry and late verified-payment recovery.
- Weekend availability, coaching end-time boundary, blocked periods and booking conflicts.
- Scoped booking tokens, admin authorization and explicit payment attestation.
- Repeated requests, partial-session recovery, synchronization leases and lock contention.
- Notification recovery, duplicate-send suppression and ambiguous delivery handling.
- Exact test-deletion identity, calendar association, audit preservation, Notion archival, retry failure and same-email reapplication.
- Distinguishing duplicate applications from store errors without downstream side effects.

The scenario harness uses fixed time, in-memory Apps Script/Calendar stores and mocked external calls. It is a regression tool, not a load test or live provider certification.

## Original deployment evidence

Before this snapshot was extracted, owner-controlled live UAT verified calendar release, Notion archival, denial of a deleted booking link, authorization/confirmation guards, idempotent cleanup, a fresh same-email application, and preservation of the preexisting application baseline and operating policy. The live source was deployed to Vercel and the existing Apps Script web app. Sensitive logs and customer screenshots are intentionally excluded.

## Public snapshot checks

The sanitized copy is checked separately with regression tests, TypeScript checking, and frontend/serverless production builds. No credentials are needed for these checks. A successful local check does not mean that an arbitrary new Google/Vercel/Notion deployment has been verified.
