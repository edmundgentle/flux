# Flux Home Assistant add-on

The add-on exposes its local API on port 8080 and stores its index, accounts, sessions, and uploaded files under `data_dir`.

To enable the cloud relay, configure all of these options:

- `tenant_id`: the tenant created by the cloud relay.
- `websocket_url`: the relay WebSocket endpoint, for example `wss://relay.example.com/ws`.
- `websocket_token`: the tunnel token returned during tenant registration.

The add-on image currently supports `amd64` and `aarch64`. Local-only operation is supported when relay options are empty; the bridge will remain idle until all relay options are configured.

## Admin dashboard

An admin-only dashboard is available at `http://<addon-host>:8080/ui`. It lists all registered accounts, shows whether the outbound cloud relay WebSocket is currently connected, and lets you browse each user's file workspace (Photos/Documents/Files). Log in as an admin via `/api/auth/login`, paste the returned token into the dashboard, and connect. The dashboard talks to two new endpoints:

- `GET /api/admin/users`: admin-only, returns the account list plus the live cloud connection state.
- `GET /api/admin/browse?user=<name>&path=<relative>`: admin-only, lists files/folders inside a user's workspace, sandboxed to that user's root directory.
