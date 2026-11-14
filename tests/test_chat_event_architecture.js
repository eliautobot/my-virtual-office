#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  TurnEventReducer,
  mergeHistoryItems,
  timestampMs,
  toolIdentity
} = require('../app/chat-events.js');

const checks = [];
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  checks.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` -- ${detail}` : ''}`);
}

function kinds(actions) {
  return actions.map(action => action.kind);
}

function feed(reducer, events) {
  return events.flatMap(event => reducer.ingest(event));
}

// Cumulative OpenClaw-style text must freeze above a tool and resume below it.
{
  const reducer = new TurnEventReducer();
  feed(reducer, [
    { kind: 'run.start', runId: 'openclaw' },
    { kind: 'text.replace', runId: 'openclaw', text: 'I will inspect the file.' }
  ]);
  const toolStart = reducer.ingest({ kind: 'tool.start', runId: 'openclaw', tool: { id: 'read-1', name: 'read', arguments: { path: '/tmp/a' } } });
  check('Tool start freezes current commentary first', kinds(toolStart).join(',') === 'text.finalize,tool.start', kinds(toolStart).join(','));
  check('Frozen commentary retains exact text', toolStart[0].text === 'I will inspect the file.');
  reducer.ingest({ kind: 'tool.result', runId: 'openclaw', tool: { id: 'read-1', name: 'read', result: 'ok', status: 'done' } });
  const resumed = reducer.ingest({ kind: 'text.replace', runId: 'openclaw', text: 'I will inspect the file.\nThe file is valid.' });
  check('Cumulative text resumes as a new suffix segment', resumed[0]?.kind === 'text.open' && resumed[0]?.text === '\nThe file is valid.', JSON.stringify(resumed));
  const terminal = reducer.ingest({ kind: 'run.complete', runId: 'openclaw' });
  check('Completion finalizes suffix before terminal cleanup', kinds(terminal).join(',') === 'text.finalize,run.terminal', kinds(terminal).join(','));
  check('Completed run records terminal state', reducer.get('openclaw')?.status === 'completed');
}

// Native providers send explicit deltas and may restart text after a tool.
for (const provider of ['hermes', 'codex', 'claude-code']) {
  const reducer = new TurnEventReducer();
  reducer.ingest({ kind: 'text.delta', runId: provider, text: 'Checking' });
  reducer.ingest({ kind: 'tool.start', runId: provider, tool: { id: `${provider}-tool`, name: 'exec' } });
  reducer.ingest({ kind: 'tool.result', runId: provider, tool: { id: `${provider}-tool`, name: 'exec', result: 'done', status: 'done' } });
  const after = reducer.ingest({ kind: 'text.delta', runId: provider, text: 'Finished' });
  check(`${provider} delta resumes below tool`, after[0]?.kind === 'text.open' && after[0]?.text === 'Finished', JSON.stringify(after));
}

// Some snapshot fallbacks restart their replace text at a tool boundary.
{
  const reducer = new TurnEventReducer();
  reducer.ingest({ kind: 'text.replace', runId: 'snapshot', text: 'Before tool' });
  reducer.ingest({ kind: 'tool.start', runId: 'snapshot', tool: { id: 't1', name: 'search' } });
  const after = reducer.ingest({ kind: 'text.replace', runId: 'snapshot', text: 'After tool' });
  check('Segment-only replacement does not erase committed commentary', reducer.get('snapshot').fullText === 'Before toolAfter tool');
  check('Segment-only replacement opens only the new segment', after[0]?.text === 'After tool');
}

// Fast tools can arrive as a result without a visible start.
{
  const reducer = new TurnEventReducer();
  reducer.ingest({ kind: 'text.replace', runId: 'fast', text: 'One moment.' });
  const actions = reducer.ingest({ kind: 'tool.result', runId: 'fast', tool: { id: 'instant', name: 'memory_get', result: 'found', status: 'done' } });
  check('Fast result synthesizes a tool start card', kinds(actions).join(',') === 'text.finalize,tool.start,tool.result', kinds(actions).join(','));
  check('Fast result preserves result payload', actions[2]?.tool?.result === 'found');
}

// Thinking is an ordered item and terminal states settle all active work.
{
  const reducer = new TurnEventReducer();
  reducer.ingest({ kind: 'text.delta', runId: 'reasoning', text: 'Preface' });
  const thought = reducer.ingest({ kind: 'thinking', runId: 'reasoning', text: 'Evaluate constraints' });
  check('Thinking freezes prior text before its card', kinds(thought).join(',') === 'text.finalize,thinking', kinds(thought).join(','));
  reducer.ingest({ kind: 'tool.start', runId: 'reasoning', tool: { id: 'long', name: 'exec' } });
  const failed = reducer.ingest({ kind: 'run.failed', runId: 'reasoning', error: 'boom' });
  check('Failed run settles running tool before terminal', kinds(failed).join(',') === 'tool.result,run.terminal', kinds(failed).join(','));
  check('Failed running tool becomes error', failed[0]?.tool?.status === 'error' && failed[0]?.tool?.error === 'boom');
  check('Failed run records terminal state', failed[1]?.status === 'failed');
}

{
  const reducer = new TurnEventReducer();
  reducer.ingest({ kind: 'tool.start', runId: 'cancel', tool: { id: 'cmd', name: 'exec' } });
  const cancelled = reducer.ingest({ kind: 'run.cancelled', runId: 'cancel' });
  check('Cancelled tool settles instead of remaining running', cancelled[0]?.tool?.status === 'done' && cancelled[0]?.tool?.result === 'Cancelled');
  check('Cancelled run emits terminal cleanup', cancelled.at(-1)?.kind === 'run.terminal' && cancelled.at(-1)?.status === 'cancelled');
}

// Cumulative SDK snapshots repeat settled tools; they must not reopen or
// re-render cards that already reached the same terminal state.
{
  const reducer = new TurnEventReducer();
  reducer.ingest({ kind: 'tool.result', runId: 'sdk-snapshot', tool: { id: 'sdk-tool', name: 'bash', status: 'done', result: 'ok' } });
  const repeated = reducer.ingest({ kind: 'tool.result', runId: 'sdk-snapshot', tool: { id: 'sdk-tool', name: 'bash', status: 'done', result: 'ok' } });
  const staleStart = reducer.ingest({ kind: 'tool.start', runId: 'sdk-snapshot', tool: { id: 'sdk-tool', name: 'bash', status: 'running' } });
  check('Repeated SDK terminal snapshot does not duplicate a tool result', repeated.length === 0, JSON.stringify(repeated));
  check('Stale SDK start cannot reopen a settled tool', staleStart.length === 0 && reducer.get('sdk-snapshot')?.tools.get('id:sdk-tool')?.status === 'done');
}

// A lifecycle end can precede the final chat payload. Late text must not duplicate.
{
  const reducer = new TurnEventReducer();
  reducer.ingest({ kind: 'text.replace', runId: 'late', text: 'The implementation is still **local and uncommitted on 8090**. Source: `memory/2026-08-' });
  reducer.ingest({ kind: 'run.complete', runId: 'late' });
  const completeText = 'The implementation is still **local and uncommitted on 8090**. Source: `memory/2026-08-06.md`';
  const late = reducer.ingest({ kind: 'text.replace', runId: 'late', text: completeText });
  check('Late final payload amends the finalized bubble in place', kinds(late).join(',') === 'text.amend' && late[0]?.text === completeText, JSON.stringify(late));
  const duplicate = reducer.ingest({ kind: 'text.replace', runId: 'late', text: completeText });
  check('Duplicate cumulative final creates no extra bubble', duplicate.length === 0, JSON.stringify(duplicate));
}

