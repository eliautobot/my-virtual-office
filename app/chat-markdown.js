// Shared, safe Markdown rendering for live and historical chat messages.
((global) => {
  const SAFE_TAGS = new Set([
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'hr', 'pre', 'code', 'span', 'a',
    'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub',
    'small', 'details', 'summary', 'input'
  ]);
  // Authors never choose link targets, rel, or app CSS classes (CH-07):
  // links always open in a new tab with noopener/noreferrer (CH-23), and the
  // only classes kept are the ones the Markdown parser itself produces.
  const SAFE_ATTRS = {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    code: ['class'],
    pre: ['class'],
    ul: ['class'],
    ol: ['class', 'start'],
    li: ['class'],
    td: ['align'],
    th: ['align'],
    input: ['type', 'checked']
  };
  const URL_ATTRS = new Set(['href', 'src']);
  const SAFE_CLASS = {
    code: /^language-[A-Za-z0-9_+#.-]{1,40}$/,
    pre: /^language-[A-Za-z0-9_+#.-]{1,40}$/,
    ul: /^contains-task-list$/,
    ol: /^contains-task-list$/,
    li: /^task-list-item$/
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function decodeCodePoint(value, radix) {
    const codePoint = Number.parseInt(value, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : '';
  }

  function decodeProtocolEntities(value) {
    return String(value || '')
      .replace(/&#x([0-9a-f]+);?/gi, (_match, hex) => decodeCodePoint(hex, 16))
      .replace(/&#([0-9]+);?/g, (_match, decimal) => decodeCodePoint(decimal, 10))
      .replace(/&colon;?/gi, ':')
      .replace(/&tab;?/gi, '\t')
      .replace(/&newline;?/gi, '\n');
  }

  function isSafeUrl(value) {
    const compact = decodeProtocolEntities(value)
      .replace(/[\u0000-\u0020\u007f]+/g, '');
    const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
    return !scheme || ['http', 'https', 'mailto', 'tel'].includes(scheme);
  }

  // Images load automatically, so they get a stricter rule than links: only
  // absolute web images or this office's own chat/SMS media, never other
  // same-origin endpoints (no request beacons such as /api/... ).
  function isSafeImageUrl(value) {
    const compact = decodeProtocolEntities(value).replace(/[\u0000-\u0020\u007f]+/g, '');
    if (/^https?:\/\//i.test(compact)) return true;
    return /^\/(?:chat-media|sms-media)(?:[?/]|$)/i.test(compact);
  }

  function sanitizeHtml(html) {
    const withoutExecutableContent = String(html || '').replace(
      /<(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      ''
    );
    return withoutExecutableContent.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g, (match, tag) => {
      const lower = tag.toLowerCase();
      if (!SAFE_TAGS.has(lower)) return '';
      if (match.charAt(1) === '/') return `</${lower}>`;

      const allowed = SAFE_ATTRS[lower];
      if (!allowed) return match.endsWith('/>') ? `<${lower} />` : `<${lower}>`;

      let attrs = '';
      let hasHref = false;
      let checked = false;
      let inputType = '';
      const attrPattern = /\s([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let attribute;
      while ((attribute = attrPattern.exec(match.slice(1 + tag.length))) !== null) {
        const name = attribute[1].toLowerCase();
        const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
        if (!allowed.includes(name)) continue;
        if (lower === 'input') {
          if (name === 'type') inputType = value.toLowerCase();
          if (name === 'checked') checked = true;
          continue;
        }
        if (lower === 'img' && name === 'src' && !isSafeImageUrl(value)) continue;
        if (URL_ATTRS.has(name) && !isSafeUrl(value)) continue;
        if (name === 'class') {
          const cls = String(value).trim();
          if (!SAFE_CLASS[lower] || !SAFE_CLASS[lower].test(cls)) continue;
        }
        if ((name === 'width' || name === 'height') && !/^\d{1,4}%?$/.test(value)) continue;
        if (name === 'start' && !/^\d{1,6}$/.test(value)) continue;
        if (lower === 'a' && name === 'href') hasHref = true;
        attrs += ` ${name}="${value.replace(/"/g, '&quot;')}"`;
      }
      if (lower === 'input') {
        // Only read-only task-list checkboxes survive; no author form fields.
        if (inputType !== 'checkbox') return '';
        return `<input type="checkbox" disabled${checked ? ' checked' : ''}>`;
      }
      if (lower === 'img' && !/\ssrc="/.test(attrs)) return '';
      if (lower === 'a' && hasHref) attrs += ' target="_blank" rel="noopener noreferrer"';
      if (lower === 'img') attrs += ' loading="lazy" referrerpolicy="no-referrer"';
      return match.endsWith('/>') ? `<${lower}${attrs} />` : `<${lower}${attrs}>`;
    });
  }

  function fallbackMarkdown(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  function renderMarkdown(text) {
    if (!text) return '';
    const parser = global.marked;
    const parsed = parser && typeof parser.parse === 'function'
      ? parser.parse(String(text), { breaks: true, gfm: true })
      : fallbackMarkdown(escapeHtml(text));
    let html = sanitizeHtml(parsed);
    html = html.replace(/<img ([^>]*)>/g, '<img $1 class="chat-image-thumb chat-image-clickable">');
    html = html
      .replace(/<table>/g, '<div class="chat-table-scroll" role="region" aria-label="Scrollable table" tabindex="0"><table>')
      .replace(/<\/table>/g, '</table></div>');
    return html;
  }

  function renderMarkdownInto(target, text) {
    const html = renderMarkdown(text);
    if (target && typeof target === 'object') target.innerHTML = html;
    return html;
  }

  function decodeTextEntities(value) {
    const named = {
      amp: '&', apos: "'", colon: ':', gt: '>', lt: '<', nbsp: ' ',
      newline: '\n', quot: '"', tab: '\t'
    };
    return String(value || '')
      .replace(/&#x([0-9a-f]+);?/gi, (_match, hex) => decodeCodePoint(hex, 16))
      .replace(/&#([0-9]+);?/g, (_match, decimal) => decodeCodePoint(decimal, 10))
      .replace(/&([a-z]+);/gi, (match, name) => Object.prototype.hasOwnProperty.call(named, name.toLowerCase()) ? named[name.toLowerCase()] : match);
  }

  // Canvas bubbles cannot render HTML.  Derive their readable text from this
  // renderer's already-sanitized output so every chat surface has one trust
  // boundary and the same Markdown semantics.
  function renderPlainText(text) {
    let html = renderMarkdown(text);
    html = html
      .replace(/<img\b[^>]*\balt=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi, (_match, quoted, single, bare) => ` [${quoted ?? single ?? bare ?? 'image'}] `)
      .replace(/<input\b[^>]*\bchecked(?=\s|=|\/?>)[^>]*>/gi, '☑ ')
      .replace(/<input\b[^>]*>/gi, '☐ ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '• ')
      .replace(/<\/(?:li|p|h[1-6]|blockquote|pre|ul|ol|details|summary|tr)>/gi, '\n')
      .replace(/<\/(?:th|td)>/gi, ' | ')
      .replace(/<hr\b[^>]*>/gi, '\n—\n')
      .replace(/<[^>]+>/g, '');
    return decodeTextEntities(html)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  global.VirtualOfficeChatMarkdown = Object.freeze({
    escapeHtml,
    renderMarkdown,
    renderMarkdownInto,
    renderPlainText,
    sanitizeHtml
  });
})(globalThis);
