'use strict';
// Phone (<= 600 px) sessions drawer: every control is a 44 px target (hp-qa D2: the ＋ was 34 px because
// ui-modern.css pins it with !important and hp-chat.css lost). Static check: the phone rules in hp-chat.css
// carry 44 px with !important, beat every competing !important rule by specificity, and load later.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.join(__dirname, '..', 'app');
const read = (name) => fs.readFileSync(path.join(app, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level rules and @media blocks: [{media, selectors[], decls{prop: value}}]. */
function rules(css) {
  const out = [];
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth) { if (text[j] === '{') depth += 1; else if (text[j] === '}') depth -= 1; j += 1; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, head);
      else if (!head.startsWith('@')) {
        const decls = {};
        for (const part of body.split(';')) {
          const k = part.indexOf(':');
          if (k > 0) decls[part.slice(0, k).trim()] = part.slice(k + 1).trim();
        }
        out.push({ media, selectors: head.split(',').map(s => s.trim()).filter(Boolean), decls });
      }
      i = j;
    }
  };
  walk(css, '');
  return out;
}

/** [ids, classes + attributes + pseudo-classes, elements] (enough for these selectors; :has() counts its argument). */
function specificity(selector) {
  const s = selector.replace(/:has\(([^)]*)\)/g, ' $1');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
  const elements = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+/g, ' ').match(/[a-z][\w-]*/gi) || []).length;
  return [ids, classes, elements];
}
const beats = (a, b) => { for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] > b[i]; } return true; };
const px = (value) => Number((String(value || '').match(/^(\d+(?:\.\d+)?)px/) || [])[1] || NaN);

const hp = rules(read('hp-chat.css'));
const competitors = [...rules(read('ui-modern.css')), ...rules(read('style.css'))];
const PHONE = /max-width:\s*600px/;

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log('ok - ' + name); };

check('hp-chat.css loads after ui-modern.css and style.css', () => {
  const html = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
  const at = (name) => html.search(new RegExp(`href="${name.replace('.', '\\.')}\\?`));
  assert.ok(at('hp-chat.css') > at('ui-modern.css') && at('ui-modern.css') >= 0);
  assert.ok(at('hp-chat.css') > at('style.css') && at('style.css') >= 0);
});

for (const [control, props] of [
  ['.chat-sessions-new', ['width', 'height', 'min-width', 'min-height']],
  ['.chat-session-rename', ['min-width', 'min-height']],
  ['.chat-session-delete', ['min-width', 'min-height']]
]) {
  check(`phone drawer ${control}: ${props.join(', ')} >= 44px !important, winning over every !important rule elsewhere`, () => {
    for (const prop of props) {
      const mine = hp.filter(r => PHONE.test(r.media) && r.selectors.some(s => s.includes('.chat-sessions-panel.open') && s.endsWith(control))
        && /!important/.test(r.decls[prop] || '') && px(r.decls[prop]) >= 44);
      assert.ok(mine.length, `${control} ${prop}: no phone rule with >= 44px !important`);
      const best = mine.flatMap(r => r.selectors.filter(s => s.endsWith(control)).map(specificity)).sort((a, b) => (beats(a, b) ? -1 : 1))[0];
      for (const r of competitors) {
        if (!/!important/.test(r.decls[prop] || '')) continue;
        for (const s of r.selectors.filter(x => x.endsWith(control))) {
          assert.ok(beats(best, specificity(s)), `${control} ${prop}: '${s}' (${r.decls[prop]}) is as specific`);
        }
      }
    }
  });
}

check('phone drawer delete is reachable without hover and the row leaves room for it', () => {
  const del = hp.find(r => PHONE.test(r.media) && r.selectors.some(s => s.endsWith('.chat-sessions-panel.open .chat-session-delete')));
  assert.equal(del.decls.display, 'block');
  const row = hp.find(r => PHONE.test(r.media) && r.selectors.some(s => /\.chat-session-item:has\(\.chat-session-delete\)$/.test(s)));
  assert.ok(px(row.decls['padding-right']) >= 44);
});

check('the sheet Back button stays a 44 px target', () => {
  const back = hp.find(r => PHONE.test(r.media) && r.selectors.some(s => s.endsWith('.hp-sheet-back')) && r.decls['min-height']);
  assert.ok(px(back.decls['min-height']) >= 44 && px(back.decls['min-width']) >= 44);
});

console.log(`test_hp_chat_drawer_css: ${passed} passed`);