// Safe provider commentary is a completed text segment, not private reasoning.
{
  const reducer = new TurnEventReducer();
  const commentary = reducer.ingest({ kind: 'commentary', runId: 'commentary', text: 'I will inspect the exact change set.' });
  check('Commentary opens and finalizes one visible segment', kinds(commentary).join(',') === 'text.open,text.finalize', kinds(commentary).join(','));
  const tool = reducer.ingest({ kind: 'tool.start', runId: 'commentary', tool: { id: 'read-after-commentary', name: 'read' } });
  check('Tool follows commentary without reopening or duplicating it', kinds(tool).join(',') === 'tool.start', kinds(tool).join(','));
  const final = reducer.ingest({ kind: 'text.replace', runId: 'commentary', text: 'The file is valid.' });
  check('Final answer opens below commentary and tool', final[0]?.kind === 'text.open' && final[0]?.text === 'The file is valid.', JSON.stringify(final));
}

// History from transcript and recovery sources is one chronological timeline.
{
  const base = 1_780_000_000_000;
  const merged = mergeHistoryItems([
    { role: 'assistant', text: 'Commentary', ts: base + 100, tools: [] },
    { role: 'assistant', text: 'Final', ts: base + 300, tools: [] },
    { role: 'assistant', text: '', ts: base + 200, tools: [{ id: 'tool-a', name: 'read', status: 'running' }] },
    { role: 'assistant', text: '', ts: base + 250, tools: [{ id: 'tool-a', name: 'read', status: 'done', result: 'ok' }] }
  ]);
  check('Recovered activity is inserted chronologically', merged.map(item => item.text || item.tools[0]?.name).join('|') === 'Commentary|read|Final', JSON.stringify(merged));
  check('Tool result pairs with original call card', merged[1]?.tools?.[0]?.status === 'done' && merged[1]?.tools?.[0]?.result === 'ok');
  check('Paired result does not create a second tool card', merged.filter(item => item.tools?.length).length === 1);
}

