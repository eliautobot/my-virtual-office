// ================================================================
//  Virtual Office — Projects Feature
//  Self-contained: all state, rendering, API, drag-drop
// ================================================================
(function () {
    'use strict';

    // ── UUID ───────────────────────────────────────────────────────
    function genId() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // ── STATE ──────────────────────────────────────────────────────
    const state = {
        view: 'list',          // list | board | templates | report
        projects: [],
        templates: [],
        currentProject: null,  // full project object
        currentTask: null,     // task being edited in detail panel
        agentRoster: [],
        dragState: null,       // {taskId, projectId, sourceColId, ghost}
        touchDrag: null,
        filters: { status: '', priority: '', tag: '', search: '', sort: 'updatedAt' },
        workflow: { active: false, autoMode: false, phase: 'idle', currentTaskId: null, pollTimer: null },
    };

    // ── DEFAULT TEMPLATES ─────────────────────────────────────────
    const DEFAULT_TEMPLATES = [
        {
            id: 'tpl-blank',
            title: 'Blank Project',
            description: 'Start from scratch with 5 default columns',
            columns: [
                { title: 'Backlog', color: '#6c757d' },
                { title: 'In Progress', color: '#ffc107' },
                { title: 'Review', color: '#fd7e14' },
                { title: 'Done', color: '#198754' },
            ],
            taskTemplates: [],
        },
        {
            id: 'tpl-software',
            title: 'Software Development',
            description: 'Standard software development workflow with sprint planning',
            columns: [
                { title: 'Backlog', color: '#6c757d' },
                { title: 'Sprint', color: '#0d6efd' },
                { title: 'In Progress', color: '#ffc107' },
                { title: 'Code Review', color: '#fd7e14' },
                { title: 'QA', color: '#17a2b8' },
                { title: 'Done', color: '#198754' },
            ],
            taskTemplates: [
                { title: 'Set up development environment', columnIndex: 0, priority: 'high' },
                { title: 'Define acceptance criteria', columnIndex: 0, priority: 'medium' },
                { title: 'Write unit tests', columnIndex: 0, priority: 'medium' },
            ],
        },
        {
            id: 'tpl-marketing',
            title: 'Marketing Campaign',
            description: 'Plan and execute marketing campaigns',
            columns: [
                { title: 'Ideas', color: '#6c757d' },
                { title: 'Planning', color: '#0d6efd' },
                { title: 'Creating', color: '#ffc107' },
                { title: 'Review', color: '#fd7e14' },
                { title: 'Published', color: '#198754' },
            ],
            taskTemplates: [
                { title: 'Define target audience', columnIndex: 0, priority: 'high' },
                { title: 'Create content calendar', columnIndex: 0, priority: 'medium' },
            ],
        },
        {
            id: 'tpl-bugs',
            title: 'Bug Tracking',
            description: 'Track and resolve bugs systematically',
            columns: [
                { title: 'Reported', color: '#dc3545' },
                { title: 'Confirmed', color: '#fd7e14' },
                { title: 'In Progress', color: '#ffc107' },
                { title: 'Fixed', color: '#0d6efd' },
                { title: 'Verified', color: '#198754' },
            ],
            taskTemplates: [],
        },
        {
            id: 'tpl-content',
            title: 'Content Pipeline',
            description: 'Manage content creation workflow',
            columns: [
                { title: 'Backlog', color: '#6c757d' },
                { title: 'Research', color: '#17a2b8' },
                { title: 'Writing', color: '#ffc107' },
                { title: 'Editing', color: '#fd7e14' },
                { title: 'Published', color: '#198754' },
            ],
            taskTemplates: [],
        },
    ];

    // ── API ────────────────────────────────────────────────────────
    const api = {
        async listProjects(status) {
            const qs = status ? `?status=${status}` : '';
            const r = await fetch(`/api/projects${qs}`);
            return r.json();
        },
        async getProject(id) {
            const r = await fetch(`/api/projects/${id}`);
            return r.json();
        },
        async createProject(body) {
            const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return r.json();
        },
        async updateProject(id, body) {
            const r = await fetch(`/api/projects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return r.json();
        },
        async deleteProject(id) {
            const r = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
            return r.json();
        },
        async createTask(projectId, body) {
            const r = await fetch(`/api/projects/${projectId}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return r.json();
        },
        async updateTask(projectId, taskId, body) {
            const r = await fetch(`/api/projects/${projectId}/tasks/${taskId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return r.json();
        },
        async deleteTask(projectId, taskId) {
            const r = await fetch(`/api/projects/${projectId}/tasks/${taskId}`, { method: 'DELETE' });
            return r.json();
        },
        async addComment(projectId, taskId, body) {
            const r = await fetch(`/api/projects/${projectId}/tasks/${taskId}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return r.json();
        },
        async reorderTasks(projectId, updates) {
            const r = await fetch(`/api/projects/${projectId}/tasks/reorder`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates }) });
            return r.json();
        },
        async updateColumns(projectId, columns) {
            const r = await fetch(`/api/projects/${projectId}/columns`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ columns }) });
            return r.json();
        },
        async listTemplates() {
            const r = await fetch('/api/projects/templates');
            return r.json();
        },
        async saveTemplate(body) {
            const r = await fetch('/api/projects/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return r.json();
        },
        async deleteTemplate(id) {
            const r = await fetch(`/api/projects/templates/${id}`, { method: 'DELETE' });
            return r.json();
        },
        async createFromTemplate(body) {
            const r = await fetch('/api/projects/from-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return r.json();
        },
        async getReport(projectId) {
            const r = await fetch(`/api/projects/${projectId}/report`);
            return r.json();
        },
        async getAgents() {
            const r = await fetch('/agents-list');
            return r.json();
        },
        async getScores() {
            const r = await fetch('/api/projects/scores');
            return r.json();
        },
        // Workflow API
        async workflowStart(projectId, autoMode) {
            const r = await fetch(`/api/projects/${projectId}/workflow/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoMode }) });
            return r.json();
        },
        async workflowStop(projectId) {
            const r = await fetch(`/api/projects/${projectId}/workflow/stop`, { method: 'POST' });
            return r.json();
        },
        async workflowStatus(projectId) {
            const r = await fetch(`/api/projects/${projectId}/workflow/status`);
            return r.json();
        },
        async setAutoMode(projectId, autoMode) {
            const r = await fetch(`/api/projects/${projectId}/workflow/auto-mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoMode }) });
            return r.json();
        },
        async updateReviewCheck(projectId, taskId, reviewCheck) {
            const r = await fetch(`/api/projects/${projectId}/tasks/${taskId}/review-check`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewCheck }) });
            return r.json();
        },
        async workflowChat(projectId) {
            const r = await fetch(`/api/projects/${projectId}/workflow/chat`);
            return r.json();
        },
    };

    // ── GAMIFICATION ENGINE ───────────────────────────────────────

    /** Show floating +XP popup at a screen position */
    function showScorePopup(x, y, points, streak) {
        const el = document.createElement('div');
        el.className = 'proj-score-popup';
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        let text = `+${points} XP`;
        if (streak > 1) text += ` 🔥${streak}`;
        el.textContent = text;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 1300);
    }

    /** Spawn confetti burst at a position */
    function spawnConfetti(x, y, count = 15) {
        const colors = ['#ffd700', '#4caf50', '#ff6b35', '#0d6efd', '#e91e63', '#00bcd4', '#ff9800'];
        for (let i = 0; i < count; i++) {
            const c = document.createElement('div');
            c.className = 'proj-confetti';
            c.style.left = (x + (Math.random() - 0.5) * 80) + 'px';
            c.style.top = (y + (Math.random() - 0.5) * 20) + 'px';
            c.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            c.style.width = (4 + Math.random() * 6) + 'px';
            c.style.height = (4 + Math.random() * 6) + 'px';
            c.style.animationDuration = (0.8 + Math.random() * 1) + 's';
            c.style.animationDelay = (Math.random() * 0.2) + 's';
            document.body.appendChild(c);
            setTimeout(() => c.remove(), 2000);
        }
    }

    /** Animate a task card spawn */
    function animateTaskSpawn(taskId) {
        requestAnimationFrame(() => {
            const card = findTaskCard(taskId);
            if (card) {
                card.classList.add('anim-spawn');
                card.addEventListener('animationend', () => card.classList.remove('anim-spawn'), { once: true });
            }
        });
    }

    /** Animate a task card deletion (returns promise that resolves when animation done) */
    function animateTaskDelete(taskId) {
        return new Promise(resolve => {
            const card = findTaskCard(taskId);
            if (card) {
                card.classList.add('anim-delete');
                card.addEventListener('animationend', () => resolve(), { once: true });
                // Fallback in case animationend doesn't fire
                setTimeout(resolve, 500);
            } else {
                resolve();
            }
        });
    }

    /** Animate a task completion (sparkle + confetti + score) */
    function animateTaskComplete(taskId, scoreResult) {
        requestAnimationFrame(() => {
            const card = findTaskCard(taskId);
            if (card) {
                card.classList.add('anim-complete');
                const rect = card.getBoundingClientRect();
                // Confetti burst from the card
                spawnConfetti(rect.left + rect.width / 2, rect.top);
                // Score popup
                if (scoreResult && scoreResult.pointsAwarded) {
                    showScorePopup(rect.right - 30, rect.top - 10, scoreResult.pointsAwarded, scoreResult.streak);
                }
                // Gamified toast
                if (scoreResult && scoreResult.pointsAwarded) {
                    const agentInfo = resolveAgent(scoreResult.agent);
                    const name = agentInfo ? agentInfo.name : 'An agent';
                    const emoji = agentInfo ? agentInfo.emoji : '🤖';
                    const streak = num(scoreResult.streak);
                    toast(`${emoji} ${name} earned +${num(scoreResult.pointsAwarded)} XP! ${streak > 1 ? '🔥 Streak x' + streak : ''}`, 'success');
                } else {
                    toast('✅ Task completed!', 'success');
                }
                // Refresh leaderboard
                refreshLeaderboard();
            }
        });
    }

    /** Update the sidebar leaderboard */
    async function refreshLeaderboard() {
        try {
            const data = await api.getScores();
            const lb = data.leaderboard || [];
            const container = document.getElementById('sidebar-projects-lb');
            if (!container) return;
            if (lb.length === 0) {
                container.innerHTML = '<div class="proj-lb-empty">No scores yet — complete tasks to earn XP!</div>';
                return;
            }
            const { known, other } = groupScores(lb);
            const top5 = known.filter(row => row.score > 0).slice(0, 5);
            if (top5.length === 0 && !(other && other.score > 0)) {
                container.innerHTML = '<div class="proj-lb-empty">No scores yet — complete tasks to earn XP!</div>';
                return;
            }
            const rows = top5.map((row, i) => `<div class="proj-lb-row">
                    <span class="proj-lb-rank rank-${i + 1}">${i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1)}</span>
                    <span class="proj-lb-emoji">${escHtml(row.emoji)}</span>
                    <span class="proj-lb-name">${escHtml(row.name)}</span>
                    <span class="proj-lb-score">${row.score} XP</span>
                    ${row.streak > 1 ? `<span class="proj-streak">🔥${row.streak}</span>` : ''}
                    ${trophyBadge(row)}
                </div>`);
            if (other && other.score > 0) {
                rows.push(`<div class="proj-lb-row proj-lb-other" title="Agents that are not in this office">
                    <span class="proj-lb-rank">·</span>
                    <span class="proj-lb-emoji">👥</span>
                    <span class="proj-lb-name">${escHtml(otherAgentsLabel(other.count))}</span>
                    <span class="proj-lb-score">${other.score} XP</span>
                </div>`);
            }
            container.innerHTML = rows.join('');
        } catch (e) { /* silent */ }
    }

    /** Render in-board mini scoreboard (top of board) */
    function renderBoardScoreboard() {
        if (!state.currentProject) return '';
        // Get assignees in this project
        const assignees = new Set();
        state.currentProject.tasks.forEach(t => { if (t.assignee) assignees.add(t.assignee); });
        if (assignees.size === 0) return '';
        // We'll populate async, return a container
        return `<div class="proj-scoreboard" id="proj-board-scoreboard"></div>`;
    }

    async function populateBoardScoreboard() {
        const el = document.getElementById('proj-board-scoreboard');
        if (!el) return;
        try {
            const data = await api.getScores();
            const lb = data.leaderboard || [];
            // Filter to agents in this project
            const assignees = new Set();
            state.currentProject.tasks.forEach(t => { if (t.assignee) assignees.add(t.assignee); });
            const relevant = lb.filter(e => e && assignees.has(e.agent));
            if (relevant.length === 0) { el.remove(); return; }
            const { known, other } = groupScores(relevant);
            const items = known.slice(0, 5).map((row, i) => `<div class="proj-scoreboard-item ${i === 0 ? 'rank-1' : ''}">
                    <span class="sb-emoji">${escHtml(row.emoji)}</span>
                    <span>${escHtml(row.name)}</span>
                    <span class="sb-score">${row.score} XP</span>
                    ${row.streak > 1 ? `<span class="proj-streak">🔥${row.streak}</span>` : ''}
                    ${trophyBadge(row)}
                </div>`);
            if (other) {
                items.push(`<div class="proj-scoreboard-item proj-scoreboard-other" title="Agents that are not in this office">
                    <span class="sb-emoji">👥</span>
                    <span>${escHtml(otherAgentsLabel(other.count))}</span>
                    <span class="sb-score">${other.score} XP</span>
                </div>`);
            }
            el.innerHTML = items.join('');
        } catch (e) { el.remove(); }
    }

    // ── HELPERS ───────────────────────────────────────────────────
    // Everything rendered below comes from the projects API, which agents can
    // write to. Text goes through escHtml; values that land in class names,
    // style= or value= go through a fixed allow-list first.
    const STATUS_VALUES = ['active', 'paused', 'completed', 'archived'];
    const PRIORITY_VALUES = ['critical', 'high', 'medium', 'low'];
    const REVIEW_STATUS_VALUES = ['pass', 'needs_more_work', 'did_not_pass', 'requires_user_review', 'pending'];
    const DEFAULT_COLOR = '#6c757d';

    function safeStatus(v) { return STATUS_VALUES.includes(v) ? v : 'active'; }
    function safePriority(v) { return PRIORITY_VALUES.includes(v) ? v : 'medium'; }
    function safeReviewStatus(v) { return REVIEW_STATUS_VALUES.includes(v) ? v : 'pending'; }
    function safeColor(c, fallback = DEFAULT_COLOR) {
        return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : fallback;
    }
    /** Color as #rrggbb so an alpha suffix can be appended safely. */
    function hexBase(c) {
        const s = safeColor(c);
        if (s.length === 4 || s.length === 5) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
        return s.slice(0, 7);
    }
    /** yyyy-mm-dd for <input type=date value=...>, or '' when the stored value is not an ISO date. */
    function safeDateValue(v) {
        if (typeof v !== 'string') return '';
        const s = v.slice(0, 10);
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
    }
    function num(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }
    function cssEsc(s) {
        if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(String(s));
        return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch.charCodeAt(0).toString(16) + ' ');
    }

    // DOM lookups by data attribute (ids from the server never become DOM ids).
    function findCol(colId) {
        return document.querySelector(`#projectsModal .proj-col[data-col-id="${cssEsc(colId)}"]`);
    }
    function findColPart(colId, selector) {
        const col = findCol(colId);
        return col ? col.querySelector(selector) : null;
    }
    function findTaskCard(taskId) {
        return document.querySelector(`#projectsModal .proj-task-card[data-task-id="${cssEsc(taskId)}"]`);
    }

    // ── AGENT NAMES ───────────────────────────────────────────────
    /** Find the office agent for a stored agent id (assignee, score owner). */
    function resolveAgent(id) {
        if (!id) return null;
        const key = String(id);
        const roster = state.agentRoster || [];
        const match = roster.find(a => a && (a.key === key || a.agentId === key || a.statusKey === key || a.id === key))
            || roster.find(a => a && Array.isArray(a.selectionAliases) && a.selectionAliases.includes(key));
        if (!match) return null;
        const name = String(match.name || match.key || match.statusKey || match.id || '').trim();
        if (!name) return null;
        return { key: agentValue(match), name, emoji: String(match.emoji || '🤖') };
    }
    /** The id the server expects for an assignee picked from the roster. */
    function agentValue(a) {
        return String(a.key || a.statusKey || a.id || a.agentId || '');
    }
    function otherAgentsLabel(count) {
        return count === 1 ? 'Other agent' : `Other agents (${count})`;
    }
    /** "🤖 Name" for a known agent, a neutral label for ids outside this office. */
    function agentLabel(id) {
        const agent = resolveAgent(id);
        return agent ? `${agent.emoji} ${agent.name}` : 'Other agent';
    }
    /**
     * Merge leaderboard entries by office agent. Ids that are not in this
     * office are summed into one "other" bucket instead of showing raw ids.
     */
    function trophyBadge(row) {
        const n = Math.floor(num(row && row.titles));
        if (n <= 0) return '';
        const label = n === 1 ? '1 tournament title' : `${n} tournament titles`;
        return `<span class="proj-streak proj-trophies" title="${label}" aria-label="${label}">🏆${n}</span>`;
    }
    function groupScores(entries) {
        const byKey = new Map();
        let other = null;
        (entries || []).forEach(entry => {
            if (!entry) return;
            const score = num(entry.score);
            const streak = num(entry.streak);
            // Office life tournaments: titles won (games never change XP).
            const titles = num(entry.games && entry.games.titles);
            const agent = resolveAgent(entry.agent);
            if (!agent) {
                if (!other) other = { score: 0, count: 0 };
                other.score += score;
                other.count += 1;
                return;
            }
            const row = byKey.get(agent.key);
            if (row) {
                row.score += score;
                row.streak = Math.max(row.streak, streak);
                row.titles += titles;
            } else {
                byKey.set(agent.key, { name: agent.name, emoji: agent.emoji, score, streak, titles });
            }
        });
        const known = [...byKey.values()].sort((a, b) => b.score - a.score);
        return { known, other };
    }

    // ── DIALOGS (VOUI with native fallback) ───────────────────────
    function trackDialog(promise) {
        state.dialogDepth = (state.dialogDepth || 0) + 1;
        const done = () => { state.dialogDepth = Math.max(0, (state.dialogDepth || 1) - 1); };
        return promise.then(v => { done(); return v; }, err => { done(); throw err; });
    }
    function uiConfirm(opts) {
        const ui = window.VOUI;
        if (ui && typeof ui.confirm === 'function') {
            return trackDialog(Promise.resolve().then(() => ui.confirm(opts)).then(Boolean, () => false));
        }
        return Promise.resolve(window.confirm(opts.body ? `${opts.title}\n\n${opts.body}` : opts.title));
    }
    function uiPrompt(opts) {
        const ui = window.VOUI;
        if (ui && typeof ui.prompt === 'function') {
            return trackDialog(Promise.resolve().then(() => ui.prompt(opts)).then(v => (v == null ? null : String(v)), () => null));
        }
        return Promise.resolve(window.prompt(opts.label || opts.title, opts.value || ''));
    }

    function priorityColor(p) {
        return { critical: '#dc3545', high: '#fd7e14', medium: '#0d6efd', low: '#6c757d' }[p] || '#6c757d';
    }
    function formatDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    function isOverdue(iso) {
        if (!iso) return false;
        const d = new Date(iso);
        return !isNaN(d.getTime()) && d < new Date();
    }
    function timeAgo(iso) {
        if (!iso) return '';
        const diff = Date.now() - new Date(iso).getTime();
        if (!Number.isFinite(diff)) return '';
        const s = Math.floor(diff / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }
    // Pixel icon from the sprite in index.html (decorative: the button keeps its text or aria-label).
    function icon(id) {
        return `<svg class="vo-icon" aria-hidden="true"><use href="#i-${id}"/></svg>`;
    }
    function escHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function simpleMarkdown(text) {
        if (!text) return '';
        return escHtml(text)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');
    }
    function toast(msg, type = 'info') {
        const ui = window.VOUI;
        if (ui && typeof ui.toast === 'function') {
            try { ui.toast(msg, { kind: type }); return; } catch (e) { /* fall back to the local toast */ }
        }
        let el = document.getElementById('proj-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'proj-toast';
            el.className = 'proj-toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.className = `proj-toast ${type}`;
        el.classList.add('show');
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.classList.remove('show'), 3000);
    }

    // ── MODAL SCAFFOLD ────────────────────────────────────────────
    function getModal() { return document.getElementById('projectsModal'); }
    function getMainContent() { return document.getElementById('proj-main-content'); }

    // ── OPEN / CLOSE ──────────────────────────────────────────────
    function isModalOpen() {
        const modal = getModal();
        return !!(modal && !modal.classList.contains('hidden'));
    }

    /** First control worth focusing inside the board (skips hidden ones). */
    function firstControl(root) {
        if (!root) return null;
        const candidates = root.querySelectorAll('button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])');
        for (const el of candidates) {
            if (el.disabled || el.closest('.hidden')) continue;
            if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
            return el;
        }
        return null;
    }

    function focusFirstInMain() {
        const mc = getMainContent();
        const target = firstControl(mc) || mc;
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }

    /** Open the Projects window; `{ projectId }` opens that project's board directly. */
    function openProjectsManager(opts) {
        const modal = getModal();
        if (!modal) return;
        ensureBound();
        const projectId = opts && typeof opts === 'object' && typeof opts.projectId === 'string' ? opts.projectId : '';
        const wasOpen = isModalOpen();
        if (!wasOpen) {
            const active = document.activeElement;
            state.opener = active && active !== document.body && !modal.contains(active) ? active : null;
        }
        modal.classList.remove('hidden');
        const mc = getMainContent();
        if (mc && !mc.hasAttribute('tabindex')) mc.setAttribute('tabindex', '-1');
        const listReady = projectId ? openProject(projectId) : showListView();
        if (!wasOpen) {
            const ui = window.VOUI;
            let handled = false;
            if (ui && typeof ui.openWindow === 'function') {
                try {
                    // onClose: VOUI's Escape and scrim close the topmost layer, not the whole board.
                    ui.openWindow(modal, { opener: state.opener, initialFocus: mc, onClose: closeTopLayer });
                    handled = true;
                } catch (e) { /* fall back below */ }
            }
            if (!handled && mc) mc.focus({ preventScroll: true });
            // Move focus to the first real control once the list has rendered,
            // unless the user already moved it somewhere else.
            Promise.resolve(listReady).then(() => {
                if (!isModalOpen()) return;
                const active = document.activeElement;
                if (!active || active === document.body || active === mc) focusFirstInMain();
            });
        }
        loadAgentRoster().then(() => refreshLeaderboard());
    }
    window.openProjectsManager = openProjectsManager;

    function closeProjectsModal() {
        const modal = getModal();
        if (!modal) return;
        const wasOpen = isModalOpen();
        hideFormModal();
        closeDetailPanel();
        stopWorkflowPolling();
        modal.classList.add('hidden');
        if (!wasOpen) return;
        const ui = window.VOUI;
        if (ui && typeof ui.closeWindow === 'function') {
            try { ui.closeWindow(modal); } catch (e) { /* ignore */ }
        }
        const opener = state.opener;
        state.opener = null;
        const active = document.activeElement;
        if (opener && opener.isConnected && typeof opener.focus === 'function'
            && (!active || active === document.body || modal.contains(active))) {
            opener.focus({ preventScroll: true });
        }
    }
    window.closeProjectsModal = closeProjectsModal;

    async function loadAgentRoster() {
        try {
            const d = await api.getAgents();
            const agents = Array.isArray(d && d.agents) ? d.agents : [];
            if (agents.length) { state.agentRoster = agents; return; }
        } catch (e) { /* try the newer endpoint below */ }
        try {
            const r = await fetch('/api/agents');
            const d = await r.json();
            if (Array.isArray(d && d.agents)) state.agentRoster = d.agents;
        } catch (e) { /* non-fatal: names fall back to "Other agent" */ }
    }

    // ── LIST VIEW ─────────────────────────────────────────────────
    /** Each view change gets a token; a slow response for an older view is dropped. */
    function nextViewToken() {
        state.viewSeq = (state.viewSeq || 0) + 1;
        return state.viewSeq;
    }
    function isCurrentView(token) { return token === state.viewSeq; }

    async function showListView() {
        const token = nextViewToken();
        state.view = 'list';
        closeDetailPanel();
        state.currentProject = null;
        stopWorkflowPolling();
        const mc = getMainContent();
        if (!mc) return;
        mc.innerHTML = renderListSkeleton();
        try {
            const d = await api.listProjects();
            if (!isCurrentView(token)) return;
            state.projects = Array.isArray(d && d.projects) ? d.projects : [];
            mc.innerHTML = renderListView();
            updateSidebar();
        } catch (e) {
            if (!isCurrentView(token)) return;
            mc.innerHTML = `<div class="proj-loading"><div>⚠️ Failed to load projects</div><div class="proj-loading-detail">${escHtml(String(e))}</div></div>`;
        }
    }

    function renderListSkeleton() {
        return `<div class="proj-loading"><div class="proj-spinner"></div><div>Loading projects…</div></div>`;
    }

    function filteredProjects() {
        const { filters } = state;
        let projects = state.projects.filter(p => p && typeof p === 'object');

        // Filter
        if (filters.status) projects = projects.filter(p => p.status === filters.status);
        if (filters.priority) projects = projects.filter(p => p.priority === filters.priority);
        if (filters.tag) projects = projects.filter(p => tagList(p.tags).includes(filters.tag));
        if (filters.search) {
            const q = filters.search.toLowerCase();
            projects = projects.filter(p => String(p.title || '').toLowerCase().includes(q) || String(p.description || '').toLowerCase().includes(q));
        }

        // Sort
        const sortKey = filters.sort || 'updatedAt';
        projects.sort((a, b) => {
            if (sortKey === 'title') return String(a.title || '').localeCompare(String(b.title || ''));
            if (sortKey === 'priority') {
                const pOrder = { critical: 0, high: 1, medium: 2, low: 3 };
                return (pOrder[safePriority(a.priority)]) - (pOrder[safePriority(b.priority)]);
            }
            const aDate = String(a[sortKey] || a.updatedAt || '');
            const bDate = String(b[sortKey] || b.updatedAt || '');
            return bDate.localeCompare(aDate);
        });
        return projects;
    }

    function tagList(tags) {
        return Array.isArray(tags) ? tags.filter(t => typeof t === 'string' || typeof t === 'number').map(String) : [];
    }

    function renderProjectGrid() {
        const projects = filteredProjects();
        if (projects.length === 0) return renderEmptyList();
        // A "new project" tile closes the grid, so a board with one or two projects still looks finished.
        const filtered = state.filters.search || state.filters.status || state.filters.priority || state.filters.tag;
        return projects.map(renderProjectCard).join('') + (filtered ? '' :
            `<button type="button" class="proj-card-new" data-action="new-project">${icon('plus')}<span>New project</span></button>`);
    }

    function selectedAttr(cond) { return cond ? 'selected' : ''; }

    function renderListView() {
        const { filters } = state;
        // Collect all tags for filter
        const allTags = [...new Set(state.projects.flatMap(p => tagList(p && p.tags)))];

        return `
        <div class="proj-toolbar">
            <button class="proj-btn proj-btn-primary" data-action="new-project">${icon('plus')}New Project</button>
            <button class="proj-btn" data-action="show-templates">${icon('grid')}Templates</button>
            <input class="proj-search" id="proj-search" type="search" aria-label="Search projects" placeholder="Search projects…" value="${escHtml(filters.search)}" data-input="search">
            <div class="proj-filter-row">
                <select class="proj-select" aria-label="Filter by status" data-change="filter" data-filter="status">
                    <option value="" ${selectedAttr(!filters.status)}>All Statuses</option>
                    <option value="active" ${selectedAttr(filters.status === 'active')}>Active</option>
                    <option value="paused" ${selectedAttr(filters.status === 'paused')}>Paused</option>
                    <option value="completed" ${selectedAttr(filters.status === 'completed')}>Completed</option>
                    <option value="archived" ${selectedAttr(filters.status === 'archived')}>Archived</option>
                </select>
                <select class="proj-select" aria-label="Filter by priority" data-change="filter" data-filter="priority">
                    <option value="" ${selectedAttr(!filters.priority)}>All Priorities</option>
                    <option value="critical" ${selectedAttr(filters.priority === 'critical')}>Critical</option>
                    <option value="high" ${selectedAttr(filters.priority === 'high')}>High</option>
                    <option value="medium" ${selectedAttr(filters.priority === 'medium')}>Medium</option>
                    <option value="low" ${selectedAttr(filters.priority === 'low')}>Low</option>
                </select>
                ${allTags.length ? `
                <select class="proj-select" aria-label="Filter by tag" data-change="filter" data-filter="tag">
                    <option value="">All Tags</option>
                    ${allTags.map(t => `<option value="${escHtml(t)}" ${selectedAttr(filters.tag === t)}>${escHtml(t)}</option>`).join('')}
                </select>` : ''}
                <select class="proj-select" aria-label="Sort projects" data-change="filter" data-filter="sort">
                    <option value="updatedAt" ${selectedAttr(filters.sort === 'updatedAt')}>Recently Updated</option>
                    <option value="createdAt" ${selectedAttr(filters.sort === 'createdAt')}>Date Created</option>
                    <option value="dueDate" ${selectedAttr(filters.sort === 'dueDate')}>Due Date</option>
                    <option value="title" ${selectedAttr(filters.sort === 'title')}>Name</option>
                    <option value="priority" ${selectedAttr(filters.sort === 'priority')}>Priority</option>
                </select>
            </div>
        </div>
        <div class="proj-list-body">
            <div class="proj-grid">
                ${renderProjectGrid()}
            </div>
        </div>`;
    }

    function renderEmptyList() {
        const filtered = state.filters.search || state.filters.status || state.filters.priority || state.filters.tag;
        if (filtered && state.projects.length) {
            return `
        <div class="proj-empty vo-empty" role="status">
            <span class="vo-empty-icon">${icon('search')}</span>
            <strong class="vo-empty-title">No matching projects</strong>
            <span class="vo-empty-text">Try another search or clear the filters.</span>
        </div>`;
        }
        return `
        <div class="proj-empty vo-empty" role="status">
            <span class="vo-empty-icon">${icon('projects')}</span>
            <strong class="vo-empty-title">No projects yet</strong>
            <span class="vo-empty-text">A project holds tasks your agents can pick up and work through.</span>
            <button type="button" class="vo-btn vo-btn--primary vo-empty-action proj-empty-cta" data-action="new-project">${icon('plus')}<span>Create project</span></button>
        </div>`;
    }

    function renderProjectCard(p) {
        const done = num(p.taskDone);
        const total = num(p.taskCount);
        const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
        const dueText = formatDate(p.dueDate);
        const overdue = dueText && isOverdue(p.dueDate);
        const status = safeStatus(p.status);
        const priority = safePriority(p.priority);
        const id = escHtml(p.id);
        return `
        <div class="proj-card" data-action="open-project" data-id="${id}" tabindex="0" role="button" aria-label="Open project ${escHtml(p.title)}">
            <div class="proj-card-header">
                <div class="proj-card-title">${escHtml(p.title)}</div>
                <div class="proj-card-actions" data-action="none">
                    <button class="proj-btn proj-btn-sm proj-btn-icon" title="Report" aria-label="Report" data-action="show-report" data-id="${id}">${icon('log')}</button>
                    <button class="proj-btn proj-btn-sm proj-btn-icon" title="Archive" aria-label="Archive" data-action="archive-project" data-id="${id}">${icon('book')}</button>
                    <button class="proj-btn proj-btn-sm proj-btn-icon" title="Delete" aria-label="Delete" data-action="delete-project" data-id="${id}">${icon('close')}</button>
                </div>
            </div>
            ${p.description ? `<div class="proj-card-desc">${escHtml(p.description)}</div>` : ''}
            <div class="proj-card-meta">
                <span class="proj-badge badge-${status}">${status}</span>
                <span class="proj-badge badge-${priority}">${priority}</span>
                ${p.branch ? `<span class="proj-badge proj-badge-branch">🏢 ${escHtml(p.branch)}</span>` : ''}
                ${tagList(p.tags).slice(0, 2).map(t => `<span class="proj-tag">${escHtml(t)}</span>`).join('')}
            </div>
            <div class="proj-progress-row">
                <div class="proj-progress-track"><div class="proj-progress-bar" style="width:${pct}%"></div></div>
                <span class="proj-progress-label">${done}/${total}</span>
            </div>
            ${dueText ? `<div class="proj-card-due ${overdue ? 'overdue' : ''}">📅 ${overdue ? '⚠️ Overdue: ' : 'Due: '}${escHtml(dueText)}</div>` : ''}
        </div>`;
    }

    // ── PROJECT BOARD ─────────────────────────────────────────────
    async function openProject(id) {
        const token = nextViewToken();
        state.view = 'board';
        stopWorkflowPolling();
        closeDetailPanel();
        const mc = getMainContent();
        if (!mc) return;
        mc.innerHTML = renderListSkeleton();
        try {
            const d = await api.getProject(id);
            if (!isCurrentView(token)) return;
            if (!d || !d.project) throw new Error('Not found');
            state.currentProject = normalizeProject(d.project);
            mc.innerHTML = renderBoardView();
            bindBoardEvents();
            populateBoardScoreboard();
            checkWorkflowOnOpen();
        } catch (e) {
            if (!isCurrentView(token)) return;
            mc.innerHTML = `<div class="proj-loading"><div>⚠️ Failed to load project</div><button class="proj-btn" data-action="back-to-list">← Back to Projects</button></div>`;
        }
    }

    /** Make sure the arrays the board iterates over are arrays. */
    function normalizeProject(p) {
        if (!p || typeof p !== 'object') return p;
        if (!Array.isArray(p.columns)) p.columns = [];
        p.columns = p.columns.filter(c => c && typeof c === 'object');
        if (!Array.isArray(p.tasks)) p.tasks = [];
        p.tasks = p.tasks.filter(t => t && typeof t === 'object');
        if (!Array.isArray(p.activity)) p.activity = [];
        return p;
    }

    function renderBoardView() {
        const p = state.currentProject;
        if (!p) return '';
        const cols = (p.columns || []).slice().sort((a, b) => num(a.order) - num(b.order));
        const tasks = p.tasks || [];
        const status = safeStatus(p.status);
        const priority = safePriority(p.priority);
        const id = escHtml(p.id);

        return `
        <div class="proj-toolbar proj-board-toolbar">
            <button class="proj-btn proj-board-back" data-action="back-to-list" aria-label="Back to projects"><span class="proj-icon-back">${icon('chev')}</span>Back</button>
            <h3 class="proj-board-title" title="${escHtml(p.title)}">${escHtml(p.title)}</h3>
            <span class="proj-badge badge-${status}">${status}</span>
            <span class="proj-badge badge-${priority}">${priority}</span>
            <div class="proj-toolbar-spacer"></div>
            <div class="proj-workflow-controls" id="proj-wf-controls">
                <button class="proj-btn proj-btn-sm proj-btn-start" id="wf-start-btn" data-action="workflow-start" title="Start workflow">Start</button>
                <button class="proj-btn proj-btn-sm proj-btn-stop hidden" id="wf-stop-btn" data-action="workflow-stop" title="Stop workflow">Stop</button>
                <div class="proj-auto-toggle" title="Auto Mode: automatically process next backlog task when current finishes">
                    <label class="proj-toggle-switch">
                        <input type="checkbox" id="wf-auto-toggle" aria-label="Auto mode" ${p.autoMode ? 'checked' : ''} data-change="auto-mode">
                        <span class="proj-toggle-slider"></span>
                    </label>
                    <span class="proj-toggle-label">Auto</span>
                </div>
                <span class="proj-wf-status" id="wf-status-badge"></span>
            </div>
            <button class="proj-btn proj-btn-sm" data-action="edit-project" data-id="${id}">${icon('edit')}Edit</button>
            <button class="proj-btn proj-btn-sm" data-action="show-report" data-id="${id}">${icon('log')}Report</button>
            <button class="proj-btn proj-btn-sm" data-action="save-template" data-id="${id}">${icon('save')}Template</button>
        </div>
        ${p.description ? `
        <div class="proj-board-header">
            <button type="button" class="proj-board-desc-toggle" data-action="toggle-desc" aria-expanded="false">▼ Show description</button>
            <div class="proj-board-desc">${escHtml(p.description)}</div>
        </div>` : ''}
        ${renderBoardScoreboard()}
        <div class="proj-board-body" id="proj-board-cols">
            <div class="proj-col proj-chat-col" id="proj-wf-chat-col">
                <div class="proj-col-header proj-chat-col-header">
                    <div class="proj-col-dot"></div>
                    <div class="proj-col-title">Chat</div>
                    <span class="proj-wf-chat-live" id="proj-chat-live-dot"></span>
                </div>
                <div class="proj-chat-messages" id="proj-wf-chat-messages">
                    <div class="proj-chat-empty">Workflow chat will appear here when a task is being worked on.</div>
                </div>
            </div>
            ${cols.map(col => renderColumn(col, tasks)).join('')}
        </div>`;
    }

    function renderColumn(col, allTasks) {
        const tasks = allTasks.filter(t => t.columnId === col.id).slice().sort((a, b) => num(a.order) - num(b.order));
        const colId = escHtml(col.id);
        return `
        <div class="proj-col" data-col-id="${colId}" style="--col-color:${safeColor(col.color)}">
            <div class="proj-col-header">
                <div class="proj-col-dot"></div>
                <div class="proj-col-title" data-dblclick="rename-column" data-col-id="${colId}" title="Double-click to rename">${escHtml(col.title)}</div>
                <span class="proj-col-count">${tasks.length}</span>
                <button class="proj-col-add-btn" data-action="show-quick-add" data-col-id="${colId}" title="Add task" aria-label="Add task to ${escHtml(col.title)}">+</button>
            </div>
            <div class="proj-col-tasks" data-col-id="${colId}">
                ${tasks.map(t => renderTaskCard(t)).join('')}
            </div>
            <div class="proj-quick-add hidden" data-col-id="${colId}">
                <input class="proj-quick-add-input" type="text" aria-label="New task title" placeholder="Task title… (Enter to add)" data-keydown="quick-add" data-col-id="${colId}">
                <div class="proj-quick-add-actions">
                    <button class="proj-btn proj-btn-sm proj-btn-primary" data-action="submit-quick-add" data-col-id="${colId}">Add</button>
                    <button class="proj-btn proj-btn-sm" data-action="hide-quick-add" data-col-id="${colId}">Cancel</button>
                </div>
            </div>
        </div>`;
    }

    function renderTaskCard(task) {
        const priority = safePriority(task.priority);
        const pc = priorityColor(priority);
        const due = formatDate(task.dueDate);
        const overdue = due && !task.completedAt && isOverdue(task.dueDate);
        const checklist = Array.isArray(task.checklist) ? task.checklist.filter(c => c && typeof c === 'object') : [];
        const checkDone = checklist.filter(c => c.done).length;
        const hasCheck = checklist.length > 0;
        const comments = Array.isArray(task.comments) ? task.comments.length : 0;
        const assignee = task.assignee ? resolveAgent(task.assignee) : null;
        const taskId = escHtml(task.id);
        return `
        <div class="proj-task-card" data-task-id="${taskId}" data-action="open-task"
            style="--pri-color:${pc}"
            draggable="true" tabindex="0" role="button" aria-label="Open task ${escHtml(task.title)}">
            <div class="proj-task-title">${escHtml(task.title)}</div>
            <div class="proj-task-meta">
                ${priority !== 'medium' ? `<span class="proj-badge proj-badge-xs badge-${priority}">${priority}</span>` : ''}
                ${assignee ? `<span class="proj-task-assignee" title="${escHtml(assignee.name)}">${escHtml(assignee.emoji || '👤')}</span>`
                    : (task.assignee ? `<span class="proj-task-assignee proj-task-assignee-other" title="Assigned to an agent outside this office">👤</span>` : '')}
                ${due ? `<span class="proj-task-due ${overdue ? 'overdue' : ''}" title="${escHtml(due)}">${overdue ? '⚠️' : '📅'} ${escHtml(due)}</span>` : ''}
                ${tagList(task.tags).slice(0, 2).map(t => `<span class="proj-tag proj-tag-xs">${escHtml(t)}</span>`).join('')}
                ${comments > 0 ? `<span class="proj-task-comment-icon">💬 ${comments}</span>` : ''}
            </div>
            ${hasCheck ? `
            <div class="proj-checklist-mini">
                <div class="proj-checklist-mini-bar"><div class="proj-checklist-mini-fill" style="width:${Math.round(checkDone/checklist.length*100)}%"></div></div>
                <span>${checkDone}/${checklist.length}</span>
            </div>` : ''}
        </div>`;
    }

    function bindBoardEvents() {
        // Board events are delegated from the modal root (see ensureBound);
        // nothing to rebind after a re-render.
    }

    /**
     * Re-render the open board in place, keeping what the template cannot
     * rebuild: workflow chat messages, scoreboard, Start/Stop state, scroll.
     */
    function rerenderBoard() {
        const mc = getMainContent();
        if (!mc || state.view !== 'board' || !state.currentProject) return;
        const chat = document.getElementById('proj-wf-chat-messages');
        const chatHtml = chat ? chat.innerHTML : null;
        const chatScroll = chat ? chat.scrollTop : 0;
        const body = document.getElementById('proj-board-cols');
        const scroll = body ? [body.scrollLeft, body.scrollTop] : null;
        const board = document.getElementById('proj-board-scoreboard');
        const boardHtml = board ? board.innerHTML : '';
        mc.innerHTML = renderBoardView();
        const newChat = document.getElementById('proj-wf-chat-messages');
        if (newChat && chatHtml !== null) { newChat.innerHTML = chatHtml; newChat.scrollTop = chatScroll; }
        const newBody = document.getElementById('proj-board-cols');
        if (newBody && scroll) { newBody.scrollLeft = scroll[0]; newBody.scrollTop = scroll[1]; }
        const newBoard = document.getElementById('proj-board-scoreboard');
        if (newBoard && boardHtml) newBoard.innerHTML = boardHtml;
        updateWorkflowUI();
        updateActiveColumnIndicator();
    }

    // ── DRAG & DROP (HTML5) ───────────────────────────────────────
    let _dragTaskId = null;
    let _dragSourceColId = null;
    let _dropTarget = null;
    let _dragOverFrame = 0;
    let _pendingDropPosition = null;
    let _dropIndicator = null;

    function onDragStart(e, taskId) {
        if (_dragOverFrame) cancelAnimationFrame(_dragOverFrame);
        _dragOverFrame = 0;
        _pendingDropPosition = null;
        if (_dropIndicator) _dropIndicator.remove();
        _dragTaskId = taskId;
        const card = findTaskCard(taskId);
        const p = state.currentProject;
        const task = p && p.tasks.find(t => t.id === taskId);
        if (task) {
            _dragSourceColId = task.columnId;
        }
        if (card) card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', taskId);
    }

    function onDragEnd(e) {
        if (_dragOverFrame) cancelAnimationFrame(_dragOverFrame);
        _dragOverFrame = 0;
        _pendingDropPosition = null;
        if (_dropIndicator) _dropIndicator.remove();
        if (_dragTaskId) {
            const card = findTaskCard(_dragTaskId);
            if (card) card.classList.remove('dragging');
        }
        // Remove all col highlights
        document.querySelectorAll('.proj-col').forEach(c => c.classList.remove('drag-over'));
        document.querySelectorAll('.proj-drop-line.visible').forEach(l => l.classList.remove('visible'));
        _dragTaskId = null;
        _dragSourceColId = null;
    }

    function onDragOver(e, colId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const col = findCol(colId);
        if (col) col.classList.add('drag-over');
        // Determine insert position
        const tasksEl = findColPart(colId, '.proj-col-tasks');
        if (tasksEl) {
            _pendingDropPosition = { container: tasksEl, clientY: e.clientY };
            if (!_dragOverFrame) _dragOverFrame = requestAnimationFrame(flushDropIndicator);
        }
    }

    function onDragLeave(e, colId) {
        const col = findCol(colId);
        if (col && !col.contains(e.relatedTarget)) {
            col.classList.remove('drag-over');
            const tasksEl = findColPart(colId, '.proj-col-tasks');
            if (tasksEl) {
                if (_pendingDropPosition?.container === tasksEl) _pendingDropPosition = null;
                if (_dropIndicator?.parentElement === tasksEl) _dropIndicator.remove();
            }
        }
    }

    function flushDropIndicator() {
        _dragOverFrame = 0;
        if (!_pendingDropPosition) return;
        insertDropIndicator(_pendingDropPosition.container, _pendingDropPosition.clientY);
    }

    function insertDropIndicator(container, clientY) {
        const cards = Array.from(container.querySelectorAll('.proj-task-card'));
        let insertBefore = null;
        for (const card of cards) {
            if (card.dataset.taskId === _dragTaskId) continue;
            const rect = card.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                insertBefore = card;
                break;
            }
        }
        if (!_dropIndicator) {
            _dropIndicator = document.createElement('div');
            _dropIndicator.className = 'proj-drop-line visible';
        }
        _dropIndicator.classList.add('visible');
        if (insertBefore) {
            if (_dropIndicator.parentElement !== container || _dropIndicator.nextSibling !== insertBefore) {
                container.insertBefore(_dropIndicator, insertBefore);
            }
        } else if (_dropIndicator.parentElement !== container || _dropIndicator !== container.lastElementChild) {
            container.appendChild(_dropIndicator);
        }
    }

    function onDrop(e, colId) {
        e.preventDefault();
        if (_dragOverFrame) {
            cancelAnimationFrame(_dragOverFrame);
            flushDropIndicator();
        }
        _pendingDropPosition = null;
        const taskId = e.dataTransfer.getData('text/plain') || _dragTaskId;
        if (!taskId) return;
        const col = findCol(colId);
        if (col) col.classList.remove('drag-over');
        const p = state.currentProject;
        if (!p) return;
        // Determine new order
        const tasksEl = findColPart(colId, '.proj-col-tasks');
        const line = tasksEl && tasksEl.querySelector('.proj-drop-line');
        let newOrder = 0;
        if (tasksEl) {
            const cards = Array.from(tasksEl.querySelectorAll('.proj-task-card'));
            if (line) {
                const idx = cards.indexOf(line.previousElementSibling);
                newOrder = idx + 1;
            } else {
                newOrder = cards.filter(c => c.dataset.taskId !== taskId).length;
            }
            tasksEl.querySelectorAll('.proj-drop-line').forEach(l => l.remove());
        }
        // Optimistic update
        const task = p.tasks.find(t => t.id === taskId);
        if (!task) return;
        const oldColId = task.columnId;
        task.columnId = colId;
        // Re-sort tasks in affected columns
        const colTasks = p.tasks.filter(t => t.columnId === colId && t.id !== taskId).sort((a, b) => (a.order || 0) - (b.order || 0));
        colTasks.splice(newOrder, 0, task);
        colTasks.forEach((t, i) => t.order = i);
        // Re-render board
        rerenderBoard();
        // Persist only the column it went to (v0.10.1 saves): sending every task's column
        // from this copy undid moves made meanwhile by agents, the workflow or another tab.
        const updates = colTasks.map(t => (t.id === taskId ? { id: t.id, columnId: colId, order: t.order } : { id: t.id, order: t.order }));
        api.reorderTasks(p.id, updates).catch(() => toast('Save failed', 'error'));
        // Also update task's columnId via task update for activity log
        if (oldColId !== colId) {
            api.updateTask(p.id, taskId, { columnId: colId, order: task.order }).then(result => {
                // Check if a score was awarded (task moved to Done)
                if (result && result.task && result.task._scoreAwarded) {
                    animateTaskComplete(taskId, result.task._scoreAwarded);
                    populateBoardScoreboard();
                }
            }).catch(() => {});
            // Check if target is a "done" column and show preview animation
            const targetCol = p.columns.find(c => c.id === colId);
            if (targetCol && ['done', 'completed', 'verified', 'published', 'fixed', 'closed'].includes(String(targetCol.title || '').toLowerCase())) {
                // Optimistic complete animation (full one triggers after API confirms score)
                const card = findTaskCard(taskId);
                if (card) card.classList.add('anim-complete');
            }
        }
    }

    // ── TOUCH DRAG ────────────────────────────────────────────────
    let _touchTask = null;
    let _touchGhost = null;
    let _touchLongPressTimer = null;
    let _touchActive = false;
    let _touchTarget = null;

    function detachTouchListeners() {
        if (!_touchTarget) return;
        _touchTarget.removeEventListener('touchmove', onTouchMove);
        _touchTarget.removeEventListener('touchend', onTouchEnd);
        _touchTarget.removeEventListener('touchcancel', onTouchEnd);
        _touchTarget = null;
    }

    function onTouchStart(e, taskId) {
        clearTimeout(_touchLongPressTimer);
        detachTouchListeners();
        _touchLongPressTimer = setTimeout(() => {
            _touchActive = true;
            _touchTask = taskId;
            const card = findTaskCard(taskId);
            if (!card) return;
            // Create ghost
            _touchGhost = card.cloneNode(true);
            _touchGhost.removeAttribute('data-action');
            _touchGhost.removeAttribute('data-task-id');
            _touchGhost.id = 'proj-touch-ghost';
            _touchGhost.className = card.className + ' drag-ghost';
            _touchGhost.style.cssText = `position:fixed;pointer-events:none;z-index:10000;width:${card.offsetWidth}px;opacity:0.85;transform:rotate(2deg);`;
            document.body.appendChild(_touchGhost);
            card.style.opacity = '0.3';
        }, 400);
        _touchTarget = e.target;
        _touchTarget.addEventListener('touchmove', onTouchMove, { passive: false });
        _touchTarget.addEventListener('touchend', onTouchEnd);
        _touchTarget.addEventListener('touchcancel', onTouchEnd);
    }

    function onTouchMove(e) {
        clearTimeout(_touchLongPressTimer);
        if (!_touchActive || !_touchGhost) return;
        e.preventDefault();
        const touch = e.touches[0];
        _touchGhost.style.left = (touch.clientX - 20) + 'px';
        _touchGhost.style.top = (touch.clientY - 20) + 'px';
        // Find column under finger
        _touchGhost.style.display = 'none';
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        _touchGhost.style.display = '';
        // Highlight target col
        document.querySelectorAll('.proj-col').forEach(c => c.classList.remove('drag-over'));
        const colEl = el && el.closest('.proj-col[data-col-id]');
        if (colEl) colEl.classList.add('drag-over');
    }

    function onTouchEnd(e) {
        clearTimeout(_touchLongPressTimer);
        detachTouchListeners();
        if (!_touchActive || !_touchTask) { _touchActive = false; return; }
        // The browser may still send a click for this touch: do not open the task.
        state.suppressClickUntil = Date.now() + 500;
        const touch = e.changedTouches && e.changedTouches[0];
        if (_touchGhost) { _touchGhost.remove(); _touchGhost = null; }
        document.querySelectorAll('.proj-col').forEach(c => c.classList.remove('drag-over'));
        const card = findTaskCard(_touchTask);
        if (card) card.style.opacity = '';
        // Find drop target
        const el = touch && e.type !== 'touchcancel' ? document.elementFromPoint(touch.clientX, touch.clientY) : null;
        const colEl = el && el.closest('.proj-col[data-col-id]');
        if (colEl) {
            const colId = colEl.dataset.colId;
            simulateDrop(_touchTask, colId);
        }
        _touchTask = null;
        _touchActive = false;
    }

    function simulateDrop(taskId, colId) {
        const p = state.currentProject;
        if (!p) return;
        const task = p.tasks.find(t => t.id === taskId);
        if (!task || task.columnId === colId) return;
        const oldColId = task.columnId;
        task.columnId = colId;
        const colTasks = p.tasks.filter(t => t.columnId === colId).sort((a, b) => (a.order || 0) - (b.order || 0));
        colTasks.forEach((t, i) => t.order = i);
        const mc = getMainContent();
        rerenderBoard();
        const updates = colTasks.map(t => (t.id === taskId ? { id: t.id, columnId: colId, order: t.order } : { id: t.id, order: t.order }));
        api.reorderTasks(p.id, updates).catch(() => {});
        if (oldColId !== colId) {
            api.updateTask(p.id, taskId, { columnId: colId }).then(result => {
                if (result && result.task && result.task._scoreAwarded) {
                    animateTaskComplete(taskId, result.task._scoreAwarded);
                    populateBoardScoreboard();
                }
            }).catch(() => {});
            // Optimistic complete animation for done columns
            const targetCol = p.columns.find(c => c.id === colId);
            if (targetCol && ['done', 'completed', 'verified', 'published', 'fixed', 'closed'].includes(String(targetCol.title || '').toLowerCase())) {
                const card = findTaskCard(taskId);
                if (card) card.classList.add('anim-complete');
            }
        }
    }

    // ── QUICK ADD ─────────────────────────────────────────────────
    function showQuickAdd(colId) {
        const qa = findColPart(colId, '.proj-quick-add');
        if (!qa) return;
        qa.classList.remove('hidden');
        const inp = findColPart(colId, '.proj-quick-add-input');
        if (inp) inp.focus();
    }
    function hideQuickAdd(colId) {
        const qa = findColPart(colId, '.proj-quick-add');
        if (!qa) return;
        const hadFocus = qa.contains(document.activeElement);
        qa.classList.add('hidden');
        if (hadFocus) {
            const addBtn = findColPart(colId, '.proj-col-add-btn');
            if (addBtn) addBtn.focus({ preventScroll: true });
        }
    }
    async function submitQuickAdd(colId) {
        const inp = findColPart(colId, '.proj-quick-add-input');
        const title = inp && inp.value.trim();
        if (!title) { hideQuickAdd(colId); return; }
        const p = state.currentProject;
        if (!p) return;
        try {
            const d = await api.createTask(p.id, { title, columnId: colId });
            if (d.task) {
                p.tasks.push(d.task);
                const mc = getMainContent();
                rerenderBoard();
                animateTaskSpawn(d.task.id);
                toast('Task added', 'success');
                populateBoardScoreboard();
            }
        } catch (e) { toast('Failed to add task', 'error'); }
    }

    // ── COLUMN MANAGEMENT ─────────────────────────────────────────
    async function addColumn() {
        const p = state.currentProject;
        if (!p) return;
        const raw = await uiPrompt({ title: 'New column', label: 'Column title', value: '' });
        const title = raw && raw.trim();
        if (!title) return;
        const colors = ['#6c757d', '#0d6efd', '#ffc107', '#fd7e14', '#198754', '#17a2b8', '#dc3545'];
        const color = colors[p.columns.length % colors.length];
        const newCol = { id: genId(), title, color, order: p.columns.length };
        p.columns.push(newCol);
        try {
            await api.updateColumns(p.id, p.columns);
            const mc = getMainContent();
            rerenderBoard();
        } catch (e) { toast('Failed to add column', 'error'); }
    }

    function renameColumn(colId) {
        const p = state.currentProject;
        if (!p) return;
        const col = p.columns.find(c => c.id === colId);
        if (!col) return;
        const titleEl = findColPart(colId, '.proj-col-title');
        if (!titleEl) return;
        const inp = document.createElement('input');
        inp.className = 'proj-col-title-input';
        inp.value = col.title;
        titleEl.replaceWith(inp);
        inp.focus();
        inp.select();
        async function save() {
            const newTitle = inp.value.trim() || col.title;
            col.title = newTitle;
            try { await api.updateColumns(p.id, p.columns); } catch (e) {}
            const mc = getMainContent();
            rerenderBoard();
        }
        inp.onblur = save;
        inp.onkeydown = (e) => {
            if (e.key === 'Enter') inp.blur();
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); inp.value = col.title; inp.blur(); }
        };
    }

    // ── TASK DETAIL PANEL ─────────────────────────────────────────
    function openTaskDetail(taskId) {
        const p = state.currentProject;
        if (!p) return;
        const task = p.tasks.find(t => t.id === taskId);
        if (!task) return;
        const panel = document.getElementById('proj-detail-panel');
        const wasOpen = !!(panel && panel.classList.contains('open') && state.currentTask);
        if (state.currentTask && state.currentTask.id !== task.id) flushPendingTaskEdits();
        state.currentTask = task;
        renderDetailPanel(task);
        if (!panel) return;
        panel.classList.add('open');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Task detail');
        if (!wasOpen) {
            const closeBtn = panel.querySelector('.proj-detail-close');
            if (closeBtn) closeBtn.focus({ preventScroll: true });
        }
    }

    function closeDetailPanel() {
        const task = state.currentTask;
        const panel = document.getElementById('proj-detail-panel');
        if (task) flushPendingTaskEdits();
        state.currentTask = null;
        if (panel) panel.dataset.taskId = '';
        if (!panel || !panel.classList.contains('open')) return;
        const hadFocus = panel.contains(document.activeElement);
        panel.classList.remove('open');
        if (hadFocus) {
            const card = task && findTaskCard(task.id);
            if (card) card.focus({ preventScroll: true });
            else focusFirstInMain();
        }
    }

    /** Save a title or description edit that is still waiting for its debounce. */
    function flushPendingTaskEdits() {
        if (state._titleTimer) {
            clearTimeout(state._titleTimer);
            state._titleTimer = null;
            const titleEl = document.getElementById('detail-title');
            const value = titleEl && titleEl.value.trim();
            if (value && state.currentTask && value !== state.currentTask.title) saveTaskField('title', value);
        }
        if (state._descAutoSaveTimer) {
            clearTimeout(state._descAutoSaveTimer);
            state._descAutoSaveTimer = null;
            saveDescription();
        }
    }

    function renderDetailPanel(task) {
        const panel = document.getElementById('proj-detail-panel');
        if (!panel) return;
        const sameTask = !!task && panel.dataset.taskId === String(task.id);
        // Preserve unsaved description text from textarea before re-render
        // (only when re-rendering the same task, never into another task).
        const existingDescEl = document.getElementById('detail-desc');
        if (existingDescEl && sameTask) {
            task.description = existingDescEl.value;
        }
        // Keep drafts, focus and scroll when the same task re-renders (poll refresh, checklist toggle).
        const drafts = {};
        let focusId = '';
        let focusSel = null;
        let bodyScroll = 0;
        if (sameTask) {
            ['detail-title', 'detail-comment-input', 'new-checklist-item', 'detail-tag-in'].forEach(id => {
                const el = document.getElementById(id);
                if (el && el.value && (id !== 'detail-title' || state._titleTimer)) drafts[id] = el.value;
            });
            const active = document.activeElement;
            if (active && panel.contains(active) && active.id) {
                focusId = active.id;
                if (typeof active.selectionStart === 'number') focusSel = [active.selectionStart, active.selectionEnd];
            }
            const bodyEl = panel.querySelector('.proj-detail-body');
            bodyScroll = bodyEl ? bodyEl.scrollTop : 0;
        }
        panel.dataset.taskId = task ? String(task.id) : '';
        const p = state.currentProject;
        const cols = (p && p.columns) || [];
        const agents = (state.agentRoster || []).filter(a => a && agentValue(a));
        const checklist = Array.isArray(task.checklist) ? task.checklist : [];
        const checkDone = checklist.filter(c => c && c.done).length;
        const checkPct = checklist.length ? Math.round(checkDone / checklist.length * 100) : 0;
        const comments = Array.isArray(task.comments) ? task.comments.filter(c => c && typeof c === 'object') : [];
        const hasReview = Array.isArray(task.reviewCheck) && task.reviewCheck.length > 0;
        const lastReview = Array.isArray(task.lastReviewCheck) ? task.lastReviewCheck : [];
        const reviewItems = (hasReview ? task.reviewCheck : lastReview).filter(rc => rc && typeof rc === 'object');
        const reviewTitle = hasReview ? '🔍 Review Check' : (lastReview.length ? '🕘 Last Failed Review' : '🔍 Review Check');
        const activity = (p && Array.isArray(p.activity) ? p.activity : []).filter(a => a && a.taskId === task.id).slice().reverse().slice(0, 20);
        const priority = safePriority(task.priority);
        const assigneeKnown = !task.assignee || agents.some(a => agentValue(a) === task.assignee);
        const reviewOptions = [
            ['pass', '✅ Pass'],
            ['needs_more_work', '⚠️ Needs More Work'],
            ['did_not_pass', '❌ Did Not Pass'],
            ['requires_user_review', '👤 Requires User Review'],
        ];

        panel.innerHTML = `
        <div class="proj-detail-header">
            <span class="proj-detail-kicker">Task Detail</span>
            <div class="proj-detail-header-actions">
                <button class="proj-btn proj-btn-sm proj-btn-danger" data-action="delete-current-task">${icon('close')}Delete</button>
                <button class="proj-btn proj-btn-sm" data-action="duplicate-task" data-task-id="${escHtml(task.id)}">${icon('list')}Duplicate</button>
                <button class="proj-detail-close" data-action="close-detail" aria-label="Close task detail" title="Close (Esc)">${icon('close')}</button>
            </div>
        </div>
        <div class="proj-detail-body">
            <input class="proj-detail-title-input" id="detail-title" aria-label="Task title" value="${escHtml(task.title)}" placeholder="Task title">

            <div class="proj-section">
                <div class="proj-field">
                    <label class="proj-field-label" for="detail-col">Column</label>
                    <select class="proj-detail-select" id="detail-col" data-change="task-field" data-field="columnId">
                        ${cols.map(c => `<option value="${escHtml(c.id)}" ${selectedAttr(task.columnId === c.id)}>${escHtml(c.title)}</option>`).join('')}
                    </select>
                </div>
                <div class="proj-field-row">
                    <div class="proj-field">
                        <label class="proj-field-label" for="detail-pri">Priority</label>
                        <select class="proj-detail-select" id="detail-pri" data-change="task-field" data-field="priority">
                            <option value="critical" ${selectedAttr(priority === 'critical')}>Critical</option>
                            <option value="high" ${selectedAttr(priority === 'high')}>High</option>
                            <option value="medium" ${selectedAttr(priority === 'medium')}>Medium</option>
                            <option value="low" ${selectedAttr(priority === 'low')}>Low</option>
                        </select>
                    </div>
                    <div class="proj-field">
                        <label class="proj-field-label" for="detail-due">Due Date</label>
                        <input class="proj-detail-input" type="date" id="detail-due" value="${safeDateValue(task.dueDate)}" data-change="task-field" data-field="dueDate">
                    </div>
                </div>
                <div class="proj-field">
                    <label class="proj-field-label" for="detail-assignee">Assignee</label>
                    <select class="proj-detail-select" id="detail-assignee" data-change="task-field" data-field="assignee">
                        <option value="">— Unassigned —</option>
                        ${agents.map(a => `<option value="${escHtml(agentValue(a))}" ${selectedAttr(task.assignee === agentValue(a))}>${escHtml((a.emoji || '👤') + ' ' + (a.name || agentValue(a)))}</option>`).join('')}
                        ${assigneeKnown ? '' : `<option value="${escHtml(task.assignee)}" selected>👥 Other agent (not in this office)</option>`}
                    </select>
                </div>
                <div class="proj-field">
                    <label class="proj-field-label" for="detail-tag-in">Tags</label>
                    <div class="proj-tag-input-wrap" id="detail-tags-wrap" data-action="focus-tag-input">
                        ${tagList(task.tags).map((t, i) => `<span class="proj-tag">${escHtml(t)}<button type="button" class="tag-remove" data-action="remove-tag" data-index="${i}" aria-label="Remove tag ${escHtml(t)}">×</button></span>`).join('')}
                        <input class="proj-tag-input" id="detail-tag-in" placeholder="Add tag…" data-keydown="tag-input">
                    </div>
                </div>
            </div>

            <div class="proj-section">
                <div class="proj-section-header"><span class="proj-section-title">📝 Description</span></div>
                <div class="proj-desc-tabs" role="tablist">
                    <button class="proj-desc-tab active" id="desc-tab-edit" role="tab" data-action="desc-tab" data-tab="edit">Edit</button>
                    <button class="proj-desc-tab" id="desc-tab-preview" role="tab" data-action="desc-tab" data-tab="preview">Preview</button>
                </div>
                <textarea class="proj-detail-textarea" id="detail-desc" rows="4" aria-label="Task description" placeholder="Task description (Markdown supported)">${escHtml(task.description || '')}</textarea>
                <div class="proj-desc-preview hidden" id="detail-desc-preview">${simpleMarkdown(task.description || '')}</div>
                <div class="proj-section-actions">
                    <button class="proj-btn proj-btn-sm proj-btn-gold" id="detail-desc-save" data-action="save-description">${icon('save')}Save</button>
                </div>
            </div>

            <div class="proj-section">
                <div class="proj-section-header">
                    <span class="proj-section-title">✅ Checklist</span>
                    <span class="proj-section-meta">${checkDone}/${checklist.length}</span>
                </div>
                ${checklist.length ? `
                <div class="proj-checklist-progress">
                    <div class="proj-checklist-progress-track">
                        <div class="proj-checklist-progress-fill" style="width:${checkPct}%"></div>
                    </div>
                    <span class="proj-section-meta">${checkPct}%</span>
                </div>` : ''}
                <ul class="proj-checklist" id="detail-checklist">
                    ${checklist.map((c, i) => `
                    <li class="proj-checklist-item ${c && c.done ? 'done' : ''}">
                        <input type="checkbox" aria-label="Done" ${c && c.done ? 'checked' : ''} data-change="checklist-toggle" data-index="${i}">
                        <span class="proj-checklist-item-text" data-dblclick="edit-checklist" data-index="${i}" title="Double-click to edit">${escHtml(c && c.text)}</span>
                        <button class="proj-checklist-edit" data-action="edit-checklist" data-index="${i}" title="Edit" aria-label="Edit item">${icon('edit')}</button>
                        <button class="proj-checklist-delete" data-action="delete-checklist" data-index="${i}" title="Delete" aria-label="Delete item">×</button>
                    </li>`).join('')}
                </ul>
                <div class="proj-inline-add">
                    <input class="proj-detail-input" id="new-checklist-item" type="text" aria-label="New checklist item" placeholder="Add checklist item…" data-keydown="checklist-input">
                    <button class="proj-btn proj-btn-sm" data-action="add-checklist">Add</button>
                </div>
            </div>

            ${reviewItems.length ? `
            <div class="proj-section">
                <div class="proj-section-header"><span class="proj-section-title">${reviewTitle}</span></div>
                <div class="proj-review-check-list" id="detail-review-check">
                    ${reviewItems.map((rc, i) => {
                        const status = safeReviewStatus(rc.status);
                        const icon = {'pass':'✅','needs_more_work':'⚠️','did_not_pass':'❌','requires_user_review':'👤'}[status] || '❓';
                        const statusClass = 'review-' + status.replace(/_/g, '-');
                        return `
                        <div class="proj-review-item ${statusClass}">
                            <span class="proj-review-icon">${icon}</span>
                            <span class="proj-review-text">${escHtml(rc.text)}</span>
                            ${hasReview ? `
                            <select class="proj-review-select" aria-label="Review result" data-change="review-status" data-index="${i}">
                                ${reviewOptions.map(([value, label]) => `<option value="${value}" ${selectedAttr(status === value)}>${label}</option>`).join('')}
                            </select>` : `<span class="proj-review-note">preserved from prior review</span>`}
                        </div>`;
                    }).join('')}
                </div>
                ${hasReview ? `
                <div class="proj-section-actions">
                    <button class="proj-btn proj-btn-sm proj-btn-gold" data-action="save-review">${icon('save')}Save Review</button>
                </div>` : ''}
            </div>` : ''}

            <div class="proj-section">
                <div class="proj-section-header"><span class="proj-section-title">💬 Comments</span></div>
                <div class="proj-comments-list" id="detail-comments">
                    ${comments.length === 0 ? '<div class="proj-muted-note">No comments yet</div>' : ''}
                    ${comments.map(c => `
                    <div class="proj-comment">
                        <div class="proj-comment-header">
                            <span class="proj-comment-author">${escHtml(commentAuthor(c.author))}</span>
                            <span class="proj-comment-time">${escHtml(timeAgo(c.createdAt))}</span>
                        </div>
                        <div class="proj-comment-text">${simpleMarkdown(c.text)}</div>
                    </div>`).join('')}
                </div>
                <textarea class="proj-detail-textarea" id="detail-comment-input" rows="2" aria-label="New comment" placeholder="Add a comment… (Markdown supported)"></textarea>
                <div class="proj-section-actions">
                    <button class="proj-btn proj-btn-sm proj-btn-gold" data-action="submit-comment">Post Comment</button>
                </div>
            </div>

            ${activity.length > 0 ? `
            <div class="proj-section">
                <div class="proj-section-header"><span class="proj-section-title">📜 Activity</span></div>
                <div class="proj-activity-list">
                    ${activity.map(a => `
                    <div class="proj-activity-item">
                        <div class="proj-activity-dot"></div>
                        <span class="proj-activity-time">${escHtml(timeAgo(a.at))}</span>
                        <span>${escHtml(a.detail)}</span>
                    </div>`).join('')}
                </div>
            </div>` : ''}
        </div>`;

        Object.keys(drafts).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = drafts[id];
        });
        if (bodyScroll) {
            const bodyEl = panel.querySelector('.proj-detail-body');
            if (bodyEl) bodyEl.scrollTop = bodyScroll;
        }
        if (focusId) {
            const el = document.getElementById(focusId);
            if (el && panel.contains(el)) {
                el.focus({ preventScroll: true });
                if (focusSel && typeof el.setSelectionRange === 'function') {
                    try { el.setSelectionRange(focusSel[0], focusSel[1]); } catch (e) { /* not a text field */ }
                }
            }
        }

        // Bind title auto-save
        const titleEl = document.getElementById('detail-title');
        if (titleEl) {
            titleEl.oninput = () => {
                clearTimeout(state._titleTimer);
                state._titleTimer = setTimeout(() => {
                    state._titleTimer = null;
                    if (titleEl.value.trim()) saveTaskField('title', titleEl.value.trim());
                }, 800);
            };
        }

        // Bind description auto-save (debounced)
        const descEl = document.getElementById('detail-desc');
        if (descEl) {
            descEl.oninput = () => {
                clearTimeout(state._descAutoSaveTimer);
                state._descAutoSaveTimer = setTimeout(() => {
                    state._descAutoSaveTimer = null;
                    saveDescription();
                }, 1500);
            };
        }
    }

    /** Comment authors are "user", "workflow", an agent id or a free-text name. */
    function commentAuthor(author) {
        if (!author || author === 'user') return 'You';
        if (author === 'workflow') return '⚙️ Workflow';
        const agent = resolveAgent(author);
        if (agent) return `${agent.emoji} ${agent.name}`;
        return String(author);
    }

    function switchDescTab(tab) {
        const editArea = document.getElementById('detail-desc');
        const preview = document.getElementById('detail-desc-preview');
        const editTab = document.getElementById('desc-tab-edit');
        const prevTab = document.getElementById('desc-tab-preview');
        if (tab === 'preview') {
            if (editArea) editArea.classList.add('hidden');
            if (preview) { preview.classList.remove('hidden'); preview.innerHTML = simpleMarkdown(editArea && editArea.value || ''); }
            if (editTab) editTab.classList.remove('active');
            if (prevTab) prevTab.classList.add('active');
        } else {
            if (editArea) editArea.classList.remove('hidden');
            if (preview) preview.classList.add('hidden');
            if (editTab) editTab.classList.add('active');
            if (prevTab) prevTab.classList.remove('active');
        }
    }

    async function saveDescription() {
        const el = document.getElementById('detail-desc');
        if (!el) { toast('Description field not found', 'error'); return; }
        if (!state.currentTask || !state.currentProject) { toast('No task selected', 'error'); return; }
        const desc = el.value;
        // Ensure currentTask references the live project task (handles stale refs after poll refresh)
        const liveTask = state.currentProject.tasks.find(t => t.id === state.currentTask.id);
        if (liveTask && liveTask !== state.currentTask) {
            state.currentTask = liveTask;
        }
        const task = state.currentTask;
        const projId = state.currentProject.id;
        const taskId = task.id;
        task.description = desc;
        // Visual feedback: disable save button during save
        const saveBtn = el.parentElement && el.parentElement.querySelector('.proj-btn-gold');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
        try {
            await queueTaskUpdate(projId, taskId, { description: desc });
            // Also update the card on the board
            const cardEl = findTaskCard(taskId);
            if (cardEl) {
                const newCard = document.createElement('div');
                newCard.innerHTML = renderTaskCard(task);
                const rendered = newCard.firstElementChild;
                if (rendered) cardEl.replaceWith(rendered);
            }
            if (saveBtn) { saveBtn.innerHTML = icon('check') + 'Saved'; }
            toast('Description saved', 'success');
            setTimeout(() => { if (saveBtn) { saveBtn.innerHTML = icon('save') + 'Save'; saveBtn.disabled = false; } }, 1500);
        } catch (e) {
            if (saveBtn) { saveBtn.innerHTML = icon('save') + 'Save'; saveBtn.disabled = false; }
            toast('Failed to save description', 'error');
        }
    }

    // One update at a time per task, in order (v0.10.1 saves): two quick checklist or tag
    // saves (whole lists) could land out of order and the older list won. Fields asked for
    // while one is on its way go together in the next update, each with its latest value.
    const taskSaves = new Map();
    function queueTaskUpdate(projectId, taskId, body) {
        let q = taskSaves.get(taskId);
        if (!q) { q = { chain: Promise.resolve(), pending: null, waiting: null }; taskSaves.set(taskId, q); }
        if (q.pending) { Object.assign(q.pending, body); return q.waiting; }
        q.pending = Object.assign({}, body);
        q.waiting = q.chain.then(() => {
            const send = q.pending;
            q.pending = null;
            return api.updateTask(projectId, taskId, send);
        });
        q.chain = q.waiting.catch(() => {});
        return q.waiting;
    }

    async function saveTaskField(field, value) {
        let task = state.currentTask;
        const p = state.currentProject;
        if (!task || !p) return;
        // Ensure we reference the live task object (handles stale refs after poll refresh)
        const liveTask = p.tasks.find(t => t.id === task.id);
        if (liveTask && liveTask !== task) {
            state.currentTask = liveTask;
            task = liveTask;
        }
        task[field] = value;
        try {
            await queueTaskUpdate(p.id, task.id, { [field]: value });
            // Re-render board card
            const cardEl = findTaskCard(task.id);
            if (cardEl) {
                const newCard = document.createElement('div');
                newCard.innerHTML = renderTaskCard(task);
                const rendered = newCard.firstElementChild;
                if (rendered) cardEl.replaceWith(rendered);
            }
        } catch (e) { toast('Save failed', 'error'); }
    }

    async function updateTaskField(field, value) {
        await saveTaskField(field, value);
        if (field === 'columnId') {
            // Re-render board
            const mc = getMainContent();
            rerenderBoard();
            // Re-open detail panel
            const task = state.currentTask;
            if (task) { openTaskDetail(task.id); }
        }
    }

    // Checklist
    async function toggleChecklistItem(idx, done) {
        const task = state.currentTask;
        if (!task || !Array.isArray(task.checklist) || !task.checklist[idx]) return;
        task.checklist[idx].done = done;
        const li = document.querySelectorAll('#detail-checklist .proj-checklist-item')[idx];
        if (li) li.classList.toggle('done', done);
        await saveTaskField('checklist', task.checklist);
        renderDetailPanel(task);
    }
    async function deleteChecklistItem(idx) {
        const task = state.currentTask;
        if (!task || !Array.isArray(task.checklist) || !(idx >= 0 && idx < task.checklist.length)) return;
        task.checklist.splice(idx, 1);
        await saveTaskField('checklist', task.checklist);
        renderDetailPanel(task);
    }
    async function addChecklistItem() {
        const inp = document.getElementById('new-checklist-item');
        const text = inp && inp.value.trim();
        if (!text) return;
        const task = state.currentTask;
        if (!task) return;
        if (!task.checklist) task.checklist = [];
        task.checklist.push({ id: genId(), text, done: false });
        if (inp) inp.value = '';
        await saveTaskField('checklist', task.checklist);
        renderDetailPanel(task);
    }

    function editChecklistItem(idx) {
        const task = state.currentTask;
        if (!task || !task.checklist || !task.checklist[idx]) return;
        const item = task.checklist[idx];
        const li = document.querySelectorAll('#detail-checklist .proj-checklist-item')[idx];
        if (!li) return;
        const textSpan = li.querySelector('.proj-checklist-item-text');
        if (!textSpan) return;
        // Replace text span with an input
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'proj-checklist-edit-input';
        inp.value = item.text;
        textSpan.replaceWith(inp);
        inp.focus();
        inp.select();
        // Hide edit button while editing
        const editBtn = li.querySelector('.proj-checklist-edit');
        if (editBtn) editBtn.style.display = 'none';

        async function save() {
            const newText = inp.value.trim();
            if (newText && newText !== item.text) {
                item.text = newText;
                await saveTaskField('checklist', task.checklist);
            }
            renderDetailPanel(task);
        }
        inp.onblur = save;
        inp.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); inp.value = item.text; inp.blur(); }
        };
    }

    // Tags
    function handleTagKey(e) {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const val = e.target.value.trim().replace(/,$/, '');
            if (val) addTag(val);
        }
    }
    async function addTag(tag) {
        const task = state.currentTask;
        if (!task) return;
        if (!task.tags) task.tags = [];
        if (task.tags.includes(tag)) return;
        task.tags.push(tag);
        const inp = document.getElementById('detail-tag-in');
        if (inp) inp.value = '';
        await saveTaskField('tags', task.tags);
        renderDetailPanel(task);
    }
    async function removeTag(tag) {
        const task = state.currentTask;
        if (!task || !task.tags) return;
        task.tags = task.tags.filter(t => t !== tag);
        await saveTaskField('tags', task.tags);
        renderDetailPanel(task);
    }

    // Comments
    async function submitComment() {
        const inp = document.getElementById('detail-comment-input');
        const text = inp && inp.value.trim();
        if (!text) return;
        const task = state.currentTask;
        const p = state.currentProject;
        if (!task || !p) return;
        try {
            const d = await api.addComment(p.id, task.id, { text, author: 'user' });
            if (d.comment) {
                if (!task.comments) task.comments = [];
                task.comments.push(d.comment);
                if (inp) inp.value = '';
                renderDetailPanel(task);
                toast('Comment added', 'success');
            }
        } catch (e) { toast('Failed to add comment', 'error'); }
    }

    // Delete / Duplicate task
    async function deleteCurrentTask() {
        const task = state.currentTask;
        const p = state.currentProject;
        if (!task || !p) return;
        const ok = await uiConfirm({ title: 'Delete task?', body: `"${String(task.title || 'Untitled')}" will be removed from this project.`, okLabel: 'Delete', danger: true });
        if (!ok || !state.currentTask || state.currentTask.id !== task.id) return;
        try {
            closeDetailPanel();
            // Animate the deletion first
            await animateTaskDelete(task.id);
            await api.deleteTask(p.id, task.id);
            p.tasks = p.tasks.filter(t => t.id !== task.id);
            const mc = getMainContent();
            rerenderBoard();
            toast('Task deleted', 'success');
            populateBoardScoreboard();
        } catch (e) { toast('Failed to delete task', 'error'); }
    }
    async function duplicateTask(taskId) {
        const p = state.currentProject;
        if (!p) return;
        const src = p.tasks.find(t => t.id === taskId);
        if (!src) return;
        const copy = { title: src.title + ' (copy)', description: src.description, columnId: src.columnId, priority: src.priority, tags: [...(src.tags || [])], checklist: (src.checklist || []).map(c => ({ ...c, id: genId(), done: false })) };
        try {
            const d = await api.createTask(p.id, copy);
            if (d.task) { p.tasks.push(d.task); const mc = getMainContent(); rerenderBoard(); toast('Task duplicated', 'success'); }
        } catch (e) { toast('Failed to duplicate', 'error'); }
    }

    // ── NEW PROJECT DIALOG ────────────────────────────────────────
    function newProjectDialog(templateId) {
        showFormModal('new-project', {}, templateId);
    }

    function editProjectDialog(id) {
        const p = state.currentProject || state.projects.find(x => x.id === id);
        if (!p) return;
        showFormModal('edit-project', p);
    }

    function showFormModal(type, data, extra) {
        const overlay = document.getElementById('proj-form-overlay');
        if (!overlay) return;
        if (overlay.classList.contains('hidden')) {
            const active = document.activeElement;
            state.formOpener = active && active !== document.body ? active : null;
        }
        overlay.classList.remove('hidden');
        data = data || {};
        const status = safeStatus(data.status);
        const priority = safePriority(data.priority);
        const box = (formName, titleId, inner, maxWidth) => `
            <div class="proj-form-modal proj-form-inner" style="position:static;padding:0;background:transparent" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
            <form class="proj-form-box${maxWidth ? ' proj-form-box-narrow' : ''}" data-form="${formName}" novalidate>
                ${inner}
            </form>
            </div>`;

        if (type === 'new-project') {
            overlay.innerHTML = box('new-project', 'pf-heading', `
                <div class="proj-form-title" id="pf-heading">📋 NEW PROJECT</div>
                <div class="proj-form-group">
                    <label class="proj-form-label" for="pf-title">Title *</label>
                    <input class="proj-form-input" id="pf-title" type="text" placeholder="Project title" required>
                </div>
                <div class="proj-form-group">
                    <label class="proj-form-label" for="pf-desc">Description</label>
                    <textarea class="proj-form-textarea" id="pf-desc" placeholder="What is this project about?"></textarea>
                </div>
                <div class="proj-form-row">
                    <div class="proj-form-group">
                        <label class="proj-form-label" for="pf-status">Status</label>
                        <select class="proj-form-select" id="pf-status">
                            <option value="active">Active</option>
                            <option value="paused">Paused</option>
                        </select>
                    </div>
                    <div class="proj-form-group">
                        <label class="proj-form-label" for="pf-priority">Priority</label>
                        <select class="proj-form-select" id="pf-priority">
                            <option value="critical">Critical</option>
                            <option value="high">High</option>
                            <option value="medium" selected>Medium</option>
                            <option value="low">Low</option>
                        </select>
                    </div>
                </div>
                <div class="proj-form-row">
                    <div class="proj-form-group">
                        <label class="proj-form-label" for="pf-due">Due Date</label>
                        <input class="proj-form-input" id="pf-due" type="date">
                    </div>
                    <div class="proj-form-group">
                        <label class="proj-form-label" for="pf-tags">Tags (comma-sep)</label>
                        <input class="proj-form-input" id="pf-tags" type="text" placeholder="tag1, tag2">
                    </div>
                </div>
                ${extra ? `<input type="hidden" id="pf-template-id" value="${escHtml(extra)}">` : ''}
                <div class="proj-form-actions">
                    <button type="button" class="proj-btn" data-action="hide-form">Cancel</button>
                    <button type="submit" class="proj-btn proj-btn-primary">Create Project</button>
                </div>`);
            focusById('pf-title');

        } else if (type === 'edit-project') {
            overlay.innerHTML = box('edit-project', 'pf-heading', `
                <div class="proj-form-title" id="pf-heading">✏️ EDIT PROJECT</div>
                <div class="proj-form-group">
                    <label class="proj-form-label" for="pf-title">Title *</label>
                    <input class="proj-form-input" id="pf-title" type="text" value="${escHtml(data.title || '')}" required>
                </div>
                <div class="proj-form-group">
                    <label class="proj-form-label" for="pf-desc">Description</label>
                    <textarea class="proj-form-textarea" id="pf-desc">${escHtml(data.description || '')}</textarea>
                </div>
                <div class="proj-form-row">
                    <div class="proj-form-group">
                        <label class="proj-form-label" for="pf-status">Status</label>
                        <select class="proj-form-select" id="pf-status">
                            <option value="active" ${selectedAttr(status === 'active')}>Active</option>
                            <option value="paused" ${selectedAttr(status === 'paused')}>Paused</option>
                            <option value="completed" ${selectedAttr(status === 'completed')}>Completed</option>
                            <option value="archived" ${selectedAttr(status === 'archived')}>Archived</option>
                        </select>
                    </div>
                    <div class="proj-form-group">
                        <label class="proj-form-label" for="pf-priority">Priority</label>
                        <select class="proj-form-select" id="pf-priority">
                            <option value="critical" ${selectedAttr(priority === 'critical')}>Critical</option>
                            <option value="high" ${selectedAttr(priority === 'high')}>High</option>
                            <option value="medium" ${selectedAttr(priority === 'medium')}>Medium</option>
                            <option value="low" ${selectedAttr(priority === 'low')}>Low</option>
                        </select>
                    </div>
                </div>
                <div class="proj-form-row">
                    <div class="proj-form-group">
                        <label class="proj-form-label" for="pf-due">Due Date</label>
                        <input class="proj-form-input" id="pf-due" type="date" value="${safeDateValue(data.dueDate)}">
                    </div>
                    <div class="proj-form-group">
                        <label class="proj-form-label" for="pf-tags">Tags (comma-sep)</label>
                        <input class="proj-form-input" id="pf-tags" type="text" value="${escHtml(tagList(data.tags).join(', '))}">
                    </div>
                </div>
                <input type="hidden" id="pf-edit-id" value="${escHtml(data.id || '')}">
                <div class="proj-form-actions">
                    <button type="button" class="proj-btn" data-action="hide-form">Cancel</button>
                    <button type="submit" class="proj-btn proj-btn-primary">Save Changes</button>
                </div>`);
            focusById('pf-title');

        } else if (type === 'save-template') {
            overlay.innerHTML = box('save-template', 'pf-heading', `
                <div class="proj-form-title" id="pf-heading">💾 SAVE AS TEMPLATE</div>
                <div class="proj-form-group">
                    <label class="proj-form-label" for="pf-tpl-title">Template Name</label>
                    <input class="proj-form-input" id="pf-tpl-title" type="text" value="${escHtml(String(data.title || 'Project') + ' Template')}" required>
                </div>
                <div class="proj-form-group">
                    <label class="proj-form-label" for="pf-tpl-desc">Description</label>
                    <textarea class="proj-form-textarea" id="pf-tpl-desc" placeholder="What is this template for?">${escHtml(data.description || '')}</textarea>
                </div>
                <input type="hidden" id="pf-tpl-proj-id" value="${escHtml(data.id || '')}">
                <div class="proj-form-actions">
                    <button type="button" class="proj-btn" data-action="hide-form">Cancel</button>
                    <button type="submit" class="proj-btn proj-btn-primary">Save Template</button>
                </div>`, true);
            focusById('pf-tpl-title');
        }
    }

    function focusById(id) {
        const el = document.getElementById(id);
        if (el) el.focus({ preventScroll: true });
    }

    function isFormOpen() {
        const overlay = document.getElementById('proj-form-overlay');
        return !!(overlay && !overlay.classList.contains('hidden'));
    }

    function hideFormModal() {
        const overlay = document.getElementById('proj-form-overlay');
        if (!overlay) return;
        const wasOpen = !overlay.classList.contains('hidden');
        const hadFocus = overlay.contains(document.activeElement);
        overlay.innerHTML = '';
        overlay.classList.add('hidden');
        const opener = state.formOpener;
        state.formOpener = null;
        if (wasOpen && (hadFocus || document.activeElement === document.body) && opener && opener.isConnected && isModalOpen()) {
            opener.focus({ preventScroll: true });
        }
    }

    /** <input type=date> value -> ISO string at noon UTC, so the day does not shift across time zones. */
    function dateInputToIso(value) {
        return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? `${value}T12:00:00.000Z` : null;
    }

    function fieldValue(id) {
        const el = document.getElementById(id);
        return el ? String(el.value || '') : '';
    }

    function readProjectForm() {
        return {
            title: fieldValue('pf-title').trim(),
            description: fieldValue('pf-desc'),
            status: safeStatus(fieldValue('pf-status')),
            priority: safePriority(fieldValue('pf-priority')),
            dueDate: dateInputToIso(fieldValue('pf-due')),
            tags: fieldValue('pf-tags').split(',').map(t => t.trim()).filter(Boolean),
        };
    }

    function setFormBusy(busy) {
        const btn = document.querySelector('#proj-form-overlay button[type="submit"]');
        if (btn) btn.disabled = !!busy;
    }

    async function submitNewProject() {
        const body = readProjectForm();
        if (!body.title) { toast('Title is required', 'error'); focusById('pf-title'); return; }
        const templateId = fieldValue('pf-template-id');
        setFormBusy(true);
        try {
            const d = templateId
                ? await api.createFromTemplate({ ...body, templateId })
                : await api.createProject(body);
            if (!d || !d.project) throw new Error((d && d.error) || 'No project returned');
            hideFormModal();
            toast('Project created!', 'success');
            await openProject(d.project.id);
        } catch (e) {
            setFormBusy(false);
            toast('Failed to create project', 'error');
        }
    }

    async function submitEditProject() {
        const id = fieldValue('pf-edit-id');
        const body = readProjectForm();
        if (!id) return;
        if (!body.title) { toast('Title is required', 'error'); focusById('pf-title'); return; }
        setFormBusy(true);
        try {
            const d = await api.updateProject(id, body);
            if (d && d.error) throw new Error(d.error);
            hideFormModal();
            if (state.currentProject && state.currentProject.id === id) Object.assign(state.currentProject, body);
            toast('Project updated!', 'success');
            if (state.view === 'board') { rerenderBoard(); populateBoardScoreboard(); }
            else { showListView(); }
        } catch (e) {
            setFormBusy(false);
            toast('Failed to update project', 'error');
        }
    }

    // ── PROJECT CRUD ──────────────────────────────────────────────
    function projectTitle(id) {
        const p = (state.currentProject && state.currentProject.id === id) ? state.currentProject : state.projects.find(x => x && x.id === id);
        return p && p.title ? String(p.title) : 'this project';
    }

    async function archiveProject(id, e) {
        if (e && e.stopPropagation) e.stopPropagation();
        const ok = await uiConfirm({ title: 'Archive project?', body: `"${projectTitle(id)}" moves to Archived. You can find it with the status filter.`, okLabel: 'Archive' });
        if (!ok) return;
        try {
            await api.updateProject(id, { status: 'archived' });
            toast('Project archived', 'success');
            showListView();
        } catch (err) { toast('Failed to archive', 'error'); }
    }

    async function deleteProject(id, e) {
        if (e && e.stopPropagation) e.stopPropagation();
        const ok = await uiConfirm({ title: 'Delete project?', body: `"${projectTitle(id)}" and all of its tasks will be deleted. This cannot be undone.`, okLabel: 'Delete', danger: true });
        if (!ok) return;
        try {
            await api.deleteProject(id);
            toast('Project deleted', 'success');
            showListView();
        } catch (err) { toast('Failed to delete', 'error'); }
    }

    function filterChange(key, value) {
        if (!Object.prototype.hasOwnProperty.call(state.filters, key)) return;
        state.filters[key] = String(value || '');
        const mc = getMainContent();
        if (!mc || state.view !== 'list') return;
        if (key === 'search') {
            // Only refresh the cards so the search box keeps focus and caret.
            const grid = mc.querySelector('.proj-grid');
            if (grid) { grid.innerHTML = renderProjectGrid(); return; }
        }
        mc.innerHTML = renderListView();
        const sel = mc.querySelector(`select[data-filter="${cssEsc(key)}"]`);
        if (sel) sel.focus({ preventScroll: true });
    }

    function backToList() { closeDetailPanel(); showListView(); }

    // ── TEMPLATES VIEW ────────────────────────────────────────────
    async function showTemplatesView() {
        const token = nextViewToken();
        state.view = 'templates';
        closeDetailPanel();
        stopWorkflowPolling();
        const mc = getMainContent();
        if (!mc) return;
        mc.innerHTML = renderListSkeleton();
        try {
            const d = await api.listTemplates();
            state.templates = Array.isArray(d && d.templates) ? d.templates.filter(t => t && typeof t === 'object') : [];
        } catch (e) { state.templates = []; }
        if (!isCurrentView(token)) return;
        mc.innerHTML = renderTemplatesView();
    }

    function renderTemplatesView() {
        // Merge: start with client-side defaults, then add server templates not already present
        const seenIds = new Set(DEFAULT_TEMPLATES.map(t => t.id));
        const serverOnly = state.templates.filter(t => !seenIds.has(t.id));
        const all = [...DEFAULT_TEMPLATES, ...serverOnly];
        return `
        <div class="proj-toolbar">
            <button class="proj-btn" data-action="back-to-list"><span class="proj-icon-back">${icon('chev')}</span>Back to Projects</button>
            <span class="proj-toolbar-title proj-subview-title">${icon('grid')}Templates</span>
        </div>
        <div class="proj-list-body">
            <div class="proj-view-intro">Choose a template to create a new project, or save your current project as a template.</div>
            <div class="proj-tpl-grid">
                ${all.map(tpl => renderTemplateCard(tpl)).join('')}
            </div>
        </div>`;
    }

    function renderTemplateCard(tpl) {
        const isBuiltin = DEFAULT_TEMPLATES.some(t => t.id === tpl.id);
        const id = escHtml(tpl.id);
        const columns = Array.isArray(tpl.columns) ? tpl.columns.filter(c => c && typeof c === 'object') : [];
        return `
        <div class="proj-tpl-card">
            <div class="proj-tpl-title">${escHtml(tpl.title)}</div>
            <div class="proj-tpl-desc">${escHtml(tpl.description || '')}</div>
            <div class="proj-tpl-cols">
                ${columns.map(c => {
                    const color = hexBase(c.color);
                    return `<span class="proj-tpl-col-chip" style="background:${color}22;border-color:${color}55;color:${color}">${escHtml(c.title)}</span>`;
                }).join('')}
            </div>
            <div class="proj-tpl-actions">
                <button class="proj-btn proj-btn-sm proj-btn-primary" data-action="use-template" data-id="${id}">Use Template</button>
                ${!isBuiltin ? `<button class="proj-btn proj-btn-sm proj-btn-danger" data-action="delete-template" data-id="${id}">Delete</button>` : ''}
            </div>
        </div>`;
    }

    async function deleteTemplate(id) {
        const tpl = state.templates.find(t => t.id === id);
        const ok = await uiConfirm({ title: 'Delete template?', body: `"${tpl && tpl.title ? String(tpl.title) : 'This template'}" will be removed. Projects made from it stay.`, okLabel: 'Delete', danger: true });
        if (!ok) return;
        try {
            await api.deleteTemplate(id);
            state.templates = state.templates.filter(t => t.id !== id);
            const mc = getMainContent();
            if (mc && state.view === 'templates') mc.innerHTML = renderTemplatesView();
            toast('Template deleted', 'success');
        } catch (e) { toast('Failed to delete template', 'error'); }
    }

    function saveAsTemplateDialog(projectId) {
        const p = state.currentProject || state.projects.find(x => x.id === projectId);
        if (!p) return;
        showFormModal('save-template', p);
    }

    async function submitSaveTemplate() {
        const title = fieldValue('pf-tpl-title').trim();
        const projectId = fieldValue('pf-tpl-proj-id');
        const desc = fieldValue('pf-tpl-desc');
        if (!title) { toast('Template name is required', 'error'); focusById('pf-tpl-title'); return; }
        setFormBusy(true);
        try {
            const d = await api.saveTemplate({ title, description: desc, projectId });
            if (d && d.error) throw new Error(d.error);
            hideFormModal();
            toast('Template saved!', 'success');
        } catch (e) {
            setFormBusy(false);
            toast('Failed to save template', 'error');
        }
    }

    // ── REPORT VIEW ───────────────────────────────────────────────
    async function showReport(id) {
        const token = nextViewToken();
        const mc = getMainContent();
        if (!mc) return;
        state.view = 'report';
        closeDetailPanel();
        stopWorkflowPolling();
        mc.innerHTML = renderListSkeleton();
        try {
            const d = await api.getReport(id);
            if (!isCurrentView(token)) return;
            if (!d || !d.report) throw new Error('No report');
            mc.innerHTML = renderReportView(d.report);
        } catch (e) {
            if (!isCurrentView(token)) return;
            mc.innerHTML = `<div class="proj-loading"><div>⚠️ Failed to generate report</div><button class="proj-btn" data-action="back-to-list">← Back to Projects</button></div>`;
        }
    }

    function renderReportView(r) {
        const stats = (r && r.stats) || {};
        const columns = Array.isArray(r && r.columns) ? r.columns.filter(c => c && typeof c === 'object') : [];
        const timeline = Array.isArray(r && r.timeline) ? r.timeline.filter(t => t && typeof t === 'object') : [];
        const title = r && r.title;
        // Merge workload by office agent; ids outside the office become one "Other agents" row.
        const workload = new Map();
        let otherCount = 0;
        let otherIds = 0;
        Object.entries((r && r.agentWorkload) || {}).forEach(([agentId, count]) => {
            const agent = resolveAgent(agentId);
            if (!agent) { otherCount += num(count); otherIds += 1; return; }
            const label = `${agent.emoji} ${agent.name}`;
            workload.set(label, (workload.get(label) || 0) + num(count));
        });
        if (otherIds) workload.set('👥 ' + otherAgentsLabel(otherIds), otherCount);
        const maxColCount = Math.max(...columns.map(c => num(c.count)), 1);
        const maxAgentCount = Math.max(...workload.values(), 1);
        const generated = r && r.generatedAt ? new Date(r.generatedAt) : null;
        const generatedText = generated && !isNaN(generated.getTime()) ? generated.toLocaleString() : '';

        return `
        <div class="proj-toolbar">
            <button class="proj-btn" data-action="back-to-list"><span class="proj-icon-back">${icon('chev')}</span>Back</button>
            <span class="proj-toolbar-title proj-subview-title">${icon('log')}Report</span>
            <div class="proj-toolbar-spacer"></div>
            <button class="proj-btn proj-btn-sm" data-action="export-report">${icon('save')}Export Markdown</button>
        </div>
        <div class="proj-report-body">
            <div class="proj-report-header">
                <div>
                    <div class="proj-report-title">${escHtml(title)}</div>
                    ${generatedText ? `<div class="proj-report-subtitle">Generated ${escHtml(generatedText)}</div>` : ''}
                </div>
            </div>

            <div class="proj-stats-grid">
                <div class="proj-stat-card">
                    <div class="proj-stat-value">${num(stats.total)}</div>
                    <div class="proj-stat-label">Total Tasks</div>
                </div>
                <div class="proj-stat-card">
                    <div class="proj-stat-value proj-stat-done">${num(stats.done)}</div>
                    <div class="proj-stat-label">Completed</div>
                </div>
                <div class="proj-stat-card">
                    <div class="proj-stat-value proj-stat-progress">${num(stats.inProgress)}</div>
                    <div class="proj-stat-label">In Progress</div>
                </div>
                <div class="proj-stat-card">
                    <div class="proj-stat-value proj-stat-overdue">${num(stats.overdue)}</div>
                    <div class="proj-stat-label">Overdue</div>
                </div>
            </div>

            <div class="proj-chart-section">
                <div class="proj-chart-title">📊 Tasks by Column</div>
                <div class="proj-bar-chart">
                    ${columns.map(c => {
                        const count = num(c.count);
                        return `
                    <div class="proj-bar-row">
                        <div class="proj-bar-label" title="${escHtml(c.title)}">${escHtml(c.title)}</div>
                        <div class="proj-bar-track">
                            <div class="proj-bar-fill" style="width:${Math.round(count / maxColCount * 100)}%;background:${safeColor(c.color)}">${count}</div>
                        </div>
                        <div class="proj-bar-count">${count}</div>
                    </div>`;
                    }).join('')}
                </div>
            </div>

            ${workload.size ? `
            <div class="proj-chart-section">
                <div class="proj-chart-title">👥 Agent Workload</div>
                <div class="proj-bar-chart">
                    ${[...workload.entries()].map(([label, count]) => `
                    <div class="proj-bar-row">
                        <div class="proj-bar-label" title="${escHtml(label)}">${escHtml(label)}</div>
                        <div class="proj-bar-track">
                            <div class="proj-bar-fill proj-bar-fill-agent" style="width:${Math.round(count / maxAgentCount * 100)}%"></div>
                        </div>
                        <div class="proj-bar-count">${count}</div>
                    </div>`).join('')}
                </div>
            </div>` : ''}

            ${timeline.length ? `
            <div class="proj-chart-section">
                <div class="proj-chart-title">📅 Timeline</div>
                <div class="proj-timeline">
                    ${timeline.map(t => {
                        const over = t.dueDate && !t.completedAt && isOverdue(t.dueDate);
                        const priority = safePriority(t.priority);
                        return `
                        <div class="proj-tl-item ${t.completedAt ? 'completed' : over ? 'overdue' : ''}">
                            <div class="proj-tl-title">${escHtml(t.title)}</div>
                            <div class="proj-tl-meta">
                                <span>📅 ${escHtml(formatDate(t.dueDate))}</span>
                                ${t.assignee ? `<span>${escHtml(agentLabel(t.assignee))}</span>` : ''}
                                <span class="proj-badge proj-badge-xs badge-${priority}">${priority}</span>
                                ${t.completedAt ? `<span class="proj-tl-done">✅ Done</span>` : over ? `<span class="proj-tl-overdue">⚠️ Overdue</span>` : ''}
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>` : ''}
        </div>`;
    }

    function exportReport() {
        const mc = getMainContent();
        if (!mc) return;
        // Build markdown from DOM
        const title = mc.querySelector('.proj-report-title');
        const stats = mc.querySelectorAll('.proj-stat-card');
        let md = `# ${title ? title.textContent : 'Project Report'}\n\n`;
        md += `*Generated: ${new Date().toLocaleString()}*\n\n`;
        md += `## Stats\n\n`;
        stats.forEach(s => {
            const val = s.querySelector('.proj-stat-value');
            const lbl = s.querySelector('.proj-stat-label');
            if (val && lbl) md += `- **${lbl.textContent}:** ${val.textContent}\n`;
        });
        // Copy to clipboard
        navigator.clipboard.writeText(md).then(() => toast('Report copied to clipboard!', 'success')).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = md;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            toast('Report copied!', 'success');
        });
    }

    // ── SIDEBAR ───────────────────────────────────────────────────
    function updateSidebar() {
        const el = document.getElementById('sidebar-projects-list');
        if (!el) return;
        bindSidebar(el);
        const active = state.projects.filter(p => p && p.status === 'active').slice(0, 5);
        if (active.length === 0) {
            el.innerHTML = '<div class="sidebar-proj-empty">No active projects</div>';
            return;
        }
        el.innerHTML = active.map(p => {
            const total = num(p.taskCount);
            const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(num(p.taskDone) / total * 100))) : 0;
            return `
            <div class="sidebar-proj-item" data-project-id="${escHtml(p.id)}" tabindex="0" role="button" aria-label="Open project ${escHtml(p.title)}">
                <div class="proj-dot" style="background:${priorityColor(safePriority(p.priority))}"></div>
                <span class="proj-name">${escHtml(p.title)}</span>
                <span class="proj-progress-mini">${pct}%</span>
            </div>`;
        }).join('');
    }

    function bindSidebar(el) {
        if (el.dataset.projBound) return;
        el.dataset.projBound = '1';
        const open = (item) => {
            const id = item && item.dataset.projectId;
            if (id) openProjectsManager({ projectId: id });
        };
        el.addEventListener('click', e => open(e.target.closest('.sidebar-proj-item[data-project-id]')));
        el.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const item = e.target.closest('.sidebar-proj-item[data-project-id]');
            if (!item) return;
            e.preventDefault();
            open(item);
        });
    }

    // Init sidebar on load
    (async function initSidebar() {
        ensureBound();
        try {
            const d = await api.listProjects('active');
            state.projects = Array.isArray(d && d.projects) ? d.projects : [];
            updateSidebar();
            // Also load agent roster for leaderboard names
            await loadAgentRoster();
            refreshLeaderboard();
        } catch (e) { /* non-fatal */ }
    })();

    // ── GLOBAL KEYBOARD ───────────────────────────────────────────
    /** Close the topmost Projects layer: form, then task detail, then the board. */
    function closeTopLayer() {
        if (!isModalOpen()) return false;
        if (isFormOpen()) { hideFormModal(); return true; }
        const panel = document.getElementById('proj-detail-panel');
        if (state.currentTask || (panel && panel.classList.contains('open'))) { closeDetailPanel(); return true; }
        closeProjectsModal();
        return true;
    }

    /**
     * One Escape handler for the whole board, registered in the capture phase
     * so it runs before the generic VOUI window handler (which would close the
     * whole board). It marks the event handled with preventDefault.
     */
    function handleGlobalKeys(e) {
        if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
        if (!isModalOpen()) return;
        // A VOUI confirm/prompt we opened is on top: let it handle Escape.
        if (state.dialogDepth > 0) return;
        const modal = getModal();
        const target = e.target;
        const targetIsPage = !target || target === document || target === document.body || target === document.documentElement;
        // Another window above the board has focus: not ours.
        if (!targetIsPage && target.nodeType === 1 && !modal.contains(target)) return;
        // Inline editors cancel their own edit on Escape.
        if (!targetIsPage && target.closest && target.closest('.proj-col-title-input, .proj-checklist-edit-input, .proj-quick-add-input')) return;
        e.preventDefault();
        closeTopLayer();
    }

    // ── DELEGATED EVENTS ──────────────────────────────────────────
    // Every control in the board carries data-action / data-change /
    // data-keydown / data-dblclick and is handled here, so no server value
    // ever ends up inside an inline handler string.
    function currentTaskIndex(el) {
        const i = parseInt(el.dataset.index, 10);
        return Number.isInteger(i) && i >= 0 ? i : -1;
    }

    const CLICK_ACTIONS = {
        'none': () => {},
        'new-project': () => newProjectDialog(),
        'show-templates': () => showTemplatesView(),
        'open-project': el => el.dataset.id && openProject(el.dataset.id),
        'show-report': el => el.dataset.id && showReport(el.dataset.id),
        'archive-project': el => el.dataset.id && archiveProject(el.dataset.id),
        'delete-project': el => el.dataset.id && deleteProject(el.dataset.id),
        'back-to-list': () => backToList(),
        'workflow-start': () => workflowStartAction(),
        'workflow-stop': () => workflowStopAction(),
        'edit-project': el => editProjectDialog(el.dataset.id),
        'save-template': el => saveAsTemplateDialog(el.dataset.id),
        'toggle-desc': el => {
            const desc = el.nextElementSibling;
            if (!desc) return;
            const expanded = desc.classList.toggle('expanded');
            el.textContent = expanded ? '▲ Hide description' : '▼ Show description';
            el.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        },
        'show-quick-add': el => showQuickAdd(el.dataset.colId),
        'submit-quick-add': el => submitQuickAdd(el.dataset.colId),
        'hide-quick-add': el => hideQuickAdd(el.dataset.colId),
        'open-task': el => {
            if (Date.now() < (state.suppressClickUntil || 0)) return;
            openTaskDetail(el.dataset.taskId);
        },
        'delete-current-task': () => deleteCurrentTask(),
        'duplicate-task': el => duplicateTask(el.dataset.taskId),
        'close-detail': () => closeDetailPanel(),
        'focus-tag-input': () => focusById('detail-tag-in'),
        'remove-tag': el => {
            const task = state.currentTask;
            const tag = task && tagList(task.tags)[currentTaskIndex(el)];
            if (tag !== undefined) removeTag(tag);
        },
        'desc-tab': el => switchDescTab(el.dataset.tab === 'preview' ? 'preview' : 'edit'),
        'save-description': () => {
            clearTimeout(state._descAutoSaveTimer);
            state._descAutoSaveTimer = null;
            saveDescription();
        },
        'edit-checklist': el => editChecklistItem(currentTaskIndex(el)),
        'delete-checklist': el => deleteChecklistItem(currentTaskIndex(el)),
        'add-checklist': () => addChecklistItem(),
        'save-review': () => saveReviewCheckAction(),
        'submit-comment': () => submitComment(),
        'hide-form': () => hideFormModal(),
        'use-template': el => el.dataset.id && newProjectDialog(el.dataset.id),
        'delete-template': el => el.dataset.id && deleteTemplate(el.dataset.id),
        'export-report': () => exportReport(),
    };

    const CHANGE_ACTIONS = {
        'filter': el => filterChange(el.dataset.filter, el.value),
        'auto-mode': el => toggleAutoModeAction(!!el.checked),
        'task-field': el => {
            const field = el.dataset.field;
            if (field === 'dueDate') updateTaskField('dueDate', dateInputToIso(el.value));
            else if (field === 'assignee') updateTaskField('assignee', el.value || null);
            else if (field === 'priority') updateTaskField('priority', safePriority(el.value));
            else if (field === 'columnId') updateTaskField('columnId', el.value);
        },
        'checklist-toggle': el => toggleChecklistItem(currentTaskIndex(el), !!el.checked),
        'review-status': el => updateReviewItemStatusAction(currentTaskIndex(el), safeReviewStatus(el.value)),
    };

    const KEYDOWN_ACTIONS = {
        'tag-input': (el, e) => handleTagKey(e),
        'checklist-input': (el, e) => { if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); } },
        'quick-add': (el, e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitQuickAdd(el.dataset.colId); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideQuickAdd(el.dataset.colId); }
        },
    };

    const DBLCLICK_ACTIONS = {
        'rename-column': el => renameColumn(el.dataset.colId),
        'edit-checklist': el => editChecklistItem(currentTaskIndex(el)),
    };

    const FORM_ACTIONS = {
        'new-project': () => submitNewProject(),
        'edit-project': () => submitEditProject(),
        'save-template': () => submitSaveTemplate(),
    };

    function actionTarget(e, attr, root) {
        const el = e.target && e.target.closest ? e.target.closest(`[${attr}]`) : null;
        return el && root.contains(el) ? el : null;
    }

    function ensureBound() {
        const root = getModal();
        if (!root || root.dataset.projBound) return;
        root.dataset.projBound = '1';

        root.addEventListener('click', e => {
            const el = actionTarget(e, 'data-action', root);
            if (!el) return;
            const fn = CLICK_ACTIONS[el.dataset.action];
            if (!fn) return;
            if (el.tagName === 'BUTTON' || el.tagName === 'A') e.preventDefault();
            fn(el, e);
        });
        root.addEventListener('change', e => {
            const el = actionTarget(e, 'data-change', root);
            const fn = el && CHANGE_ACTIONS[el.dataset.change];
            if (fn) fn(el, e);
        });
        root.addEventListener('input', e => {
            const el = actionTarget(e, 'data-input', root);
            if (el && el.dataset.input === 'search') filterChange('search', el.value);
        });
        root.addEventListener('keydown', e => {
            const keyEl = actionTarget(e, 'data-keydown', root);
            const keyFn = keyEl && KEYDOWN_ACTIONS[keyEl.dataset.keydown];
            if (keyFn) { keyFn(keyEl, e); return; }
            // Enter / Space on card-like elements that act as buttons.
            if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="button"][data-action]')) {
                e.preventDefault();
                const fn = CLICK_ACTIONS[e.target.dataset.action];
                if (fn) fn(e.target, e);
            }
        });
        root.addEventListener('dblclick', e => {
            const el = actionTarget(e, 'data-dblclick', root);
            const fn = el && DBLCLICK_ACTIONS[el.dataset.dblclick];
            if (fn) fn(el, e);
        });
        root.addEventListener('submit', e => {
            const form = e.target && e.target.closest ? e.target.closest('form[data-form]') : null;
            if (!form) return;
            e.preventDefault();
            const fn = FORM_ACTIONS[form.dataset.form];
            if (fn) fn();
        });

        // Drag and drop between columns (HTML5) and long-press drag on touch.
        root.addEventListener('dragstart', e => {
            const card = e.target.closest && e.target.closest('.proj-task-card[data-task-id]');
            if (card && root.contains(card)) onDragStart(e, card.dataset.taskId);
        });
        root.addEventListener('dragend', e => {
            if (_dragTaskId) onDragEnd(e);
        });
        root.addEventListener('dragover', e => {
            if (!_dragTaskId) return;
            const col = e.target.closest && e.target.closest('.proj-col[data-col-id]');
            if (col) onDragOver(e, col.dataset.colId);
        });
        root.addEventListener('dragleave', e => {
            if (!_dragTaskId) return;
            const col = e.target.closest && e.target.closest('.proj-col[data-col-id]');
            if (col) onDragLeave(e, col.dataset.colId);
        });
        root.addEventListener('drop', e => {
            const col = e.target.closest && e.target.closest('.proj-col[data-col-id]');
            if (col && _dragTaskId) onDrop(e, col.dataset.colId);
        });
        root.addEventListener('touchstart', e => {
            const card = e.target.closest && e.target.closest('.proj-task-card[data-task-id]');
            if (card && root.contains(card)) onTouchStart(e, card.dataset.taskId);
        }, { passive: true });

        document.addEventListener('keydown', handleGlobalKeys, true);
    }

    // ── WORKFLOW CONTROLS ──────────────────────────────────────────

    async function workflowStartAction() {
        const p = state.currentProject;
        if (!p) return;
        const autoMode = document.getElementById('wf-auto-toggle');
        const isAuto = autoMode ? autoMode.checked : false;
        try {
            const d = await api.workflowStart(p.id, isAuto);
            if (d.error) { toast(d.error, 'error'); return; }
            toast('Workflow started!', 'success');
            state.workflow.active = true;
            state.workflow.autoMode = isAuto;
            updateWorkflowUI();
            startWorkflowPolling();
        } catch (e) { toast('Failed to start workflow', 'error'); }
    }

    async function workflowStopAction() {
        const p = state.currentProject;
        if (!p) return;
        try {
            await api.workflowStop(p.id);
            toast('Workflow stopped', 'info');
            state.workflow.active = false;
            state.workflow.phase = 'stopped';
            updateWorkflowUI();
            stopWorkflowPolling();
        } catch (e) { toast('Failed to stop workflow', 'error'); }
    }

    async function toggleAutoModeAction(enabled) {
        const p = state.currentProject;
        if (!p) return;
        try {
            await api.setAutoMode(p.id, enabled);
            state.workflow.autoMode = enabled;
            p.autoMode = enabled;
            toast(`Auto Mode ${enabled ? 'ON' : 'OFF'}`, 'info');
        } catch (e) { toast('Failed to toggle auto mode', 'error'); }
    }

    function startWorkflowPolling() {
        stopWorkflowPolling();
        state.workflow.pollTimer = setInterval(pollWorkflowStatus, 3000);
    }

    function stopWorkflowPolling() {
        if (state.workflow.pollTimer) {
            clearInterval(state.workflow.pollTimer);
            state.workflow.pollTimer = null;
        }
    }

    async function pollWorkflowStatus() {
        const p = state.currentProject;
        if (!p) { stopWorkflowPolling(); return; }
        try {
            const d = await api.workflowStatus(p.id);
            const prevPhase = state.workflow.phase;
            const prevTaskId = state.workflow.currentTaskId;
            state.workflow.active = d.active;
            state.workflow.autoMode = d.autoMode;
            state.workflow.phase = d.phase;
            state.workflow.currentTaskId = d.currentTaskId;
            state.workflow.error = d.error;
            updateWorkflowUI();

            // If task moved or phase changed, refresh board
            if (d.active && (d.currentTaskId !== prevTaskId || d.phase !== prevPhase)) {
                const fresh = await api.getProject(p.id);
                if (fresh.project) {
                    state.currentProject = fresh.project;
                    if (state.currentTask && state.currentTask.id) {
                        const liveTask = fresh.project.tasks.find(t => t.id === state.currentTask.id);
                        if (liveTask) {
                            state.currentTask = liveTask;
                            renderDetailPanel(liveTask);
                        }
                    }
                    if (state.view === 'board') {
                        rerenderBoard();
                        populateBoardScoreboard();
                    }
                }
            }

            // Update active column indicator
            updateActiveColumnIndicator();

            // Poll workflow chat
            pollWorkflowChat();

            // Stop polling if workflow ended
            if (!d.active && d.phase !== 'awaiting_user_review') {
                stopWorkflowPolling();
                // Final board refresh
                const fresh = await api.getProject(p.id);
                if (fresh.project) {
                    state.currentProject = fresh.project;
                    if (state.view === 'board') {
                        rerenderBoard();
                        populateBoardScoreboard();
                    }
                }
                clearActiveColumnIndicator();
            }
        } catch (e) { /* silent */ }
    }

    async function pollWorkflowChat() {
        const p = state.currentProject;
        if (!p) return;
        try {
            const d = await api.workflowChat(p.id);
            renderWorkflowChat(d);
        } catch (e) { /* silent */ }
    }

    function renderWorkflowChat(data) {
        const container = document.getElementById('proj-wf-chat-messages');
        const liveDot = document.getElementById('proj-chat-live-dot');
        if (!container) return;

        const msgs = (Array.isArray(data && data.messages) ? data.messages : []).filter(m => m && typeof m === 'object');
        const isActive = !!(data && data.phase && data.phase !== 'idle' && data.phase !== 'stopped');

        if (liveDot) {
            liveDot.className = 'proj-wf-chat-live' + (isActive ? ' live' : '');
        }

        if (msgs.length === 0) {
            container.innerHTML = '<div class="proj-chat-empty">Workflow chat will appear here when a task is being worked on.</div>';
            return;
        }

        const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 20;

        container.innerHTML = msgs.map(m => {
            const isAssistant = m.role === 'assistant';
            const isUser = m.role === 'user';
            const isTool = m.role === 'tool' || m.role === 'toolCall';
            let cls = 'proj-chat-msg';
            if (isAssistant) cls += ' msg-assistant';
            else if (isUser) cls += ' msg-user';
            else if (isTool) cls += ' msg-tool';

            let text = m.text == null ? '' : String(m.text);
            // Truncate very long messages
            if (text.length > 500) text = text.substring(0, 500) + '…';
            text = escHtml(text);

            // Format timestamp in user's local timezone
            let timeStr = '';
            if (m.timestamp) {
                const d = new Date(m.timestamp);
                if (!isNaN(d.getTime())) {
                    timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                }
            }
            const timeHtml = timeStr ? `<span class="proj-chat-msg-time">${escHtml(timeStr)}</span>` : '';

            // Show tool calls as activity indicators
            let toolHtml = '';
            const tools = Array.isArray(m.tools) ? m.tools.filter(t => t && t.name) : [];
            if (tools.length > 0) {
                const toolNames = tools.map(t => '🔧 ' + escHtml(t.name)).join(', ');
                toolHtml = `<div class="proj-chat-msg-tools">${toolNames}</div>`;
            }

            return `<div class="${cls}">
                ${timeHtml}
                <div class="proj-chat-msg-text">${text}</div>
                ${toolHtml}
            </div>`;
        }).join('');

        // Auto-scroll if was at bottom
        if (wasAtBottom) {
            container.scrollTop = container.scrollHeight;
        }
    }

    function updateActiveColumnIndicator() {
        // Clear all active indicators
        document.querySelectorAll('.proj-col-header').forEach(h => h.classList.remove('col-active-work'));

        if (!state.workflow.active || !state.workflow.currentTaskId || !state.currentProject) return;

        // Find which column the current task is in
        const task = state.currentProject.tasks.find(t => t.id === state.workflow.currentTaskId);
        if (!task) return;
        const colEl = findCol(task.columnId);
        if (colEl) {
            const header = colEl.querySelector('.proj-col-header');
            if (header) header.classList.add('col-active-work');
        }
    }

    function clearActiveColumnIndicator() {
        document.querySelectorAll('.proj-col-header').forEach(h => h.classList.remove('col-active-work'));
    }

    function updateWorkflowUI() {
        const startBtn = document.getElementById('wf-start-btn');
        const stopBtn = document.getElementById('wf-stop-btn');
        const badge = document.getElementById('wf-status-badge');
        const autoToggle = document.getElementById('wf-auto-toggle');

        if (startBtn) {
            if (state.workflow.active) { startBtn.classList.add('hidden'); }
            else { startBtn.classList.remove('hidden'); }
        }
        if (stopBtn) {
            if (state.workflow.active) { stopBtn.classList.remove('hidden'); }
            else { stopBtn.classList.add('hidden'); }
        }
        if (autoToggle) {
            autoToggle.checked = state.workflow.autoMode;
        }
        if (badge) {
            const phase = state.workflow.phase || 'idle';
            const phaseLabels = {
                'idle': '',
                'starting': '🔄 Starting...',
                'dispatching': '📤 Sending to agent...',
                'in_progress': '⚙️ Agent working...',
                'reviewing': '🔍 Reviewing...',
                'reworking': '🔧 Reworking...',
                'awaiting_user_review': '👤 Needs Your Review',
                'task_done': '✅ Task Complete',
                'stopped': '⏹ Stopped',
                'stalled': '⚠️ Stalled — click Start to resume',
                'error': '❌ Error',
            };
            badge.textContent = phaseLabels[phase] || phase;
            badge.className = 'proj-wf-status' + (state.workflow.active ? ' wf-active' : '') + (phase === 'awaiting_user_review' ? ' wf-attention' : '') + (phase === 'error' ? ' wf-error' : '');
            if (state.workflow.error && phase === 'error') {
                badge.title = state.workflow.error;
            }
        }
    }

    // Review Check functions
    async function updateReviewItemStatusAction(index, newStatus) {
        const task = state.currentTask;
        const p = state.currentProject;
        if (!task || !p || !Array.isArray(task.reviewCheck) || !task.reviewCheck[index]) return;
        task.reviewCheck[index].status = newStatus;
        renderDetailPanel(task);
    }

    async function saveReviewCheckAction() {
        const task = state.currentTask;
        const p = state.currentProject;
        if (!task || !p || !task.reviewCheck) return;
        try {
            await api.updateReviewCheck(p.id, task.id, task.reviewCheck);
            toast('Review check saved', 'success');
        } catch (e) { toast('Failed to save review check', 'error'); }
    }

    // Check workflow status when opening a board (handles page refresh)
    async function checkWorkflowOnOpen() {
        const p = state.currentProject;
        if (!p) return;
        try {
            const d = await api.workflowStatus(p.id);
            state.workflow.active = d.active;
            state.workflow.autoMode = d.autoMode;
            state.workflow.phase = d.phase || 'idle';
            state.workflow.currentTaskId = d.currentTaskId;
            state.workflow.error = d.error;
            updateWorkflowUI();
            updateActiveColumnIndicator();

            // Start polling if workflow is active OR if there are tasks in progress
            // (handles page refresh — workflow thread is still running server-side)
            const needsPolling = d.active
                || d.phase === 'awaiting_user_review'
                || d.phase === 'in_progress'
                || d.phase === 'reviewing'
                || d.phase === 'reworking'
                || d.phase === 'dispatching';
            if (needsPolling) {
                startWorkflowPolling();
                pollWorkflowChat();
            } else {
                // Even if not actively running, fetch chat once to show last session
                pollWorkflowChat();
            }
        } catch (e) { /* silent */ }
    }

    // ── PUBLIC API ────────────────────────────────────────────────
    window.ProjMgr = {
        openProjectsManager,
        closeProjectsModal,
        showListView,
        openProject,
        backToList,
        newProjectDialog,
        editProjectDialog,
        deleteProject,
        archiveProject,
        filterChange,
        showTemplatesView,
        showReport,
        exportReport,
        saveAsTemplateDialog,
        submitSaveTemplate,
        deleteTemplate,
        openTaskDetail,
        closeDetailPanel,
        updateTaskField,
        saveDescription,
        switchDescTab,
        toggleChecklistItem,
        deleteChecklistItem,
        addChecklistItem,
        editChecklistItem,
        handleTagKey,
        addTag,
        removeTag,
        submitComment,
        deleteCurrentTask,
        duplicateTask,
        addColumn,
        renameColumn,
        showQuickAdd,
        hideQuickAdd,
        submitQuickAdd,
        hideFormModal,
        submitNewProject,
        submitEditProject,
        // Drag & drop
        onDragStart,
        onDragEnd,
        onDragOver,
        onDragLeave,
        onDrop,
        onTouchStart,
        // Gamification
        refreshLeaderboard,
        // Workflow
        workflowStart: workflowStartAction,
        workflowStop: workflowStopAction,
        toggleAutoMode: toggleAutoModeAction,
        updateReviewItemStatus: updateReviewItemStatusAction,
        saveReviewCheck: saveReviewCheckAction,
    };

})();
