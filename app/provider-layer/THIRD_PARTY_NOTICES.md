# Third-party notices: provider layer

The OpenClaw and Hermes provider layer (app/provider-layer) installs these npm packages with `npm ci --omit=dev`.
Each package's full licence text ships inside its folder under node_modules/.

| Package | Version | Licence | Source |
|---|---|---|---|
| @openclaw/gateway-client | 2026.10.4 | MIT | https://github.com/openclaw/openclaw |
| @openclaw/gateway-protocol | 2026.10.4 | MIT | https://github.com/openclaw/openclaw |
| typebox | 1.3.34 | MIT | https://github.com/sinclairzx81/typebox |
| ipaddr.js | 2.5.0 | MIT | https://github.com/whitequark/ipaddr.js |
| ws | 8.21.3 | MIT | https://github.com/websockets/ws |
| @novnc/novnc | 1.7.0 | MPL-2.0 | https://github.com/novnc/noVNC |

noVNC is served to the browser unmodified from node_modules/@novnc/novnc (path /vendor/novnc/) for the Hermes screen
view. Its source is available at the link above, under the Mozilla Public License 2.0
(https://www.mozilla.org/en-US/MPL/2.0/).