{
  const base = 1_780_000_000_000;
  const stable = mergeHistoryItems([
    { role: 'user', text: 'one', ts: base, tools: [] },
    { role: 'assistant', text: 'two', ts: base, tools: [] },
    { role: 'assistant', text: 'three', ts: base, tools: [] }
  ]);
  check('Equal timestamps retain source order', stable.map(item => item.text).join(',') === 'one,two,three');
  check('ISO timestamps normalize to epoch milliseconds', timestampMs('2026-08-06T12:00:00Z') === Date.parse('2026-08-06T12:00:00Z'));
  check('Tool identity prefers stable call ids', toolIdentity({ id: 'abc', name: 'read' }) === 'id:abc');
}

// Static architecture guardrails prevent the provider-specific forks from returning.
{
  const root = path.resolve(__dirname, '..');
  const chat = fs.readFileSync(path.join(root, 'app/chat.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8');
  const modernUi = fs.readFileSync(path.join(root, 'app/ui-modern.js'), 'utf8');
  check('All native streams use one stream adapter', /streamNativeRunEvents\(provider, runId\)/.test(chat));
  check('All native events use one event adapter', /handleNativeRunEvent\(provider, eventName, data\)/.test(chat));
  check('All fallback pollers use one progress adapter', /pollNativeLiveActivity\(provider\)/.test(chat));
  check('Provider SDK stream enters the shared reducer', /handleProviderSdkEvent\(eventName, data\)[\s\S]*applyTurnEvent/.test(chat));
  check('Provider SDK terminal cleanup uses the shared reducer', /handleProviderSdkEvent\(eventName, data\)[\s\S]*kind = eventName === 'run\.completed'[\s\S]*applyTurnEvent/.test(chat));
  check('Provider runs retain explicit window and session ownership', /registerProviderRun\(runId, sessionKey/.test(chat) && /acceptsProviderRunEvent\(runId, data, eventName\)/.test(chat));
  check('OpenClaw child sessions survive roster refresh for the same agent only', /baseParts\[0\] === 'agent'[\s\S]*baseParts\[1\] === currentParts\[1\][\s\S]*return current/.test(chat));
  check('Provider sends never transmit a pending-session sentinel', /sessionId:this\.selectedProviderSessionId\(\)/.test(chat) && !/sessionId:this\.isHermesSelected\(\)/.test(chat));
  check('Provider sends preserve explicit pending-window identity', /sessionKey:providerOriginSessionKey/.test(chat) && /newSessionPending:this\.isPendingProviderSession\(\)/.test(chat));
  check('Pending provider history stays scoped to its window key', /selectedProviderHistorySessionId\(\)/.test(chat) && /params\.set\('sessionId', selectedHistorySessionId\)/.test(chat));
  check('API Hermes uses the dedicated native transport', /isNativeHermesSelected\(\)/.test(chat) && /fetch\('\/api\/hermes\/runs'/.test(chat));
  check('CLI-only Hermes stays on generic provider transport', /if \(kind === 'hermes'\) return !this\.isNativeHermesSelected\(\)/.test(chat));
  check('Native history requests the exact selected session', /const selectedSessionId = this\.selectedProviderSessionId\(\);[\s\S]*historyParams\.set\('sessionId', selectedSessionId\)/.test(chat));
  check('Native stop routes bypass the generic interrupter', /if \(this\.isGenericProviderSelected\(\)\)[\s\S]*if \(this\.isNativeHermesSelected\(\)\)/.test(chat));
  check('Late provider failures are ignored by their former window', /lateRunIgnored/.test(chat) && /if \(error\.lateRunIgnored\) return/.test(chat));
  check('OpenClaw live events enter the shared reducer', /handleChatEvent[\s\S]*applyTurnEvent/.test(chat));
  check('OpenClaw events recover safe Codex commentary in sequence', /queueOpenClawEvent\(eventName, payload\)[\s\S]*syncOpenClawCommentary/.test(chat));
  check('Duplicate reasoning is suppressed after visible text', /applyDistinctThinking\(runId, value\)[\s\S]*thinking === visibleText/.test(chat) && (chat.match(/applyDistinctThinking\(runId, thinking\)/g) || []).length >= 2);
  check('History uses shared chronological reconciliation', /renderHistoryItems\(items\)[\s\S]*ChatEvents\.mergeHistoryItems/.test(chat));
  check('Native history preserves provider message boundaries', /Provider history is already in transcript order/.test(chat) && !/let assistantTurn = \[\]/.test(chat));
  check('Tool-result roles normalize as assistant activity', /function isToolResultRole/.test(chat) && /isToolResultRole\(rawRole\)/.test(chat));
  check('Terminal cleanup is centralized', /finishRunUi\(runId, status/.test(chat));
  check('Secondary chats retile after the primary open transition', /setTimeout\(\(\) => \{[\s\S]*_tileSecondaryPanelsNow\(\);[\s\S]*_clampOpenChatPanelsToViewport\(\);[\s\S]*_positionExteriorTabs\(\);[\s\S]*\}, 320\)/.test(chat));
  check('Chat event model loads before renderer', index.indexOf('chat-events.js') > -1 && index.indexOf('chat-events.js') < index.indexOf('chat.js'));
  // Universal chat path (Hermes over `hermes serve`, design 4.x, phase B4).
  const at = name => index.indexOf(name + '?v=');
  check('Universal modules load after the reducer and before the renderer', at('chat-events.js') > -1 && at('chat-events.js') < at('chat-caps.js') &&
    at('chat-caps.js') < at('chat-universal.js') && at('chat-universal.js') < at('chat-cards.js') && at('chat-cards.js') < at('chat.js') && /hp-chat\.css/.test(index));
  check('Capability manifest gates controls with the registry as fallback', /fetch\('\/api\/agent-chat\/can\?agent='/.test(chat) && /ChatCaps\.fromRegistry\(this\.getSelectedCapabilities\(\)/.test(chat) && /applyCaps\(can, agent/.test(chat));
  check('Serve Hermes is told apart from API and CLI Hermes', /isServeHermesSelected\(\) \{[\s\S]*this\.can\.transport === 'hermes-serve'[\s\S]*includes\('serve'\)/.test(chat) &&
    /apiAvailable === 'true' && !this\.isServeHermesSelected\(\)/.test(chat) && /return !this\.isNativeHermesSelected\(\) && !this\.isServeHermesSelected\(\)/.test(chat));
  check('Serve sends take the universal route before every other path', /if \(this\.isServeHermesSelected\(\)\) \{[\s\S]*?sendServeMessage\([\s\S]*?\}\s*if \(this\.isGenericProviderSelected\(\)\)/.test(chat) && /'\/api\/agent-chat\/runs'/.test(chat));
  check('Serve stop and history use the universal routes first', /async sendStop\(\) \{\s*(?:\/\/[^\n]*\n\s*)?(?:if \(this\.queue\?\.pause\(\)\) this\.renderQueue\(\);\s*)?try \{\s*if \(this\.isServeHermesSelected\(\)\)/.test(chat) && /'\/api\/agent-chat\/stop'/.test(chat) &&
    /if \(this\.isServeHermesSelected\(\)\) \{\s*return await this\.loadServeHistory\(/.test(chat) && /'\/api\/agent-chat\/history'/.test(chat));
  check('Universal stream resumes from the snapshot seq', /'\/api\/agent-chat\/state'/.test(chat) && /this\.openChatStream\(\{ since: state\.seq \}\)/.test(chat) && /'\/api\/agent-chat\/events\?'/.test(chat) && /addEventListener\('resync'/.test(chat));
  check('Universal frames enter the shared reducer', /handleUniversalFrame\(frame\) \{[\s\S]*?this\.universal\.toReducer\(frame\)[\s\S]*?applyUniversalEvent/.test(chat) && /applyUniversalEvent\(event\) \{[\s\S]*?this\.applyTurnEvent\(event\)/.test(chat));
  check('Universal approvals use chat-cards; legacy Hermes and Codex keep their cards', /action\.kind === 'approval' && action\.provider === 'universal'/.test(chat) &&
    /ChatCards\.approvalCard\(/.test(chat) && /appendHermesPendingApproval\(action\.approval/.test(chat) && /appendCodexPendingApproval\(action\.approval/.test(chat));
  check('Answered cards settle in every window', /function settleEverywhere\(kind, id, outcome, origin\)/.test(chat) && /ChatCards\.settleApproval\(this\.messages, action\.approvalId/.test(chat));
  // C2: send while working, pickers, OpenClaw cards over the filtered chat stream.
  check('Enter / Ctrl+Enter go through the send-while-working decision (redirect, steer, local queue)',
    /submitComposer\(\{ ctrl: !!\(e\.ctrlKey \|\| e\.metaKey\) \}\)/.test(chat) && /ChatQueue\.decide\(\{/.test(chat) &&
    /queue: 'redirect'/.test(chat) && /params\.queueMode = 'followup'/.test(chat) && /this\.queue\?\.pause\(\)/.test(chat));
  check('Model and effort pickers read /models and post /prefs for this chat only',
    /'\/api\/agent-chat\/models', \{ agent: this\.chatAgentId\(\), session: this\.agentChatSession\(\) \}/.test(chat) &&
    /'\/api\/agent-chat\/prefs', null, \{ agent: this\.chatAgentId\(\), session: this\.agentChatSession\(\), \.\.\.patch \}/.test(chat));
  check('OpenClaw approvals and questions follow the filtered chat stream into the same cards',
    /view\.transport === 'openclaw' && this\.isNativeOpenClawSelected\(\)/.test(chat) && /if \(!this\.usesChatStream\(\) \|\|/.test(chat));
  check('Secondary windows drop the primary window\'s live pickers, meter, queue and lines from their clone',
    /primaryPanel\.cloneNode\(true\)[\s\S]{0,600}querySelectorAll\('\.hp-pickers, \.hp-picker-pop, \.hp-context-meter, \.hp-queue/.test(chat));
  check('chat-queue.js, chat-pickers.js, chat-media.js, chat-sidepanel.js and chat-windows.js load before chat.js',
    /<script src="chat-queue\.js[^"]*"><\/script>\s*<script src="chat-pickers\.js[^"]*"><\/script>\s*<script src="chat-media\.js[^"]*"><\/script>\s*<script src="chat-sidepanel\.js[^"]*"><\/script>\s*<script src="chat-windows\.js[^"]*"><\/script>\s*<script src="chat\.js/.test(index));
  check('Chat windows: up to four, a side button each, put away, one chat per window, restored after a reload (chat-windows.js)',
    /windowManager = globalThis\.ChatWindows \? globalThis\.ChatWindows\.createManager\(/.test(chat) &&
    /function keepChatInOneWindow\(/.test(chat) && /windowManager\.restore\(\)/.test(chat) &&
    /id="chat-window-rail"/.test(index) && /class="chat-new-window"/.test(index) && /class="chat-put-away"/.test(index));
  check('A universal run\'s end media (signed hub links) are drawn under its answer',
    /afterUniversalTerminal\(runId, action\) \{[\s\S]{0,1200}this\.attachRunMedia\(runId, action\.media\)/.test(chat)
    && /attachRunMedia\(runId, items\) \{[\s\S]{0,1200}renderChatMedia\(fresh\)/.test(chat));
  check('Media in messages go through chat-media.js (signed hub links kept, size limits, viewer)',
    /function normalizeOneChatMedia\(item\) \{\s*if \(globalThis\.ChatMedia\) return globalThis\.ChatMedia\.normalize\(item\);/.test(chat)
    && /function renderChatMedia\(media\) \{[\s\S]{0,160}globalThis\.ChatMedia\.render\(document, media\)/.test(chat));
  check('Provider settings link stays in the dock More menu', /<div id="vo-more-menu"[\s\S]*<a class="vo-menu-item" role="menuitem" href="\/providers\.html">[\s\S]*Providers<\/a>/.test(index));
}

const failed = checks.filter(item => !item.ok);
if (failed.length) {
  console.error(`FAILED: ${failed.length}/${checks.length} chat architecture checks failed`);
  process.exit(1);
}
console.log(`verify-chat-event-architecture: OK (${checks.length} checks)`);
