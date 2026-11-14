# OpenClaw Provider

> **Version 0.11:** OpenClaw now runs on the integration copied from My Virtual World (on by default). How to
> connect and pair is in the [README](../README.md#connect-your-openclaw), and what changed is in the
> [0.11.0 release notes](RELEASE-NOTES-0.11.0.md). This page describes the 0.10 path, which
> `VO_PROVIDER_LAYER=0` keeps for this release.

Virtual Office connects to OpenClaw through its gateway (default `ws://127.0.0.1:18789`) and the
mounted OpenClaw home folder. The gateway gives live chat, activity, approvals, questions, tasks and
the agents' browser; the home folder lets the office discover agents and read safe profile data.
Setup of the mount and the `VO_GATEWAY_*` / `VO_OPENCLAW_*` variables is in the
[README](../README.md#openclaw).

## The connection

OpenClaw has one connection, managed on the **Agent Providers** page (`/providers.html?provider=openclaw`,
also reached from **Settings > Connections > Manage in Agent Providers**). It has **Edit**, **Test**
(never saves) and **Reconnect**; there is no Add or Remove.

| Field | What to enter |
|---|---|
| Gateway address | `ws://127.0.0.1:18789` by default. From another machine use its address (`wss://` through a secure proxy). |
| Gateway token | On the gateway's machine: `openclaw config get gateway.auth.token`. Left blank, the office keeps the saved one or reads it from OpenClaw's own settings ("Read from OpenClaw's own settings"). The token stays on the office server and never reaches a browser. |
| Access | "Full access: chat and settings" or "Chat only" (below). |

When the gateway is down the page says "The gateway is not answering." with the fix "Check that
OpenClaw's gateway is running at this address; the office keeps trying by itself." A wrong token
says "The gateway refused the token." and "Enter the gateway token again (Edit)."

## Access levels

The access level decides which gateway scopes the office asks for. Chat only asks for
`operator.read`, `operator.write`, `operator.approvals` and `operator.questions`. Full access adds
`operator.admin`.

**Both levels:** chat, stop, follow-ups, attachments, model and effort per chat, approvals and
questions in the chat, the sessions drawer (new chat, rename), the side panel Tasks tab, reading the
agents' files, the task progress card, and the read tabs of OpenClaw's menu (Overview without system
info, Agents, Sessions).

**Full access only:**

- The side panel **Browser** tab.
- Writing the agents' workspace files (SOUL, AGENTS and the other profile documents).
- Deleting chats from the drawer (the main chat can never be deleted from here).
- Every change in OpenClaw's menu, and its admin reads (Approvals defaults, grants, system info).
- The office's own OpenClaw writes: cron changes on the Cron jobs page (add, update, remove, run),
  creating, editing and deleting OpenClaw agents, model and key saves on the Models page, skill
  installs and skill workshop actions, and gateway origin changes.

Under Chat only these answer 403 `chat_only` with a plain sentence such as "This connection has Chat
only access: OpenClaw's settings are not changed from here." and the fix "Open Agent Providers, Edit
the connection and choose Full access." Locked side panel tabs show the same text.

## Chat window

The chat window turns features on from the office's capability manifest
(`/api/agent-chat/can`, see [Provider SDK](PROVIDER-SDK.md#chat-capability-manifest)), so OpenClaw
agents get exactly what their gateway offers.

- **Approvals:** when an agent asks to run a command, a card shows the command and the choices
  **Allow once**, **Always allow** and **Deny**. Answering in one window settles the card in every
  window; a card answered elsewhere says "Already answered".
- **Questions:** questions from the agent appear as a card with its options (and "Other" when
  allowed). The answer goes back to the agent at once.
- **Model and effort pickers:** above the composer. The model list comes from the gateway (with
  search; models with the same name show their ids). Effort runs from Low to Max. Both apply to
  this chat only.
- **Context meter:** how full the chat's context is.
- **Sessions drawer:** every chat of the agent with its age, a blue dot while it is working and an
  orange dot while it waits for you. New chat and Rename are there; Delete needs Full access.
- **Send while working:** Enter sends a message that steers the running answer; Ctrl+Enter (Cmd on a
  Mac) queues it for after. Queued messages show as chips you can edit, delete or send now.
- **Task progress card:** OpenClaw's own task card stays in the progress panel above the chat.
- **Media:** pictures, audio and video the agent sends show inline (pictures up to 25 MB, audio and
  video up to 40 MB); other files become a card with Open and Download.

## Side panel

- **Tasks:** the agent's tasks and subagents, for this chat or all chats of the agent, with Stop.
- **Browser** (Full access): the agents' browser through the gateway. Tabs, an address bar with
  back, forward and reload, clicks, typing and scrolling. The picture is a frame polled about once a
  second while the tab is shown (tab state every 5 seconds); there is no live video stream in this
  release. Local addresses are refused before any call ("OpenClaw's gateway does not open local
  addresses."). The gateway saves each frame as a file on its own machine; the office reads it only
  from OpenClaw's media folder, so when the container cannot see that folder the tab says "The
  gateway's picture of this tab is not reachable from the office."
- **Files:** the agent's workspace files and documents, read at both levels; saving needs Full
  access.

## Proxy and direct browser mode

`VO_OPENCLAW_BROWSER_TRANSPORT` picks how the office page reaches the gateway.

- `proxy` (the default): the browser never talks to the gateway. Chat and events go through the
  office's `/api/openclaw/rpc` and `/api/openclaw/events`, the token stays on the server, and every
  call is checked, so Chat only is enforced.
- `direct` (older mode): the page opens a raw WebSocket tunnel to the gateway on `VO_WS_PORT`. The
  office cannot check calls made through that tunnel, so **Chat only can be bypassed in direct
  mode**: there it is a convenience lock, not a security boundary. Use proxy mode when Chat only
  must hold.
