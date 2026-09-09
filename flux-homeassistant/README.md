# Flux Home Assistant add-on

The add-on exposes its local API on port 8080 and stores its index, accounts, sessions, and uploaded files under `data_dir`.

To enable the cloud relay, configure all of these options:

- `instance_id`: the instance created by the cloud relay.
- `websocket_url`: the relay WebSocket endpoint, for example `wss://relay.example.com/ws`.
- `websocket_token`: the tunnel token returned during instance registration.

The add-on image currently supports `amd64` and `aarch64`. Local-only operation is supported when relay options are empty; the bridge will remain idle until all relay options are configured.

## Admin dashboard

An admin-only dashboard is available at `http://<addon-host>:8080/ui`. It lists all registered accounts, their storage usage, and whether the outbound cloud relay WebSocket is currently connected; lets you view/update the cloud connection (instance ID, relay URL, tunnel token) directly from the dashboard; and lets you browse each user's file workspace (Photos/Documents/Files). Log in as an admin via `/api/auth/login`, paste the returned token into the dashboard, and connect. The dashboard talks to these endpoints:

- `GET /api/admin/users`: admin-only, returns the account list (with per-user storage usage) plus the live cloud connection state.
- `GET /api/admin/browse?user=<name>&path=<relative>`: admin-only, lists files/folders inside a user's workspace, sandboxed to that user's root directory.
- `GET /api/config` / `POST /api/config`: view/update the instance ID, relay WebSocket URL, and tunnel token used for the outbound cloud connection (update is admin-only).

## Local vs. cloud access

Each instance can be reached two ways, using the **same account username/password** for both:

- **Cloud relay**: the instance opens an outbound WebSocket tunnel to the cloud relay (`websocket_url`) authenticated with `instance_id` + the tunnel token, so mobile clients can reach it remotely through the relay.
- **Local network**: the instance's own HTTP API on port 8080 is reachable directly, e.g. `http://homeassistant.local:8080/`, with no dependency on the cloud relay. Use `FluxClient#loginLocal(baseUrl, credentials)` in the SDK to sign in locally.
