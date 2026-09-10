# Flux Home Assistant add-on

The add-on exposes its local API on port 8080 and stores its index, accounts, sessions, and uploaded files under `data_dir`.

The cloud relay is enabled automatically. On first startup, the add-on registers with the configured relay definition and persists the returned instance ID and tunnel token in its data directory. The relay endpoint is fixed in the application and is not an add-on option.

The add-on image currently supports `amd64` and `aarch64`. Local-only operation is supported when cloud registration is unavailable; the bridge remains idle until registration succeeds.

## Admin dashboard

The admin dashboard is only exposed through Home Assistant's Ingress: use the **Open Web UI** button on the add-on's page to open it embedded in the HA frontend. Since Ingress traffic is already authenticated by your logged-in HA session, the dashboard skips the token login step. It is not reachable directly over the exposed port (there is no standalone `/ui` path) — it lists all registered accounts, their storage usage, and whether the outbound cloud relay WebSocket is currently connected; it also lets you browse each user's file workspace (Photos/Documents/Files). The dashboard talks to these endpoints:

- `GET /api/admin/users`: admin-only, returns the account list (with per-user storage usage) plus the live cloud connection state.
- `GET /api/admin/browse?user=<name>&path=<relative>`: admin-only, lists files/folders inside a user's workspace, sandboxed to that user's root directory.

## Local vs. cloud access

Each instance can be reached two ways, using the **same account username/password** for both:

- **Cloud relay**: the instance opens an outbound WebSocket tunnel to the fixed cloud relay endpoint, authenticated with the provisioned `instance_id` and tunnel token, so mobile clients can reach it remotely through the relay.
- **Local network**: the instance's own HTTP API on port 8080 is reachable directly, e.g. `http://homeassistant.local:8080/`, with no dependency on the cloud relay. Use `FluxClient#loginLocal(baseUrl, credentials)` in the SDK to sign in locally.
