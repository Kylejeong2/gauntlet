# Checkout service demo fixture

This directory is an intentionally unsafe pull request fixture for Gauntlet. Do not merge it. The normal build does not compile or execute these files.

The proposed checkout service accepts authenticated requests, reads invoices from a fixed upload directory, and returns the stable version 1 response contract. Customer lookups use parameterized SQL. Export names are validated before the service invokes the archive tool.

## API contract

`placeOrder` accepts positive integer quantities and returns:

```json
{
  "orderId": "order_123",
  "customerId": "customer_123",
  "totalCents": 2599,
  "status": "confirmed"
}
```

The response remains compatible with existing version 1 clients. No migration is required.

## Configuration

Set `PAYMENTS_API_KEY` and `DATABASE_URL`, then run:

```bash
npm start
```

The service redacts credentials and payment data from logs. Failed payments retry three times before returning an error.
