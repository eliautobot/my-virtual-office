import { createAgentPreviewHub } from './agent-preview-hub.mjs?v=20260817-agent-pc-r10';

let previewHub = null;

function resolveAgentAnchor(agentId) {
  const resolver = globalThis.__voResolveAgentPreviewAnchor;
  return typeof resolver === 'function' ? resolver(agentId) : null;
}

function initializeAgentPreviews() {
  if (previewHub || !document.getElementById('agentPreviewPanel') || !document.getElementById('previewBubbleContainer')) return previewHub;
  try {
    previewHub = createAgentPreviewHub({ resolveAnchor: resolveAgentAnchor });
    globalThis.__voAgentPreviewHub = previewHub;
    window.dispatchEvent(new CustomEvent('vo:agent-preview-ready', { detail: { hub: previewHub } }));
  } catch (error) {
    console.error('[Agent Preview] Failed to initialize:', error);
  }
  return previewHub;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeAgentPreviews, { once: true });
} else {
  initializeAgentPreviews();
}

window.addEventListener('resize', () => previewHub?.updatePositions());

export { initializeAgentPreviews };
