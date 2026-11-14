/* Virtual Office access helper (v0.8, contract C1).
 *
 * - Wraps window.fetch: a 401 {error:"auth_required"} from the office sends the
 *   browser to /login.html and comes back here after the passcode is entered.
 * - window.VOAuth.status()          -> Promise<{protected, authenticated, viaLoopback, canManage}>
 * - window.VOAuth.mountSettings(el) -> renders the "Office passcode" card into el.
 * - window.VOAuth.logout()          -> ends this browser's session.
 * No data from the server is ever inserted as HTML.
 */
(function () {
  'use strict';
  if (window.VOAuth && window.VOAuth.__v08) return;

  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  var redirecting = false;

  function loginUrl() {
    var here = location.pathname + location.search + location.hash;
    return '/login.html?next=' + encodeURIComponent(here || '/');
  }

  function goToLogin() {
    if (redirecting || /\/login(\.html)?$/.test(location.pathname)) return;
    redirecting = true;
    location.assign(loginUrl());
  }

  function sameOrigin(input) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      return new URL(url, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  if (nativeFetch) {
    window.fetch = function (input, init) {
      return nativeFetch(input, init).then(function (res) {
        if (res && res.status === 401 && sameOrigin(input)) {
          res.clone().json().then(function (body) {
            if (body && body.error === 'auth_required') goToLogin();
          }).catch(function () {});
        }
        return res;
      });
    };
  }

  function api(path, body) {
    var opts = { credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return (nativeFetch || window.fetch)(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        data = data || {};
        data._httpStatus = res.status;
        return data;
      });
    });
  }

  function status() {
    return api('/api/access/status');
  }

  function logout() {
    return api('/api/access/logout', {}).then(function () {
      location.assign('/login.html');
    });
  }

  // ── Settings card ─────────────────────────────────────────────────────
  var STYLE_ID = 'vo-auth-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.vo-auth-card{display:flex;flex-direction:column;gap:var(--vo-space-3,12px);font-family:var(--vo-font-ui,system-ui,sans-serif);font-size:var(--vo-text-md,14px);color:var(--vo-text-1,#eee)}',
      '.vo-auth-state{display:flex;align-items:center;gap:var(--vo-space-2,8px);font-weight:var(--vo-weight-medium,550)}',
      '.vo-auth-dot{width:10px;height:10px;border-radius:50%;background:var(--vo-text-3,#888);flex:none}',
      '.vo-auth-dot.on{background:var(--vo-success,#3fb950)}',
      '.vo-auth-dot.off{background:var(--vo-warning,#d29922)}',
      '.vo-auth-form{display:flex;flex-direction:column;gap:var(--vo-space-2,8px);max-width:420px}',
      '.vo-auth-form label{font-size:var(--vo-text-sm,13px);color:var(--vo-text-2,#ccc)}',
      '.vo-auth-form input{min-height:var(--vo-control-h,36px);padding:0 var(--vo-space-3,12px);border-radius:var(--vo-radius-sm,8px);border:var(--vo-border-w,1px) solid var(--vo-border-strong,#567);background:var(--vo-surface-1,#111);color:var(--vo-text-1,#eee);font:inherit}',
      '.vo-auth-row{display:flex;flex-wrap:wrap;gap:var(--vo-space-2,8px)}',
      '.vo-auth-card button{min-height:var(--vo-control-h,36px);padding:0 var(--vo-space-4,16px);border-radius:var(--vo-radius-sm,8px);border:var(--vo-border-w,1px) solid var(--vo-border-strong,#567);background:var(--vo-surface-3,#223);color:var(--vo-text-1,#eee);font:inherit;cursor:pointer}',
      '.vo-auth-card button.primary{background:var(--vo-accent,#4f8cff);color:var(--vo-accent-ink,#fff);border-color:transparent}',
      '.vo-auth-card button.danger{border-color:var(--vo-danger,#f85149);color:var(--vo-danger,#f85149);background:transparent}',
      '.vo-auth-card button:focus-visible,.vo-auth-form input:focus-visible{outline:none;box-shadow:var(--vo-focus,0 0 0 2px #4f8cff)}',
      '.vo-auth-msg{min-height:1.2em;font-size:var(--vo-text-sm,13px);color:var(--vo-text-2,#ccc)}',
      '.vo-auth-msg.error{color:var(--vo-danger,#f85149)}',
      '.vo-auth-msg.ok{color:var(--vo-success,#3fb950)}',
      '.vo-auth-hint{margin:0;font-size:var(--vo-text-sm,13px);color:var(--vo-text-3,#999);line-height:var(--vo-leading,1.5)}',
      '.vo-auth-token{font-family:var(--vo-font-mono,monospace);font-size:var(--vo-text-sm,13px);word-break:break-all;padding:var(--vo-space-2,8px);border-radius:var(--vo-radius-sm,8px);background:var(--vo-surface-2,#181818);border:var(--vo-border-w,1px) solid var(--vo-border-subtle,#333)}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'className') node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    if (text != null) node.textContent = text;
    return node;
  }

  var uid = 0;
  function field(form, label, autocomplete) {
    var id = 'vo-auth-f' + (++uid);
    form.appendChild(el('label', { for: id }, label));
    var input = el('input', { id: id, type: 'password', autocomplete: autocomplete, spellcheck: 'false' });
    form.appendChild(input);
    return input;
  }

  function errorText(data) {
    if (!data) return 'Something went wrong. Try again.';
    if (data.error === 'bad_passcode') return 'That passcode is not right.';
    if (data.error === 'too_many_attempts') return 'Too many tries. Wait a few minutes and try again.';
    if (data.error === 'forbidden') return 'Only someone signed in to this office can change the passcode.';
    return data.message || 'Something went wrong. Try again.';
  }

  function mountSettings(container) {
    if (!container) return Promise.resolve();
    ensureStyle();
    container.textContent = '';
    var card = el('div', { className: 'vo-auth-card' });
    container.appendChild(card);
    card.appendChild(el('p', { className: 'vo-auth-hint' }, 'Checking access settings...'));

    return status().then(function (st) {
      card.textContent = '';
      var state = el('div', { className: 'vo-auth-state', role: 'status' });
      var dot = el('span', { className: 'vo-auth-dot ' + (st.protected ? 'on' : 'off'), 'aria-hidden': 'true' });
      state.appendChild(dot);
      state.appendChild(document.createTextNode(st.protected
        ? 'Passcode is on. Other devices must enter it once.'
        : 'No passcode. Anyone who can reach this office on your network can use it.'));
      card.appendChild(state);

      if (!st.canManage) {
        card.appendChild(el('p', { className: 'vo-auth-hint' }, 'Sign in with the office passcode to change these settings.'));
        return;
      }

      var form = el('form', { className: 'vo-auth-form', novalidate: 'novalidate' });
      var current = null;
      if (st.protected && !st.viaLoopback) current = field(form, 'Current passcode', 'current-password');
      var next = field(form, st.protected ? 'New passcode' : 'Passcode', 'new-password');
      var again = field(form, 'Type it again', 'new-password');
      var msg = el('div', { className: 'vo-auth-msg', role: 'status', 'aria-live': 'polite' });
      var row = el('div', { className: 'vo-auth-row' });
      var save = el('button', { type: 'submit', className: 'primary mm-btn' }, st.protected ? 'Change passcode' : 'Turn on passcode');
      row.appendChild(save);
      var remove = null;
      if (st.protected) {
        remove = el('button', { type: 'button', className: 'danger mm-btn' }, 'Remove passcode');
        row.appendChild(remove);
      }
      form.appendChild(row);
      form.appendChild(msg);
      card.appendChild(form);
      card.appendChild(el('p', { className: 'vo-auth-hint' },
        'This computer and your agents calling the office locally never need the passcode. ' +
        'Sessions last 30 days per browser. Changing the passcode signs out every other device.'));

      function setMsg(text, kind) {
        msg.textContent = text || '';
        msg.className = 'vo-auth-msg' + (kind ? ' ' + kind : '');
      }

      function submit(nextValue) {
        save.disabled = true;
        if (remove) remove.disabled = true;
        return api('/api/access/passcode', { current: current ? current.value : '', next: nextValue })
          .then(function (data) {
            if (!data.ok) { setMsg(errorText(data), 'error'); return; }
            setMsg(nextValue ? 'Passcode saved.' : 'Passcode removed.', 'ok');
            setTimeout(function () { mountSettings(container); }, 900);
          })
          .catch(function () { setMsg('Could not reach the office. Try again.', 'error'); })
          .then(function () { save.disabled = false; if (remove) remove.disabled = false; });
      }

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (next.value.length < 4) { setMsg('Use at least 4 characters.', 'error'); next.focus(); return; }
        if (next.value !== again.value) { setMsg('The two passcodes do not match.', 'error'); again.focus(); return; }
        submit(next.value);
      });
      if (remove) {
        remove.addEventListener('click', function () {
          var ask = window.VOUI && typeof window.VOUI.confirm === 'function'
            ? window.VOUI.confirm({ title: 'Remove the passcode?', body: 'Anyone who can reach this office on your network will be able to use it.', okLabel: 'Remove', danger: true })
            : Promise.resolve(window.confirm('Remove the passcode? Anyone on your network will be able to use the office.'));
          ask.then(function (ok) { if (ok) submit(''); });
        });
      }

      if (st.protected) {
        var tokenWrap = el('div', { className: 'vo-auth-form' });
        tokenWrap.appendChild(el('label', {}, 'Agent API token'));
        tokenWrap.appendChild(el('p', { className: 'vo-auth-hint' },
          'Agents that call the office from another machine send this as "Authorization: Bearer <token>". Local agents do not need it.'));
        var tokenBox = el('div', { className: 'vo-auth-token' }, '••••••••');
        var tokenRow = el('div', { className: 'vo-auth-row' });
        var show = el('button', { type: 'button', className: 'mm-btn' }, 'Show token');
        tokenRow.appendChild(show);
        tokenWrap.appendChild(tokenBox);
        tokenWrap.appendChild(tokenRow);
        card.appendChild(tokenWrap);
        show.addEventListener('click', function () {
          api('/api/access/agent-token').then(function (data) {
            tokenBox.textContent = data.ok ? data.token : errorText(data);
          });
        });
        if (!st.viaLoopback) {
          var out = el('button', { type: 'button', className: 'mm-btn' }, 'Sign out of this browser');
          out.addEventListener('click', logout);
          card.appendChild(el('div', { className: 'vo-auth-row' })).appendChild(out);
        }
      }
    }).catch(function () {
      card.textContent = '';
      card.appendChild(el('p', { className: 'vo-auth-msg error' }, 'Could not load access settings.'));
    });
  }

  window.VOAuth = {
    __v08: true,
    status: status,
    logout: logout,
    mountSettings: mountSettings,
    loginUrl: loginUrl
  };
})();
