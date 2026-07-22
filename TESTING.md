# My Grafix Worker — Test Plan & Curl Examples

## Debug Endpoints

### GET /api/health
```bash
curl https://your-worker.workers.dev/api/health
```
**Expected:**
```json
{
  "success": true,
  "worker": true,
  "version": "1.0.0"
}
```

### GET /api/debug/supabase
```bash
curl https://your-worker.workers.dev/api/debug/supabase
```
**Expected:**
```json
{
  "success": true,
  "url": "https://your-project.supabase.co/rest/v1/clients?select=client_id&limit=1",
  "status": 200,
  "headers": { "content-type": "application/json; charset=utf-8" },
  "body": [{"client_id": "..."}],
  "timeMs": 123
}
```
**Error cases:**
- Missing SUPABASE_URL env → 502 with error
- Network timeout → 504 with error

---

## Public Endpoints

### GET /api/public/site
```bash
curl "https://your-worker.workers.dev/api/public/site?clientId=test-client-1"
```
**Expected:**
```json
{
  "success": true,
  "business": {
    "client_id": "test-client-1",
    "business_name": "Test Business",
    "logo_url": "",
    "primary_color": "",
    "secondary_color": "",
    "hero_title": "",
    "hero_subtitle": "",
    "phone": "",
    "email": "owner@test.com",
    "owner_email": "owner@test.com",
    "address": "",
    "opening_hours": "",
    "active": true,
    "business_type": "general"
  },
  "products": [],
  "services": [],
  "staff": [],
  "reviews": [],
  "gallery": []
}
```
**Error cases:**
- Missing clientId → 400 `{ "success": false, "error": "Missing clientId." }`
- Unknown/inactive client → 404 `{ "success": false, "error": "Business not found." }`

### GET /api/public/availability
```bash
curl "https://your-worker.workers.dev/api/public/availability?clientId=test-client-1&staffId=staff-123&date=2026-07-20"
```
**Expected:**
```json
{
  "success": true,
  "slots": ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"],
  "date": "2026-07-20",
  "staffId": "staff-123"
}
```
**Error cases:**
- Missing params → 400
- Invalid date format → 400
- Staff not found → 404

---

## Form Submissions

### POST / (generic form submission)
```bash
curl -X POST https://your-worker.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "test-client-1",
    "formName": "contact",
    "customer": {
      "name": "John Doe",
      "email": "john@example.com"
    },
    "fields": {
      "message": "Hello, I would like a quote.",
      "phone": "+1234567890"
    },
    "website": "example.com"
  }'
```
**Expected:**
```json
{
  "success": true,
  "submissionId": "SUB-A1B2C3",
  "receivedAt": "2026-07-20T12:00:00.000Z"
}
```
**Error cases:**
- Invalid JSON → 400
- Missing clientId → 400
- Invalid email → 400
- Unknown client → 404
- Inactive client → 403
- Rate limited → 429

---

## Orders

### POST /api/orders
```bash
curl -X POST https://your-worker.workers.dev/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "test-client-1",
    "customer": {
      "name": "Jane Doe",
      "email": "jane@example.com",
      "phone": "+1234567890"
    },
    "items": [
      { "productId": "prod-123", "qty": 2 }
    ],
    "notes": "Please gift wrap"
  }'
```
**Expected:**
```json
{
  "success": true,
  "orderId": "uuid-here",
  "orderNumber": "ORD-A1B2C3",
  "total": 49.99
}
```
**Error cases:**
- Invalid payload → 400
- Product not found → 400
- Insufficient stock → 409
- Unknown client → 404

---

## Bookings

### POST /api/bookings
```bash
curl -X POST https://your-worker.workers.dev/api/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "test-client-1",
    "customer": {
      "name": "Jane Doe",
      "email": "jane@example.com"
    },
    "serviceId": "svc-123",
    "staffId": "staff-456",
    "startTime": "2026-07-20T14:00:00Z"
  }'
```
**Expected:**
```json
{
  "success": true,
  "bookingId": "uuid-here",
  "startTime": "2026-07-20T14:00:00.000Z",
  "endTime": "2026-07-20T15:00:00.000Z"
}
```
**Error cases:**
- Missing fields → 400
- Service not found → 400
- Staff not found → 400

---

## Dashboard CRUD

### GET /api/dashboard/products
```bash
curl https://your-worker.workers.dev/api/dashboard/products \
  -H "Authorization: Bearer <supabase-jwt>"
```
**Expected:**
```json
{
  "success": true,
  "data": [ /* array of products */ ]
}
```

### POST /api/dashboard/products
```bash
curl -X POST https://your-worker.workers.dev/api/dashboard/products \
  -H "Authorization: Bearer <supabase-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "New Product",
    "price": 29.99,
    "stock_qty": 100
  }'
```
**Expected:**
```json
{
  "success": true,
  "data": { "id": "uuid-here", "client_id": "...", "name": "New Product", ... }
}
```

