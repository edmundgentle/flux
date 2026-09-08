# Flux Home Assistant add-on

The add-on exposes its local API on port 8080 and stores its index, accounts, sessions, and uploaded files under `data_dir`.

To enable the cloud relay, configure all of these options:

- `tenant_id`: the tenant created by the cloud relay.
- `websocket_url`: the relay WebSocket endpoint, for example `wss://relay.example.com/ws`.
- `websocket_token`: the tunnel token returned during tenant registration.

The add-on image currently supports `amd64` and `aarch64`. Local-only operation is supported when relay options are empty; the bridge will remain idle until all relay options are configured.