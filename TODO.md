# My Grafix Worker Refactor — TODO

## ✅ Completed

### 1. Config
- [x] config/constants.js

### 2. Lib (shared utilities)
- [x] lib/responses.js
- [x] lib/utils.js
- [x] lib/validation.js
- [x] lib/rateLimit.js
- [x] lib/auth.js
- [x] lib/csv.js
- [x] lib/email.js
- [x] lib/pdf.js
- [x] lib/supabase.js

### 3. Services (data access)
- [x] services/clientService.js
- [x] services/customerService.js
- [x] services/submissionService.js

### 4. Handlers (route logic)
- [x] handlers/public.js
- [x] handlers/dashboard.js
- [x] handlers/forms.js
- [x] handlers/bookings.js
- [x] handlers/orders.js
- [x] handlers/upload.js
- [x] handlers/invoices.js
- [x] handlers/export.js
- [x] handlers/search.js
- [x] handlers/claim.js
- [x] handlers/debug.js

### 5. Entry Point
- [x] worker.js (replacement)

### 6. Testing
- [x] TESTING.md with curl examples

## 🐛 Known Issues (Fixed)
1. ~~No timeout on fetch() calls — causes 504 upstream timeouts~~ **FIXED** — Added 20s AbortController
2. ~~No retry logic — transient failures crash requests~~ **FIXED** — Added 2 retries with exponential backoff
3. ~~Dashboard metrics uses limit=1000 — could miss data~~ **FIXED** — Removed limit
4. ~~No request correlation ID — impossible to trace across logs~~ **FIXED** — Added REQ-XXXX IDs
5. ~~tryEmbedLogo fetches external URLs without timeout — could hang~~ **FIXED** — Added 5s timeout on logo fetch

## ✅ Testing Checklist
- [ ] POST / (form submissions)
- [ ] GET /api/public/site
- [ ] GET /api/public/availability
- [ ] POST /api/orders
- [ ] POST /api/bookings
- [ ] POST /api/upload
- [ ] GET /api/dashboard/products
- [ ] POST /api/dashboard/products
- [ ] PUT /api/dashboard/products/:id
- [ ] DELETE /api/dashboard/products/:id
- [ ] GET /api/dashboard/metrics
- [ ] POST /api/claim-account
- [ ] POST /api/claim-account/relink
- [ ] GET /api/search
- [ ] POST /api/invoices
- [ ] POST /api/invoices/:id/send
- [ ] GET /api/export/:table
- [ ] GET /api/health
- [ ] GET /api/debug/supabase

