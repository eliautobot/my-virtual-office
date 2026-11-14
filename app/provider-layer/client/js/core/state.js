// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The provider layer's client state in the office (replaces My Virtual World's city state): one event bus, the agents the
// chat window can talk to, and who is at work. The office page fills S.agentList from GET /api/pl/agents and presence
// from the layer's agent.activity; select(i) asks the office to show that agent (the page listens to 'vo:select').
import { Emitter } from './util.js';

export const bus = new Emitter();
export const S = {
  /** The layer's agents (GET /api/pl/agents): { id, key, name, emoji, level, i, ... }; i: the office desk index or -1. */
  agentList: [],
  /** The office has no city bodies: people stay empty, so the chat window shows no "show in the world" button. */
  people: [],
  /** agent key -> { state, ... } from agent.activity. */
  presence: {},
};

/** Shows agent i in the office (the page pans to its desk). */
export function select(i, opts = {}) {
  bus.emit('vo:select', i, opts);
}

/** The office page sets the roster; the chat windows refresh their agent lists. */
export function setAgents(list) {
  S.agentList = Array.isArray(list) ? list : [];
  bus.emit('agentlist', S.agentList);
}
