# Bubble Wash

Bubble Wash is a Next.js operations web app for Accra laundry pickup, pricing, order tracking, staff handoffs, notifications, and payment checkout.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Production environment

Use `.env.production.example` as the deployment template. Do not commit real secrets.

Required for staff auth hardening:

```bash
npm run hash-password -- "your-strong-password"
```

Payment and notification integrations:

- Paystack checkout: `PAYSTACK_SECRET_KEY`, `BUBBLEWASH_PUBLIC_URL`
- Email alerts: `RESEND_API_KEY`, `BUBBLEWASH_EMAIL_FROM`, `BUBBLEWASH_OPERATIONS_EMAIL`
- WhatsApp alerts: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`, `BUBBLEWASH_OPERATIONS_WHATSAPP`

## Integration behavior

- `/api/payments/initialize` creates a Paystack checkout in GHS and returns the secure authorization URL.
- `/api/payments/verify?reference=...` verifies Paystack payment status and appends a payment event to the order timeline.
- `/api/submit` stores bookings/onboarding/support events and attempts email/WhatsApp notifications when provider credentials are configured.
- `/api/orders/advance` appends role-scoped workflow events and attempts timeline notifications.

Missing provider credentials are reported safely in JSON responses; the app does not fake live sends.
