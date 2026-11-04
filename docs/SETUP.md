# Local preview and isolated deployment

## Frontend and tests

From `mockup/`, run `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, and `npm run dev`. Tests do not connect to production. Vite development serves the frontend only; API-backed application submission and operator login require a configured serverless deployment.

## Your own integration environment

Do not connect this portfolio to the original service. Use a dedicated Google account, test calendar, spreadsheet, Notion database and nonfinancial payment destination.

1. Review `integrations/WebsiteMail.gs`. Its `operator@example.com`, generic coach labels, and other placeholders must be replaced with your own operator configuration. Deploy it in your own Apps Script project. The booking excerpt is included in WebsiteMail.gs; do not additionally paste booking-v2.gs into the same project.
2. Set the Apps Script `MAIL_WEBHOOK_SECRET`, `BOOKING_SHEET_ID`, reviewed `CALENDAR_POLICY`, and `BOOKING_V2_POLICY` properties. Use a strong independently generated secret shared only with your serverless environment. Inspect the setup functions and provider permissions before running them. Create the backing store only in your isolated project.
3. Calendar policies reference only your test calendars. Policy time zone is `Asia/Seoul`; the delivered project uses a 24-hour minimum notice, 30-day horizon, and 10-minute buffer. Publish only reviewed event configurations with valid test attachment IDs.
4. Create a restricted Notion database with the properties expected by `mockup/lib/notion.ts`. Give your integration access only to that database.
5. Configure Vercel with root directory `mockup`, build command `npm run build`, and output directory `dist`. Set the variables listed in `.env.example` in Vercel, never in Git. `APP_BASE_URL` must be your own deployment origin so private email links target your service. `GO_LIVE=false` restricts submissions to the configured operator until review is complete.
6. Register your own reviewed attachment and event content. The proprietary preparation DOCX and live email templates are not shipped as operational configuration. Review customer notices, privacy and retention obligations before enabling intake.
7. Verify login, unpaid scheduling denial, payment attestation, private-link scope, booking conflicts, notifications, expiry and recoverable cleanup using owner-controlled test data. Do not use real financial transactions for UAT.

This is not a one-command production template. Google authorization, trigger setup, quotas, Notion schema, provider accounts, privacy review and service monitoring remain deployment responsibilities.
