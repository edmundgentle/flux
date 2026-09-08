# Flux Cloud Relay

This project provides the multi-tenant relay layer for Flux. It exposes a secured public API and maintains persistent WebSocket tunnels keyed by tenant.

## Features

- scoped bearer-token REST endpoints
- self-service registration and login backed by PostgreSQL
- tenant-aware token validation
- active tunnel registry keyed by tenant_id
- outbound relay socket registration from local HA boxes
- proxy request/response envelopes for remote request forwarding

## Quick start

1. Set `DATABASE_URL` to a PostgreSQL instance; tables are created automatically on startup.
2. Start the relay:

```bash
npm install
npm run dev
```

## Registering a tenant

New users register themselves. Registration creates a user account, a tenant, a one-time Home Assistant tunnel token, and a scoped app access token:

```bash
curl -X POST "http://localhost:3000/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"a-strong-password","label":"Primary Home"}'
```

Existing users can log in. The response includes every tenant label and ID; pass
`tenant_id` in the login body to select a specific tenant:

```bash
curl -X POST "http://localhost:3000/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"a-strong-password","tenant_id":"TENANT_ID"}'
```

## Public API example

```bash
curl "http://localhost:3000/api/search?tenant_id=TENANT_ID&q=*" \
  -H "Authorization: Bearer APP_ACCESS_TOKEN"
```

The WebSocket endpoint is exposed on `/ws` and expects:

- Home Assistant tunnels use `X-Tenant-Id` and `X-Tenant-Token` headers.
- Mobile clients use `tenant_id` plus an `Authorization: Bearer APP_ACCESS_TOKEN` header.
- Mobile clients first call `POST /api/auth/ws-ticket` with the bearer access token and `x-tenant-id` header.
- Mobile WebSockets use `tenant_id` and the short-lived `ws_ticket` query parameter because browser WebSockets cannot set headers.
