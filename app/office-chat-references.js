/* Office has no saved References service. This portable, read-only rail lists
 * explicit links in the selected conversation DOM; it never infers task state. */
(() => {
  'use strict';
  let sequence = 0;
  class ReferencesPanel {
    constructor(root) {
      root.querySelectorAll('.chat-references-rail, .chat-references-drawer').forEach(el => el.remove());
      root.classList.remove('chat-references-open');
      this.root = root; this.open = false;
      this.rail = document.createElement('button'); this.rail.type = 'button';
      this.rail.className = 'chat-references-rail'; this.rail.innerHTML = '<svg class="vo-icon" aria-hidden="true" focusable="false"><use href="#i-link"/></svg>';
      this.rail.title = 'Files and links from this chat';
      this.rail.setAttribute('aria-label', 'Open chat references');
      this.rail.setAttribute('aria-expanded', 'false');
      this.drawer = document.createElement('aside'); this.drawer.className = 'chat-references-drawer';
      this.drawer.id = `office-chat-references-${++sequence}`;
      this.drawer.setAttribute('aria-label', 'Chat references'); this.drawer.hidden = true; this.drawer.inert = true;
      this.rail.setAttribute('aria-controls', this.drawer.id);
      const head = document.createElement('div'); head.className = 'chat-tasks-head';
      const title = document.createElement('strong'); title.textContent = 'References';
      this.close = document.createElement('button'); this.close.type = 'button'; this.close.textContent = '×';
      this.close.setAttribute('aria-label', 'Close chat references'); head.append(title, this.close);
      this.content = document.createElement('div'); this.content.className = 'office-reference-body';
      this.drawer.append(head, this.content); root.querySelector('.chat-body')?.append(this.rail, this.drawer);
      this.rail.addEventListener('click', () => this.setOpen(!this.open));
      this.close.addEventListener('click', () => this.setOpen(false, true));
      this.drawer.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.setOpen(false, true); } });
      this.onOther = e => { if (e.detail?.drawer !== 'references') this.setOpen(false); };
      root.addEventListener('vw:chat-drawer-open', this.onOther);
    }
    render() {
      this.content.replaceChildren();
      const note = document.createElement('p'); note.textContent = 'Links in this loaded conversation (read-only; not a saved references library).';
      this.content.append(note);
      const seen = new Set();
      for (const source of this.root.querySelectorAll('.chat-messages a[href]')) {
        if (seen.size >= 100) break;
        try {
          const url = new URL(source.getAttribute('href'));
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
          seen.add(url.href);
          const p = document.createElement('p'), a = document.createElement('a');
          a.href = url.href; a.textContent = (source.textContent || url.href).slice(0, 500);
          a.target = '_blank'; a.rel = 'noopener noreferrer'; p.append(a); this.content.append(p);
        } catch (_) {}
      }
      if (!seen.size) { const p = document.createElement('p'); p.textContent = 'No explicit web references in the loaded conversation.'; this.content.append(p); }
    }
    setOpen(open, restoreFocus = false) {
      if (this.open === !!open) return;
      this.open = !!open;
      if (this.open) { this.root.dispatchEvent(new CustomEvent('vw:chat-drawer-open', {detail:{drawer:'references'}})); this.render(); }
      this.root.classList.toggle('chat-references-open', this.open);
      this.drawer.hidden = !this.open; this.drawer.inert = !this.open;
      this.rail.setAttribute('aria-expanded', String(this.open));
      if (this.open) this.close.focus({preventScroll:true});
      else if (restoreFocus) this.rail.focus({preventScroll:true});
    }
    clear() { this.setOpen(false); this.content.replaceChildren(); }
    destroy() { this.root.removeEventListener('vw:chat-drawer-open', this.onOther); this.rail.remove(); this.drawer.remove(); }
  }
  globalThis.OfficeChatReferences = { ReferencesPanel };
})();
