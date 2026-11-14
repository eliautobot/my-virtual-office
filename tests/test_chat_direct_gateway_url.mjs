// Legacy direct gateway transport without a configured gateway address (layer off): the chat dials the gateway
// tunnel through the office's own address. Behind HTTPS it must keep the page's host and port (a reverse proxy
// on any port), never a fixed port of one install (it used to be :8443). Plain http keeps the tunnel port the
// server reports. Real Chrome, the page served from this tree under a made-up https origin on port 9443.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { APP, launch } from './test_v10_editor_lib.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

async function dialedUrl(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
  const fixtures = {
    '/gateway-info': { transport: 'direct', gatewayUrl: '', wsPort: 18791, token: '', provider: 'office' },
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.12.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: [{ id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }] },
    '/status': { alpha: { state: 'idle', task: '' } },
  };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/vo-provider-layer.js' || url.pathname.startsWith('/provider-layer/')) {
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'layer off' });   // the layer is off
    }
    if (Object.prototype.hasOwnProperty.call(fixtures, url.pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname]) });
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel);
    if (file.startsWith(APP + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)], body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const page = await context.newPage();
  const sockets = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.VirtualOfficeChat && typeof window.VirtualOfficeChat.open === 'function', null, { timeout: 30000 });
  await page.evaluate(() => window.VirtualOfficeChat.open());
  const until = Date.now() + 15000;
  while (!sockets.length && Date.now() < until) await page.waitForTimeout(200);
  await context.close();
  return sockets[0] || '';
}

const browser = await launch('test_chat_direct_gateway_url');
try {
  const secure = await dialedUrl(browser, 'https://office.test:9443');
  assert.equal(secure, 'wss://office.test:9443/ws-gateway', 'https: the page\'s own host and port, got ' + (secure || 'no socket'));
  console.log('[PASS] https office on :9443 dials wss://office.test:9443/ws-gateway');
  const plain = await dialedUrl(browser, 'http://office.test:8090');
  assert.equal(plain, 'ws://office.test:18791/', 'http: the tunnel port the server reports, got ' + (plain || 'no socket'));
  console.log('[PASS] http office dials the reported tunnel port');
  console.log('ALL 2 direct-gateway-url checks passed');
} finally {
  await browser.close();
}
