// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The chat window's voice in the office: My Virtual World's own (chat-voice.js, copied as it is — 🎤 dictation, 🔊 read
// aloud under every answer, 🎧 voice mode), on the voice the office's Settings → Voice sets up (the layer's
// server/voice/: who listens, who speaks, each agent's own voice from its Agent Studio, the browser's own speech when no
// service is set). What the office adds here:
// - the buttons only where they can work: 🎤 and 🎧 hidden when nothing can listen (no voice service hears this person
//   and the browser has no speech recognition of its own), 🔊 hidden when nothing can speak (no service, and the browser
//   cannot speak) — asked again whenever the window shows another agent or chat, and when Settings → Voice changes;
// - "Read every answer aloud" (Settings → Voice): an answer that ends in this window is read as if its 🔊 was pressed.
// chat-window.js hands over the same host as My Virtual World's window (el, agentId, session, input, grow, paintSend,
// toast, say, stop, run, focus, labelGlow, claimVoice).
import { attach as attachMvw } from './chat-voice.js';
import { can, options, forget } from './voice.js';

// The browser only lets a secure page use the microphone: https, or http on this same computer (localhost / 127.0.0.1).
const insecureOk = () => typeof window === 'undefined' || window.isSecureContext !== false;
const INSECURE_WORDS = () => {
  const port = (typeof location !== 'undefined' && location.port) ? ':' + location.port : '';
  return 'The browser only allows the microphone on a secure page. Open the office over https, or on the office computer at ' +
    `http://localhost${port}. (Chrome can also allow this address under chrome://flags, "Insecure origins treated as secure".)`;
};

const windows = new Set();   // every attached window's refresh (Settings → Voice changed: each asks again)

/** Settings → Voice changed something: every window asks the server again. */
export function voiceChanged() { forget(); for (const f of windows) f(); }
if (typeof window !== 'undefined') window.addEventListener('vo:voice-changed', () => voiceChanged());

export function attach(host) {
  const v = attachMvw(host);
  const root = host.el;
  const st = { canRead: true, seq: 0, closed: false, agent: undefined };
  const all = sel => root?.querySelectorAll?.(sel) || [];
  async function refresh() {
    const seq = ++st.seq, agent = host.agentId ?? null;
    st.agent = agent;
    let o = null;
    try { o = await options(agent); } catch { o = null; }
    if (seq !== st.seq || st.closed) return;
    // listening: a voice service hears this person (the browser records for it), else the browser's own recognition
    const ears = o ? (o.enabled !== false && o.listen?.source !== 'browser' ? can.record() : can.recognize()) : (can.record() || can.recognize());
    // speaking: a voice service speaks for this agent, else the browser's own voice (answers are shown, not read, when
    // the browser has none)
    const mouth = o ? (o.speak?.source !== 'browser' || can.synth()) : true;
    // A page the browser does not count as secure (plain http on another computer's address) never gets the microphone:
    // the buttons still show, and a press says why instead of failing quietly (st.insecure, the click guard below).
    st.insecure = !insecureOk() && !!(o ? o.enabled !== false : true);
    const showEars = ears || st.insecure;
    for (const b of all('.cw-mic')) if (!v.dictating && !v.voiceMode) { b.classList.toggle('hidden', !showEars); b.classList.toggle('cw-voice-insecure', st.insecure); }
    for (const b of all('.cw-vm')) if (!v.voiceMode) { b.classList.toggle('hidden', !(showEars && mouth)); b.classList.toggle('cw-voice-insecure', st.insecure); }
    const was = st.canRead;
    st.canRead = mouth;
    if (was !== mouth) for (const b of all('.cw-msg [data-a="speak"]')) b.classList.toggle('hidden', !mouth);
  }
  windows.add(refresh);
  // (capturing: runs before chat-voice.js's own handlers on 🎤 / 🎧)
  root?.addEventListener?.('click', e => {
    const b = st.insecure && e.target?.closest?.('.cw-mic, .cw-vm');
    if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation();
    host.toast?.(INSECURE_WORDS(), 'bad', 9000, '🎤');
  }, true);
  refresh();

  // "Read every answer aloud": the answer that just ended, through its own 🔊 (the window knows its message and id)
  async function autoRead(info) {
    if (v.voiceMode || v.readingId !== null || v.dictating || info?.error || !String(info?.text || '').trim()) return;
    const seq = st.seq;
    // (the choice as the server has it now — Settings → Voice in another tab too; options are kept 30 s)
    let o = null;
    try { o = await options(host.agentId ?? null); } catch { o = null; }
    if (!o?.prefs?.autoRead || !st.canRead || seq !== st.seq || st.closed) return;
    let tries = 0;
    const look = () => {
      if (seq !== st.seq || st.closed || v.voiceMode || v.readingId !== null) return;
      const list = [...all('.cw-msg.assistant[data-id]')], last = list[list.length - 1];
      const b = last?.querySelector('[data-a="speak"]');
      if (b && !b.classList.contains('hidden')) { b.click(); return; }
      if (++tries < 12) setTimeout(look, 250);   // (the window paints the finished answer just after the run's end)
    };
    setTimeout(look, 150);
  }

  return {
    get dictating() { return v.dictating; },
    get readingId() { return v.readingId; },
    get voiceMode() { return v.voiceMode; },
    get canRead() { return st.canRead; },
    finishDictation: () => v.finishDictation(), cancelDictation: () => v.cancelDictation(),
    readAloud: m => v.readAloud(m), stopReading: () => v.stopReading(), openVoiceMode: () => v.openVoiceMode(),
    onRun(type, R, info) { v.onRun(type, R, info); if (type === 'end') autoRead(info); },
    reset() { v.reset(); setTimeout(refresh, 0); },   // (after the window took its new agent or chat)
    close() { st.closed = true; windows.delete(refresh); v.close(); },
  };
}
