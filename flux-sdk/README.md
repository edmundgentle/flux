# Flux SDK

A TypeScript SDK for searching and managing files across a Flux deployment.

## Features

- Relay authentication with scoped access tokens
- Connection lifecycle management with reconnect and backoff
- Optional LAN REST calls for local Home Assistant access
- Search, upload, and download helpers

## Example

```ts
import { FluxClient } from '@flux-sdk/core';

const client = new FluxClient({
  relayUrl: 'https://relay.example.com',
  tenantId: '',
  autoConnect: false,
});

await client.login({
  username: 'me@example.com',
  password: 'a-strong-password',
});

const results = await client.search({ q: 'holiday', limit: 10 });
console.log(results);
```

Users with multiple tenants can pass `tenantId` to `login` to select one explicitly.

For direct LAN requests, set `localUseLan`, `localBaseUrl`, and a local Home Assistant session token in `localAccessToken`. Cloud relay access tokens are not valid for the local API.
