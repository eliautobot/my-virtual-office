/*
 * Virtual Office chat: pictures, sound, video and files in messages (design 4.2 "Media", 2.11).
 *
 * Agents' media reach the page as links: the office's signed
 * `/api/agent-chat/media?t=...` links (Hermes and OpenClaw through the hub),
 * the older `/chat-media?path=` relay, data: URLs and web addresses.  This file
 * turns one item into what the window shows: a picture (opens in the viewer
 * with zoom, Download, Copy), a video or audio player, or a file card with its
 * size and Download.  Items bigger than what a page should play inline become a
 * file card.  No fetching here: runs under linkedom in Node tests.
 */
(function initChatMedia(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatMedia = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatMediaFactory() {
  'use strict';

  const MB = 1024 * 1024;
  // Bigger than this is offered as a file card (download) instead of shown in the chat.
  const INLINE_MAX = { image: 25 * MB, video: 40 * MB, audio: 40 * MB };
  const SIGNED_PREFIXES = ['/api/agent-chat/media?', '/chat-media', '/sms-media', '/__openclaw__'];

  function str(value, max = 4096) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  function guessMime(name, url) {
    const v = String(name || url || '').toLowerCase().split('?')[0];
    if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(v)) return 'image/*';
    if (/\.(mp4|webm|mov|m4v)$/.test(v)) return 'video/*';
    if (/\.(mp3|wav|m4a|aac|flac|opus|ogg|oga)$/.test(v)) return 'audio/*';
    if (/\.pdf$/.test(v)) return 'application/pdf';
    return '';
  }

  /** image | video | audio | file, from the mime type, the hub's `kind`, then the name. */
  function kindOf(item) {
    const mime = String(item.mimeType || '').toLowerCase();
    for (const k of ['image', 'video', 'audio']) if (mime.startsWith(k + '/')) return k;
    const hint = String(item.kind || '').toLowerCase();
    if (hint === 'image' || hint === 'video' || hint === 'audio') return hint;
    const guessed = guessMime(item.name, item.url);
    for (const k of ['image', 'video', 'audio']) if (guessed.startsWith(k + '/')) return k;
    return 'file';
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < MB) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 * MB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
    return `${(n / (1024 * MB)).toFixed(1)} GB`;
  }

  /** Links the page may use as they are (the office's own relays, data:, blob:, http(s)). */
  function isServedUrl(url) {
    if (!url.startsWith('/') || url.startsWith('//')) return true;
    return SIGNED_PREFIXES.some(prefix => url.startsWith(prefix));
  }

  /** One media item in the window's shape {url, originalUrl, name, mimeType, kind, size?}, or null. */
  function normalize(item) {
    if (!item) return null;
    if (typeof item === 'string') item = { url: item };
    if (typeof item !== 'object') return null;
    let url = str(item.url || item.path || item.filePath || item.href || item.mediaUrl || item.proxyUrl || '');
    if (!url) return null;
    const dataMatch = url.match(/^data:([^;,]+)[;,]/i);
    const dataMime = dataMatch ? dataMatch[1].toLowerCase() : '';
    let fallbackName = 'media';
    if (dataMime) fallbackName = dataMime.split('/')[0] || 'media';
    else {
      try { fallbackName = decodeURIComponent((url.split('?')[0].split('/').pop() || 'media')); } catch (_) { fallbackName = 'media'; }
      if (url.startsWith('/api/agent-chat/media?')) fallbackName = 'file';
    }
    const name = str(item.name || item.filename || item.alt, 200) || fallbackName;
    const mimeType = str(item.mimeType || item.mime || item.contentType, 120)
      || (dataMime && dataMime !== 'text/plain' ? dataMime : '')
      || (typeof item.type === 'string' && item.type.includes('/') ? item.type : '')
      || guessMime(name, url);
    // A local path on the office machine goes through the older relay; signed links stay as they are.
    const src = !isServedUrl(url) && url.startsWith('/') ? '/chat-media?path=' + encodeURIComponent(url) : url;
    const out = { url: src, originalUrl: url, name, mimeType };
    const kind = str(item.kind, 20);
    if (kind) out.kind = kind;
    out.kind = kindOf(out);
    const size = Number(item.size);
    if (Number.isFinite(size) && size >= 0) out.size = size;
    return out;
  }

  function normalizeList(items) {
    if (!items) return [];
    const list = Array.isArray(items) ? items : [items];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const item = normalize(raw);
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
    }
    return out;
  }

  /** True when the item is shown in the chat (picture, player); false: a file card. */
  function showsInline(item) {
    const max = INLINE_MAX[item.kind];
    if (!max) return false;
    return !(Number.isFinite(item.size) && item.size > max);
  }

  function el(doc, tag, cls, text) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fileCard(doc, item, note) {
    const card = el(doc, 'div', 'chat-media-file-card');
    const icon = el(doc, 'span', 'chat-media-file-icon', item.kind === 'image' ? '🖼' : item.kind === 'video' ? '🎬' : item.kind === 'audio' ? '🎵' : '📄');
    icon.setAttribute('aria-hidden', 'true');
    const body = el(doc, 'span', 'chat-media-file-body');
    const name = el(doc, 'span', 'chat-media-file-name', item.name || 'File');
    const meta = el(doc, 'span', 'chat-media-file-meta', [formatBytes(item.size), note].filter(Boolean).join(' · '));
    body.append(name, meta);
    const open = el(doc, 'a', 'chat-media-file chat-media-file-open', 'Open');
    open.href = item.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.title = `Open ${item.name || 'the file'}`;
    const save = el(doc, 'a', 'chat-media-file-download', 'Download');
    save.href = item.url;
    save.setAttribute('download', item.name || '');
    save.title = `Download ${item.name || 'the file'}`;
    card.append(icon, body, open, save);
    return card;
  }

  /** The media list under a message: one figure per item. */
  function render(doc, media) {
    const wrap = el(doc, 'div', 'chat-media-list');
    for (const item of media || []) {
      const fig = el(doc, 'figure', 'chat-media-item');
      fig.dataset.kind = item.kind || 'file';
      if (item.kind && item.kind !== 'file' && !showsInline(item)) {
        fig.appendChild(fileCard(doc, item, 'Too large to show here'));
      } else if (item.kind === 'image') {
        const img = el(doc, 'img', 'chat-image-thumb chat-image-clickable');
        img.src = item.url;
        img.alt = item.name || 'image';
        img.loading = 'lazy';
        img.dataset.mediaName = item.name || '';
        img.title = 'Open the picture';
        fig.appendChild(img);
      } else if (item.kind === 'video') {
        const video = el(doc, 'video', 'chat-media-video');
        video.src = item.url;
        video.controls = true;
        video.preload = 'metadata';
        video.setAttribute('playsinline', '');
        fig.appendChild(video);
      } else if (item.kind === 'audio') {
        const audio = el(doc, 'audio', 'chat-media-audio');
        audio.src = item.url;
        audio.controls = true;
        audio.preload = 'metadata';
        fig.appendChild(audio);
      } else {
        fig.appendChild(fileCard(doc, item, ''));
      }
      if (item.kind !== 'file' && showsInline(item) && item.name) {
        fig.appendChild(el(doc, 'figcaption', '', item.name));
      }
      wrap.appendChild(fig);
    }
    return wrap;
  }

  /**
   * The picture viewer: the picture, Zoom, Download, Copy, Close (Esc and a
   * click outside close it too).  One per page, reused.
   */
  function openViewer(doc, item, options = {}) {
    if (!doc || !item || !item.url) return null;
    let box = doc.querySelector('.hp-media-viewer');
    if (!box) {
      box = el(doc, 'div', 'hp-media-viewer');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', 'Picture');
      box.tabIndex = -1;
      const bar = el(doc, 'div', 'hp-media-viewer-bar');
      const title = el(doc, 'span', 'hp-media-viewer-title');
      const zoom = el(doc, 'button', 'hp-media-viewer-zoom', 'Zoom');
      zoom.type = 'button';
      const save = el(doc, 'a', 'hp-media-viewer-download', 'Download');
      const copy = el(doc, 'button', 'hp-media-viewer-copy', 'Copy');
      copy.type = 'button';
      const close = el(doc, 'button', 'hp-media-viewer-close', '✕');
      close.type = 'button';
      close.title = 'Close';
      close.setAttribute('aria-label', 'Close the picture');
      bar.append(title, zoom, save, copy, close);
      const stage = el(doc, 'div', 'hp-media-viewer-stage');
      const img = el(doc, 'img', 'hp-media-viewer-img');
      img.alt = '';
      stage.appendChild(img);
      box.append(bar, stage);
      const hide = () => { box.hidden = true; box.classList.remove('zoomed'); };
      box.addEventListener('click', (event) => {
        const t = event.target;
        if (t === box || t === stage || t === close) { hide(); return; }
        if (t === zoom || t === img) {
          box.classList.toggle('zoomed');
          zoom.textContent = box.classList.contains('zoomed') ? 'Fit' : 'Zoom';
          return;
        }
        if (t === copy) box._copy?.();
      });
      box.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); hide(); } });
      (doc.body || doc.documentElement).appendChild(box);
    }
    const img = box.querySelector('.hp-media-viewer-img');
    img.src = item.url;
    img.alt = item.name || 'Picture';
    box.querySelector('.hp-media-viewer-title').textContent = item.name || '';
    const save = box.querySelector('.hp-media-viewer-download');
    save.href = item.url;
    save.setAttribute('download', item.name || 'picture');
    box.querySelector('.hp-media-viewer-zoom').textContent = 'Zoom';
    box.classList.remove('zoomed');
    box._copy = () => (options.copy ? options.copy(item) : null);
    box.hidden = false;
    try { box.focus({ preventScroll: true }); } catch (_) {}
    return box;
  }

  return { INLINE_MAX, formatBytes, guessMime, isServedUrl, kindOf, normalize, normalizeList, openViewer, render, showsInline };
});
