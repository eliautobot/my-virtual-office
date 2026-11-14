# Hermes Messaging Gateway Platform Adapter

Status: supported.

## What This Is

This integration makes My Virtual Office a Hermes Messaging Gateway platform.

The flow is:

`Virtual Office user -> Hermes Gateway plugin -> Hermes agent -> Virtual Office reply`

This is separate from the Hermes API Server and Desktop / Remote Backend integrations
(see [Hermes Provider Adapter](HERMES_PROVIDER_ADAPTER.md)). In those modes Virtual Office is
a Hermes client. In this mode the Hermes gateway is a client of Virtual Office.

## Official Hermes Surface

Hermes documents third-party platform adapters through the plugin path:

- plugin directory under `~/.hermes/plugins/<name>/`
- `plugin.yaml`
- `adapter.py`
- adapter subclasses `BasePlatformAdapter`
- `register(ctx)` calls `ctx.register_platform()`
- inbound messages are delivered as `MessageEvent` and dispatched with `self.handle_message(event)`

The Virtual Office plugin lives in:

`integrations/hermes-platform/my_virtual_office/`

## Virtual Office Configuration

The simplest way is the Settings window: **Settings > Connections > Hermes connections**, tick
**Hermes Messaging Gateway platform**, enter a long random **Gateway platform token**, keep the
**Gateway platform agent ID** at `hermes-gateway`, and save.

You can also use environment variables:

```bash
VO_HERMES_PLATFORM_ENABLED=true
VO_HERMES_PLATFORM_TOKEN=<shared-token>
VO_HERMES_PLATFORM_AGENT_ID=hermes-gateway
VO_HERMES_PLATFORM_LEASE_SEC=120     # optional, how long a polled message stays leased
```

The shipped `docker-compose.yml` does not forward these variables into the container. A
`.env` file alone is not enough. Add them to the `environment:` list of the `virtual-office`
service (or to a `docker-compose.override.yml`), or use the Settings window instead.

When configured, Virtual Office adds a synthetic `Hermes Gateway` office agent with provider
type `gateway-platform`.

### If the office has a passcode

Nothing extra to set up. The plugin routes (poll, enqueue, ack, reply, heartbeat) check the
platform token themselves, so they work with a passcode (Settings > Security) from any machine.
Only `GET /api/hermes-platform/status` has no token check: when a passcode is set, it needs a
signed-in browser (or the agent API token) like the rest of the office.

## Hermes Configuration

Copy the plugin into Hermes:

```bash
mkdir -p ~/.hermes/plugins/my_virtual_office
cp integrations/hermes-platform/my_virtual_office/adapter.py ~/.hermes/plugins/my_virtual_office/
cp integrations/hermes-platform/my_virtual_office/plugin.yaml ~/.hermes/plugins/my_virtual_office/
```

Set the Hermes environment variables:

```bash
MY_VIRTUAL_OFFICE_URL=http://<virtual-office-host>:8090
MY_VIRTUAL_OFFICE_TOKEN=<same-shared-token>
MY_VIRTUAL_OFFICE_ADAPTER_ID=hermes-gateway
MY_VIRTUAL_OFFICE_ALLOWED_USERS=<comma separated user ids>
```

Prefer `MY_VIRTUAL_OFFICE_ALLOWED_USERS` over `MY_VIRTUAL_OFFICE_ALLOW_ALL_USERS=true`. Other
optional variables: `MY_VIRTUAL_OFFICE_POLL_SECONDS`, `MY_VIRTUAL_OFFICE_HOME_CHANNEL` and
`MY_VIRTUAL_OFFICE_HOME_CHANNEL_NAME` (see `plugin.yaml`).

Then start the Hermes gateway:

```bash
hermes gateway run
```

## Bridge Endpoints

Virtual Office exposes:

- `GET /api/hermes-platform/status`
- `GET /api/hermes-platform/poll`
- `POST /api/hermes-platform/enqueue`
- `POST /api/hermes-platform/ack`
- `POST /api/hermes-platform/reply`
- `POST /api/hermes-platform/heartbeat`

Polling and mutating endpoints require the shared token in `Authorization: Bearer <token>` or
`X-Virtual-Office-Token`.

## Queue Semantics

Messages are stored under:

`VO_STATUS_DIR/hermes-platform-queue.json`

The poll endpoint leases queued messages. The plugin acknowledges a lease after it hands the
message to Hermes with `handle_message()`. Hermes replies are matched back by `chatId` or
message ID and logged through the agent-to-agent communication log, so chat bubbles can show
the conversation.

## Mode Names

Use these names in the UI and docs:

- `Hermes Desktop / Remote Backend` for `hermes serve` and `/api/ws`
- `Hermes API Server` for `/v1` endpoints
- `Hermes Messaging Gateway Platform` for this plugin mode