### PUT /api/dashboard/products/:id
```bash
curl -X PUT https://your-worker.workers.dev/api/dashboard/products/uuid-here \
  -H "Authorization: Bearer <supabase-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Product",
    "price": 39.99
  }'
```
**Expected:**
```json
{ "success": true }
```

### DELETE /api/dashboard/products/:id
```bash
curl -X DELETE https://your-worker.workers.dev/api/dashboard/products/uuid-here \
  -H "Authorization: Bearer <supabase-jwt>"
```
**Expected:**
```json
{ "success": true }
```

### GET /api/dashboard/metrics
```bash
curl https://your-worker.workers.dev/api/dashboard/metrics \
  -H "Authorization: Bearer <supabase-jwt>"
```
**Expected:**
```json
{
  "success": true,
  "data": {
    "totalProducts": 10,
    "totalCustomers": 25,
    "totalBookings": 50,
    "activeBookings": 5,
    "totalOrders": 30,
    "totalRevenue": 1500.00,
    "pendingInvoices": 3,
    "unreadSubmissions": 7,
    "todayBookings": [],
    "daily_sales": [ /* 30-day array */ ],
    "monthly_revenue": [ /* 12-month array */ ]
  }
}
```

**Error cases (all dashboard endpoints):**
- Missing/invalid JWT → 401
- No client linked → 403
- Unknown resource → 400
- Resource not found (PUT/DELETE) → 404

---

## Account Claiming

### POST /api/claim-account
```bash
curl -X POST https://your-worker.workers.dev/api/claim-account \
  -H "Authorization: Bearer <supabase-jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "businessName": "My New Business" }'
```
**Expected (new client created):**
```json
{
  "success": true,
  "status": "created",
  "client": {
    "client_id": "cli-a1b2c3",
    "auth_user_id": "auth-uuid",
    "business_name": "My New Business",
    "owner_email": "user@email.com",
    "active": true
  }
}
```

### POST /api/claim-account/relink
```bash
curl -X POST https://your-worker.workers.dev/api/claim-account/relink \
  -H "Authorization: Bearer <supabase-jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "claimCode": "ABC123" }'
```
**Expected:**
```json
{
  "success": true,
  "status": "linked",
  "client": { ... }
}
```

---

## Search

### GET /api/search
```bash
curl "https://your-worker.workers.dev/api/search?q=john" \
  -H "Authorization: Bearer <supabase-jwt>"
```
**Expected:**
```json
{
  "success": true,
  "query": "john",
  "results": [ /* search results from RPC */ ]
}
```
**Error cases:**
- Missing/invalid JWT → 401
- Query < 2 chars → 400

---

## Invoices

### POST /api/invoices
```bash
curl -X POST https://your-worker.workers.dev/api/invoices \
  -H "Authorization: Bearer <supabase-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": { "name": "Acme Corp", "email": "billing@acme.com" },
    "items": [
      { "productId": "prod-1", "description": "Consulting", "quantity": 10, "price": 100 }
    ],
    "tax": 50,
    "dueDate": "2026-08-20"
  }'
```
**Expected:**
```json
{
  "success": true,
  "invoiceId": "uuid",
  "invoiceNumber": "INV-A1B2C3",
  "total": 1050.00,
  "pdfUrl": "https://r2-url/clients/xxx/invoices/INV-A1B2C3.pdf"
}
```

### POST /api/invoices/:id/send
```bash
curl -X POST https://your-worker.workers.dev/api/invoices/uuid-here/send \
  -H "Authorization: Bearer <supabase-jwt>"
```
**Expected:**
```json
{
  "success": true,
  "invoiceId": "uuid",
  "status": "sent"
}
```

---

## Upload

### POST /api/upload
```bash
curl -X POST "https://your-worker.workers.dev/api/upload?folder=products" \
  -H "Authorization: Bearer <supabase-jwt>" \
  -H "Content-Type: image/png" \
  --data-binary "@image.png"
```
**Expected:**
```json
{
  "success": true,
  "url": "https://r2-public-url/clients/xxx/products/uuid.png",
  "key": "clients/xxx/products/uuid.png",
  "folder": "products"
}
```
**Error cases:**
- Missing/invalid JWT → 401
- Unsupported file type → 400
- Empty file → 400
- File too large → 400

---

## Export

### GET /api/export/customers
```bash
curl "https://your-worker.workers.dev/api/export/customers?from=2026-01-01&to=2026-07-20" \
  -H "Authorization: Bearer <supabase-jwt>"
```
**Expected:** CSV file download with `Content-Disposition: attachment; filename="customers-2026-07-20.csv"`

**Error cases:**
- Invalid table name → 400

---

## Rate Limiting

All POST endpoints are rate-limited:
- **Per IP:** 20 requests per 60 seconds → 429 `{ "success": false, "error": "Too many requests. Please try again shortly." }`
- **Per client:** 60 requests per 60 seconds → 429 same response
- Response includes `Retry-After` header

---

## CORS

All endpoints include:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

Preflight `OPTIONS` requests return 200 with CORS headers and no body.

