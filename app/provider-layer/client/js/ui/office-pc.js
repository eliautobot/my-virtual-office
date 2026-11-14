// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The chat side panel's PC tab in the office: the agent's PC is the office's own Agent PC panel. mountPc(el, { agent })
// shows one button that asks the office page to open it (bus 'vo:open-pc', the layer's agent id).
import { bus } from '../core/state.js';

export function mountPc(el, { agent = null } = {}) {
  el.innerHTML = '<div class="cw-empty"><button type="button" class="cw-btn" data-a="vo-open-pc">Open its PC in the office</button></div>';
  const onClick = e => { if (e.target.closest('[data-a="vo-open-pc"]')) bus.emit('vo:open-pc', agent); };
  el.addEventListener('click', onClick);
  return { destroy() { el.removeEventListener('click', onClick); el.innerHTML = ''; } };
}
