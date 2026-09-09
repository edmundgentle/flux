# Flux SDK

A TypeScript SDK for searching and managing files across a Flux deployment.

## Features

- Relay authentication with scoped access tokens, pointing at the fixed Flux cloud relay (not user-configurable)
- Account management: `login`, `register`, `logout`, and `isLoggedIn`
- Optional persistent session storage (e.g. AsyncStorage) so signed-in users stay signed in between app launches
- Automatic local-first routing: prefers the local Home Assistant instance when reachable, transparently falling back to the cloud relay otherwise, with `getTransportMode()` reporting which one is in use
- Connection lifecycle management with reconnect and backoff
- Optional LAN REST calls for local Home Assistant access
- Search, upload, and download helpers

## Example

```ts
import { FluxClient } from '@flux-sdk/core';

const client = new FluxClient({
  instanceId: '',
  autoConnect: false,
  // Optional: persist the session so the user stays logged in between app launches.
  storage: AsyncStorage,
});

// Wait for any previously persisted session to be restored before checking auth state.
await client.ready;

if (!client.isLoggedIn()) {
  await client.login({
    username: 'me@example.com',
    password: 'a-strong-password',
  });
}

const results = await client.search({ q: 'holiday', limit: 10 });
console.log(results);

// Later, to sign out:
await client.logout();
```

The client always talks to the built-in Flux cloud relay URL; it is fixed and cannot be changed by end users.

## Local-first routing

Once you've signed in to a local instance with `client.loginLocal(baseUrl, credentials)`, every request (`search`, `uploadFile`, `downloadFile`, `getConfig`) automatically prefers the local network connection and only falls back to the cloud relay if the local request fails or the instance isn't reachable. `client.getTransportMode()` returns `'local'` or `'relay'` to reflect whichever path served the most recent request.

To avoid a slow timeout when you already know the device is off the home network (e.g. on cellular data), pass a `networkMonitor` so the SDK can skip the local attempt entirely:

```ts
import NetInfo from '@react-native-community/netinfo';

const client = new FluxClient({
  instanceId: '',
  networkMonitor: {
    isOnLocalNetwork: () => null, // unknown at construction time; the SDK will still try locally first
    subscribe: (listener) => {
      const unsubscribe = NetInfo.addEventListener((state) => {
        // Treat non-Wi-Fi connections as "not on the local network".
        listener(state.type === 'wifi' ? true : state.isConnected ? false : null);
      });
      return unsubscribe;
    },
  },
});
```

`isOnLocalNetwork()` returning `null`/`true` means "try the local instance first"; returning `false` means "skip straight to the cloud relay".

Users with multiple instances can pass `instanceId` to `login` to select one explicitly.

For direct LAN requests, call `client.loginLocal(baseUrl, credentials)` (e.g. `client.loginLocal('http://homeassistant.local:8080', { username, password })`) with the *same* username/password used for the cloud account. This signs in directly against the Home Assistant instance on the local network and switches the client into LAN transport mode. The cloud relay session and the local session are independent under the hood, so `loginLocal` performs its own request, but both use the same user-supplied credentials — you do not need separate logins for cloud vs. local use.
