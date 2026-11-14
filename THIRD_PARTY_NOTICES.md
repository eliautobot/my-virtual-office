# Third-party notices

My Virtual Office is licensed under the GNU AGPL-3.0-or-later (see [LICENSE](LICENSE)). It includes or installs the
third-party components below, each under its own licence. The licence text of each one ships with it at the path shown.

## In this repository

| Component | Version | Licence | Where | Licence text |
|---|---|---|---|---|
| marked (Markdown parser) | 15.0.12 | MIT | `app/marked.min.js` | header of the file |
| Ed25519 reference code (RFC 8032, section 6) | RFC 8032 | Simplified BSD (IETF Trust) | `app/ed25519_ref.py` | header of the file |
| Inter font (latin and latin-ext subsets) | web subset | SIL Open Font License 1.1 | `app/fonts/`, `website/fonts/` | `OFL-Inter.txt` next to the fonts |
| Press Start 2P font (latin and latin-ext subsets) | web subset | SIL Open Font License 1.1 | `app/fonts/`, `website/fonts/` | `OFL-PressStart2P.txt` next to the fonts |

The fonts are WOFF2 web subsets: latin and latin-ext in `app/fonts`, latin only in `website/fonts`.

## Installed when the image is built

| Component | Version | Licence | Where in the image | Licence text |
|---|---|---|---|---|
| Node.js | 24 (from `node:24-slim`) | MIT, with the bundled licences listed in its LICENSE | `/usr/local/bin/node` | `/usr/share/doc/nodejs/LICENSE` |
| Provider layer npm packages (`@openclaw/gateway-client`, `@openclaw/gateway-protocol`, `typebox`, `ipaddr.js`, `ws`, `@novnc/novnc`) | pinned in `app/provider-layer/package-lock.json` | MIT; noVNC MPL-2.0 | `/app/provider-layer/node_modules/` | each package's own folder; see [app/provider-layer/THIRD_PARTY_NOTICES.md](app/provider-layer/THIRD_PARTY_NOTICES.md) |
| Python `websockets` | 17.0.1 | BSD-3-Clause | the image's Python site-packages | the package's own metadata |

Running without Docker installs the same npm packages with `npm ci --omit=dev` in `app/provider-layer`, and Node.js
comes from your own system.

## Code adapted from My Virtual World

`app/provider-layer` (the OpenClaw and Hermes provider layer) was copied from My Virtual World by the same authors and
relicensed under this project's AGPL-3.0 notice. See [app/provider-layer/ORIGIN.md](app/provider-layer/ORIGIN.md).
