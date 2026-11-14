// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// Where the office shows My Virtual World's voice choices (voice-settings.js, copied): Settings → Voice (the office's
// Settings window, ui-modern.js category 'voice') and the agent's voice in its Agent Studio (v10-studio.js, Voice tab).
// Both are drawn into a box of the office's page (.pl-voice, styled by pl-voice.css); every choice is saved on the
// server at once (POST /api/voice/prefs, /api/voice/settings, /api/voice/agent, /api/connections), and the chat windows
// are told (vo:voice-changed: their 🎤 / 🔊 / 🎧 follow).
import { post } from '../core/net.js';
import { auth } from '../core/auth.js';
import { esc } from '../core/util.js';
import { voiceTab, agentVoiceSection } from './voice-settings.js';
import { forget } from './voice.js';

const changed = () => { forget(); try { window.dispatchEvent(new CustomEvent('vo:voice-changed')); } catch { /* old browser */ } };

/** Settings → Voice into `host`. app: { toast(text, kind, ms) }. */
export async function mountVoiceSettings(host, app) {
  if (!host) return;
  host.innerHTML = '<div class="pl-voice"><p class="err hidden" role="alert"></p><div class="pl-voice-body"></div></div>';
  const box = host.firstElementChild;
  const d = { q: s => box.querySelector(s) };
  if (!auth.me) await auth.refresh();   // (what this person may change: GET /api/pl/me)
  // (every saved choice also tells the chat windows: the toast is what the tab shows when it saved)
  const toast = (m, kind, ms) => { if (kind === 'good') changed(); app?.toast?.(m, kind, ms); };
  await voiceTab(d, box.querySelector('.pl-voice-body'), { toast });
}

/** The agent's voice (layer agent `agent`: { id, name }) into `host`: its owner's choice of service, voice and speed. */
export async function mountAgentVoice(host, agent, app) {
  if (!host) return;
  host.innerHTML = '<div class="pl-voice pl-voice-agent"><div class="pl-voice-sec"></div></div>';
  const el = host.querySelector('.pl-voice-sec');
  if (!agent) { el.innerHTML = '<p class="hint">This agent has no voice here yet: it gets one when it can chat in the chat window.</p>'; return; }
  const C = {
    id: agent.id, name: agent.name || 'This agent',
    async call(url, body, msg) {
      try { const r = await post(url, body); changed(); app?.toast?.(msg, 'good'); return r; } catch (e) { if (!e.quiet) app?.toast?.(e.message || 'It was not saved', 'bad'); return null; }
    },
  };
  await agentVoiceSection(C, el);
  // (agentVoiceSection removes its box for one who may not manage the agent)
  if (!host.querySelector('.pl-voice-sec')) host.innerHTML = `<div class="pl-voice"><p class="hint">Only the office's owner chooses ${esc(C.name)}'s voice.</p></div>`;
}
