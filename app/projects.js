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
            const card = document.getElementById(`task-${taskId}`);
            if (card) {
                card.classList.add('anim-spawn');
                card.addEventListener('animationend', () => card.classList.remove('anim-spawn'), { once: true });
            }
        });
    }

    /** Animate a task card deletion (returns promise that resolves when animation done) */
    function animateTaskDelete(taskId) {
        return new Promise(resolve => {
            const card = document.getElementById(`task-${taskId}`);
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
            const card = document.getElementById(`task-${taskId}`);
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
                    const agentInfo = state.agentRoster.find(a => a.key === scoreResult.agent);
                    const name = agentInfo ? agentInfo.name : scoreResult.agent;
                    const emoji = agentInfo ? agentInfo.emoji : '🤖';
                    toast(`${emoji} ${name} earned +${scoreResult.pointsAwarded} XP! ${scoreResult.streak > 1 ? '🔥 Streak x' + scoreResult.streak : ''}`, 'success');
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
            const top5 = lb.slice(0, 5);
            container.innerHTML = top5.map((entry, i) => {
                const agent = state.agentRoster.find(a => a.key === entry.agent);
                const emoji = agent ? agent.emoji : '🤖';
                const name = agent ? agent.name : entry.agent;
                return `<div class="proj-lb-row">
                    <span class="proj-lb-rank rank-${i + 1}">${i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1)}</span>
                    <span class="proj-lb-emoji">${emoji}</span>
                    <span class="proj-lb-name">${escHtml(name)}</span>
                    <span class="proj-lb-score">${entry.score} XP</span>
                    ${entry.streak > 1 ? `<span class="proj-streak">🔥${entry.streak}</span>` : ''}
                </div>`;
            }).join('');
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
            const relevant = lb.filter(e => assignees.has(e.agent));
            if (relevant.length === 0) { el.remove(); return; }
            el.innerHTML = relevant.slice(0, 5).map((entry, i) => {
                const agent = state.agentRoster.find(a => a.key === entry.agent);
                const emoji = agent ? agent.emoji : '🤖';
                const name = agent ? agent.name : entry.agent;
                return `<div class="proj-scoreboard-item ${i === 0 ? 'rank-1' : ''}">
                    <span class="sb-emoji">${emoji}</span>
                    <span>${escHtml(name)}</span>
                    <span class="sb-score">${entry.score} XP</span>
                    ${entry.streak > 1 ? `<span class="proj-streak">🔥${entry.streak}</span>` : ''}
                </div>`;
            }).join('');
        } catch (e) { el.remove(); }
    }

    // ── HELPERS ───────────────────────────────────────────────────
    function priorityColor(p) {
        return { critical: '#dc3545', high: '#fd7e14', medium: '#0d6efd', low: '#6c757d' }[p] || '#6c757d';
    }
    function formatDate(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        } catch { return iso; }
    }
    function isOverdue(iso) {
        if (!iso) return false;
        return new Date(iso) < new Date();
    }
    function timeAgo(iso) {
        if (!iso) return '';
        const diff = Date.now() - new Date(iso).getTime();
        const s = Math.floor(diff / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }
    function escHtml(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    window.openProjectsManager = function () {
        const modal = getModal();
        if (!modal) return;
        modal.classList.remove('hidden');
        loadAgentRoster();
        showListView();
        refreshLeaderboard();
    };

    window.closeProjectsModal = function () {
        const modal = getModal();
        if (modal) modal.classList.add('hidden');
        closeDetailPanel();
    };

    async function loadAgentRoster() {
        try {
            const d = await api.getAgents();
            state.agentRoster = (d.agents || []);
        } catch (e) { /* non-fatal */ }
    }

    // ── LIST VIEW ─────────────────────────────────────────────────
    async function showListView() {
        state.view = 'list';
        state.currentProject = null;
        closeDetailPanel();
        const mc = getMainContent();
        if (!mc) return;
        mc.innerHTML = renderListSkeleton();
        try {
            const d = await api.listProjects();
            state.projects = d.projects || [];
            mc.innerHTML = renderListView();
            bindListEvents();
            updateSidebar();
        } catch (e) {
            mc.innerHTML = `<div class="proj-loading"><div>⚠️ Failed to load projects</div><div style="font-size:10px;color:#555">${escHtml(String(e))}</div></div>`;
        }
    }

    function renderListSkeleton() {
        return `<div class="proj-loading"><div class="proj-spinner"></div><div>Loading projects…</div></div>`;
    }

    function renderListView() {
        const { filters } = state;
        let projects = [...state.projects];

        // Filter
        if (filters.status) projects = projects.filter(p => p.status === filters.status);
        if (filters.priority) projects = projects.filter(p => p.priority === filters.priority);
        if (filters.tag) projects = projects.filter(p => (p.tags || []).includes(filters.tag));
        if (filters.search) {
            const q = filters.search.toLowerCase();
            projects = projects.filter(p => p.title.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
        }

        // Sort
        const sortKey = filters.sort || 'updatedAt';
        projects.sort((a, b) => {
            if (sortKey === 'title') return (a.title || '').localeCompare(b.title || '');
            if (sortKey === 'priority') {
                const pOrder = { critical: 0, high: 1, medium: 2, low: 3 };
                return (pOrder[a.priority] || 2) - (pOrder[b.priority] || 2);
            }
            const aDate = a[sortKey] || a.updatedAt || '';
            const bDate = b[sortKey] || b.updatedAt || '';
            return bDate.localeCompare(aDate);
        });

        // Collect all tags for filter
        const allTags = [...new Set(state.projects.flatMap(p => p.tags || []))];

        return `
        <div class="proj-toolbar">
            <span class="proj-toolbar-title">📋 Projects</span>
            <button class="proj-btn proj-btn-primary" onclick="ProjMgr.newProjectDialog()">➕ New Project</button>
            <button class="proj-btn" onclick="ProjMgr.showTemplatesView()">📁 Templates</button>
            <input class="proj-search" id="proj-search" type="text" placeholder="🔍 Search projects…" value="${escHtml(filters.search)}" oninput="ProjMgr.filterChange('search', this.value)">
            <div class="proj-filter-row">
                <select class="proj-select" onchange="ProjMgr.filterChange('status', this.value)">
                    <option value="" ${!filters.status ? 'selected' : ''}>All Statuses</option>
                    <option value="active" ${filters.status === 'active' ? 'selected' : ''}>Active</option>
                    <option value="paused" ${filters.status === 'paused' ? 'selected' : ''}>Paused</option>
                    <option value="completed" ${filters.status === 'completed' ? 'selected' : ''}>Completed</option>
                    <option value="archived" ${filters.status === 'archived' ? 'selected' : ''}>Archived</option>
                </select>
                <select class="proj-select" onchange="ProjMgr.filterChange('priority', this.value)">
                    <option value="" ${!filters.priority ? 'selected' : ''}>All Priorities</option>
                    <option value="critical" ${filters.priority === 'critical' ? 'selected' : ''}>🔴 Critical</option>
                    <option value="high" ${filters.priority === 'high' ? 'selected' : ''}>🟠 High</option>
                    <option value="medium" ${filters.priority === 'medium' ? 'selected' : ''}>🔵 Medium</option>
                    <option value="low" ${filters.priority === 'low' ? 'selected' : ''}>⚪ Low</option>
                </select>
                ${allTags.length ? `
                <select class="proj-select" onchange="ProjMgr.filterChange('tag', this.value)">
                    <option value="">All Tags</option>
                    ${allTags.map(t => `<option value="${escHtml(t)}" ${filters.tag === t ? 'selected' : ''}>${escHtml(t)}</option>`).join('')}
                </select>` : ''}
                <select class="proj-select" onchange="ProjMgr.filterChange('sort', this.value)">
                    <option value="updatedAt" ${filters.sort === 'updatedAt' ? 'selected' : ''}>Recently Updated</option>
                    <option value="createdAt" ${filters.sort === 'createdAt' ? 'selected' : ''}>Date Created</option>
                    <option value="dueDate" ${filters.sort === 'dueDate' ? 'selected' : ''}>Due Date</option>
                    <option value="title" ${filters.sort === 'title' ? 'selected' : ''}>Name</option>
                    <option value="priority" ${filters.sort === 'priority' ? 'selected' : ''}>Priority</option>
                </select>
            </div>
        </div>
        <div class="proj-list-body">
            <div class="proj-grid">
                ${projects.length === 0 ? renderEmptyList() : projects.map(renderProjectCard).join('')}
            </div>
        </div>`;
    }

    function renderEmptyList() {
        return `
        <div class="proj-empty">
            <div class="proj-empty-icon">📋</div>
            <div class="proj-empty-title">No Projects Yet</div>
            <div class="proj-empty-text">Create your first project to get started</div>
            <br>
            <button class="proj-btn proj-btn-primary" style="margin: 10px auto;display:inline-block" onclick="ProjMgr.newProjectDialog()">➕ Create Project</button>
        </div>`;
    }

    function renderProjectCard(p) {
        const done = p.taskDone || 0;
        const total = p.taskCount || 0;
        const pct = total > 0 ? Math.round(done / total * 100) : 0;
        const overdue = p.dueDate && isOverdue(p.dueDate);
        return `
        <div class="proj-card" onclick="ProjMgr.openProject('${p.id}')">
            <div class="proj-card-header">
                <div class="proj-card-title">${escHtml(p.title)}</div>
                <div class="proj-card-actions" onclick="event.stopPropagation()">
                    <button class="proj-btn proj-btn-sm proj-btn-icon" title="Report" onclick="ProjMgr.showReport('${p.id}')">📊</button>
                    <button class="proj-btn proj-btn-sm proj-btn-icon" title="Archive" onclick="ProjMgr.archiveProject('${p.id}', event)">📁</button>
                    <button class="proj-btn proj-btn-sm proj-btn-icon" title="Delete" onclick="ProjMgr.deleteProject('${p.id}', event)">🗑️</button>
                </div>
            </div>
            ${p.description ? `<div class="proj-card-desc">${escHtml(p.description)}</div>` : ''}
            <div class="proj-card-meta">
                <span class="proj-badge badge-${p.status || 'active'}">${p.status || 'active'}</span>
                <span class="proj-badge badge-${p.priority || 'medium'}">${p.priority || 'medium'}</span>
                ${p.branch ? `<span class="proj-badge" style="background:rgba(255,215,0,0.1);border-color:#ffd700;color:#ffd700">🏢 ${escHtml(p.branch)}</span>` : ''}
                ${(p.tags || []).slice(0, 2).map(t => `<span class="proj-tag">${escHtml(t)}</span>`).join('')}
            </div>
            <div class="proj-progress-row">
                <div class="proj-progress-track"><div class="proj-progress-bar" style="width:${pct}%"></div></div>
                <span class="proj-progress-label">${done}/${total}</span>
            </div>
            ${p.dueDate ? `<div style="font-size:10px;color:${overdue ? '#f87171' : '#888'}">📅 ${overdue ? '⚠️ Overdue: ' : 'Due: '}${formatDate(p.dueDate)}</div>` : ''}
        </div>`;
    }

    function bindListEvents() { /* events bound via inline handlers */ }

    // ── PROJECT BOARD ─────────────────────────────────────────────
    async function openProject(id) {
        state.view = 'board';
        const mc = getMainContent();
        if (!mc) return;
        mc.innerHTML = renderListSkeleton();
        try {
            const d = await api.getProject(id);
            if (!d.project) throw new Error('Not found');
            state.currentProject = d.project;
            mc.innerHTML = renderBoardView();
            bindBoardEvents();
            populateBoardScoreboard();
            checkWorkflowOnOpen();
        } catch (e) {
            mc.innerHTML = `<div class="proj-loading">⚠️ Failed to load project</div>`;
        }
    }

    function renderBoardView() {
        const p = state.currentProject;
        if (!p) return '';
        const cols = (p.columns || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
        const tasks = p.tasks || [];

        return `
        <div class="proj-toolbar">
            <button class="proj-btn" onclick="ProjMgr.backToList()">← Back</button>
            <span class="proj-toolbar-title" style="font-size:8px;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.title)}</span>
            <span class="proj-badge badge-${p.status || 'active'}">${p.status || 'active'}</span>
            <span class="proj-badge badge-${p.priority || 'medium'}">${p.priority || 'medium'}</span>
            <div style="flex:1"></div>
            <div class="proj-workflow-controls" id="proj-wf-controls">
                <button class="proj-btn proj-btn-sm proj-btn-start" id="wf-start-btn" onclick="ProjMgr.workflowStart()" title="Start workflow">▶ Start</button>
                <button class="proj-btn proj-btn-sm proj-btn-stop hidden" id="wf-stop-btn" onclick="ProjMgr.workflowStop()" title="Stop workflow">⏹ Stop</button>
                <div class="proj-auto-toggle" title="Auto Mode: automatically process next backlog task when current finishes">
                    <label class="proj-toggle-switch">
                        <input type="checkbox" id="wf-auto-toggle" ${p.autoMode ? 'checked' : ''} onchange="ProjMgr.toggleAutoMode(this.checked)">
                        <span class="proj-toggle-slider"></span>
                    </label>
                    <span class="proj-toggle-label">Auto</span>
                </div>
                <span class="proj-wf-status" id="wf-status-badge"></span>
            </div>
            <button class="proj-btn proj-btn-sm" onclick="ProjMgr.editProjectDialog('${p.id}')">✏️ Edit</button>
            <button class="proj-btn proj-btn-sm" onclick="ProjMgr.showReport('${p.id}')">📊 Report</button>
            <button class="proj-btn proj-btn-sm" onclick="ProjMgr.saveAsTemplateDialog('${p.id}')">💾 Template</button>
        </div>
        ${p.description ? `
        <div class="proj-board-header">
            <span class="proj-board-desc-toggle" onclick="this.nextElementSibling.classList.toggle('expanded');this.textContent=this.nextElementSibling.classList.contains('expanded')?'▲ Hide description':'▼ Show description'">▼ Show description</span>
            <div class="proj-board-desc">${escHtml(p.description)}</div>
        </div>` : ''}
        ${renderBoardScoreboard()}
        <div class="proj-board-body" id="proj-board-cols">
            <div class="proj-col proj-chat-col" id="proj-wf-chat-col">
                <div class="proj-col-header" style="border-bottom-color:#4caf50">
                    <div class="proj-col-dot" style="background:#4caf50"></div>
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
        const tasks = allTasks.filter(t => t.columnId === col.id).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
        return `
        <div class="proj-col" id="col-${col.id}" data-col-id="${col.id}" style="--col-color:${col.color || '#6c757d'}">
            <div class="proj-col-header">
                <div class="proj-col-dot"></div>
                <div class="proj-col-title" ondblclick="ProjMgr.renameColumn('${col.id}')">${escHtml(col.title)}</div>
                <span class="proj-col-count">${tasks.length}</span>
                <button class="proj-col-add-btn" onclick="ProjMgr.showQuickAdd('${col.id}')" title="Add task">+</button>
            </div>
            <div class="proj-col-tasks" id="tasks-${col.id}"
                ondragover="ProjMgr.onDragOver(event, '${col.id}')"
                ondragleave="ProjMgr.onDragLeave(event, '${col.id}')"
                ondrop="ProjMgr.onDrop(event, '${col.id}')">
                ${tasks.map(t => renderTaskCard(t)).join('')}
            </div>
            <div class="proj-quick-add hidden" id="quick-add-${col.id}">
                <input class="proj-quick-add-input" id="quick-input-${col.id}" type="text" placeholder="Task title… (Enter to add)">
                <div class="proj-quick-add-actions">
                    <button class="proj-btn proj-btn-sm proj-btn-primary" onclick="ProjMgr.submitQuickAdd('${col.id}')">Add</button>
                    <button class="proj-btn proj-btn-sm" onclick="ProjMgr.hideQuickAdd('${col.id}')">Cancel</button>
                </div>
            </div>
        </div>`;
    }

    function renderTaskCard(task) {
        const pc = priorityColor(task.priority);
        const due = task.dueDate;
        const overdue = due && !task.completedAt && isOverdue(due);
        const checklist = task.checklist || [];
        const checkDone = checklist.filter(c => c.done).length;
        const hasCheck = checklist.length > 0;
        const comments = (task.comments || []).length;
        const assignee = task.assignee ? state.agentRoster.find(a => a.key === task.assignee || a.statusKey === task.assignee || a.agentId === task.assignee) : null;
        return `
        <div class="proj-task-card" id="task-${task.id}" data-task-id="${task.id}"
            style="--pri-color:${pc}"
            draggable="true"
            ondragstart="ProjMgr.onDragStart(event, '${task.id}')"
            ondragend="ProjMgr.onDragEnd(event)"
            ontouchstart="ProjMgr.onTouchStart(event, '${task.id}')"
            onclick="ProjMgr.openTaskDetail('${task.id}')">
            <div class="proj-task-title">${escHtml(task.title)}</div>
            <div class="proj-task-meta">
                ${task.priority !== 'medium' ? `<span class="proj-badge badge-${task.priority}" style="font-size:9px">${task.priority}</span>` : ''}
                ${assignee ? `<span class="proj-task-assignee" title="${escHtml(assignee.name)}">${escHtml(assignee.emoji || '👤')}</span>` : ''}
                ${due ? `<span class="proj-task-due ${overdue ? 'overdue' : ''}" title="${formatDate(due)}">${overdue ? '⚠️' : '📅'} ${formatDate(due)}</span>` : ''}
                ${(task.tags || []).slice(0, 2).map(t => `<span class="proj-tag" style="font-size:9px">${escHtml(t)}</span>`).join('')}
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
        // Quick add key handler
        document.addEventListener('keydown', handleGlobalKeys);
    }

    // ── DRAG & DROP (HTML5) ───────────────────────────────────────
    let _dragTaskId = null;
    let _dragSourceColId = null;
    let _dropTarget = null;

    function onDragStart(e, taskId) {
        _dragTaskId = taskId;
        const card = document.getElementById(`task-${taskId}`);
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
        if (_dragTaskId) {
            const card = document.getElementById(`task-${_dragTaskId}`);
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
        const col = document.getElementById(`col-${colId}`);
        if (col) col.classList.add('drag-over');
        // Determine insert position
        const tasksEl = document.getElementById(`tasks-${colId}`);
        if (tasksEl) {
            insertDropIndicator(tasksEl, e.clientY);
        }
    }

    function onDragLeave(e, colId) {
        const col = document.getElementById(`col-${colId}`);
        if (col && !col.contains(e.relatedTarget)) {
            col.classList.remove('drag-over');
            const tasksEl = document.getElementById(`tasks-${colId}`);
            if (tasksEl) {
                tasksEl.querySelectorAll('.proj-drop-line').forEach(l => l.remove());
            }
        }
    }

    function insertDropIndicator(container, clientY) {
        container.querySelectorAll('.proj-drop-line').forEach(l => l.remove());
        const cards = Array.from(container.querySelectorAll('.proj-task-card'));
        let insertBefore = null;
        for (const card of cards) {
            if (card.id === `task-${_dragTaskId}`) continue;
            const rect = card.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                insertBefore = card;
                break;
            }
        }
        const line = document.createElement('div');
        line.className = 'proj-drop-line visible';
        if (insertBefore) container.insertBefore(line, insertBefore);
        else container.appendChild(line);
    }

    function onDrop(e, colId) {
        e.preventDefault();
        const taskId = e.dataTransfer.getData('text/plain') || _dragTaskId;
        if (!taskId) return;
        const col = document.getElementById(`col-${colId}`);
        if (col) col.classList.remove('drag-over');
        const p = state.currentProject;
        if (!p) return;
        // Determine new order
        const tasksEl = document.getElementById(`tasks-${colId}`);
        const line = tasksEl && tasksEl.querySelector('.proj-drop-line');
        let newOrder = 0;
        if (tasksEl) {
            const cards = Array.from(tasksEl.querySelectorAll('.proj-task-card'));
            if (line) {
                const idx = cards.indexOf(line.previousElementSibling);
                newOrder = idx + 1;
            } else {
                newOrder = cards.filter(c => c.id !== `task-${taskId}`).length;
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
        const mc = getMainContent();
        if (mc) {
            mc.innerHTML = renderBoardView();
            bindBoardEvents();
        }
        // Persist
        const updates = p.tasks.map(t => ({ id: t.id, columnId: t.columnId, order: t.order || 0 }));
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
            if (targetCol && ['done', 'completed', 'verified', 'published', 'fixed', 'closed'].includes(targetCol.title.toLowerCase())) {
                // Optimistic complete animation (full one triggers after API confirms score)
                const card = document.getElementById(`task-${taskId}`);
                if (card) card.classList.add('anim-complete');
            }
        }
    }

    // ── TOUCH DRAG ────────────────────────────────────────────────
    let _touchTask = null;
    let _touchGhost = null;
    let _touchLongPressTimer = null;
    let _touchActive = false;

    function onTouchStart(e, taskId) {
        _touchLongPressTimer = setTimeout(() => {
            _touchActive = true;
            _touchTask = taskId;
            const card = document.getElementById(`task-${taskId}`);
            if (!card) return;
            // Create ghost
            _touchGhost = card.cloneNode(true);
            _touchGhost.id = 'proj-touch-ghost';
            _touchGhost.className = card.className + ' drag-ghost';
            _touchGhost.style.cssText = `position:fixed;pointer-events:none;z-index:10000;width:${card.offsetWidth}px;opacity:0.85;transform:rotate(2deg);`;
            document.body.appendChild(_touchGhost);
            card.style.opacity = '0.3';
            e.preventDefault();
        }, 400);
        e.target.addEventListener('touchmove', onTouchMove, { passive: false });
        e.target.addEventListener('touchend', onTouchEnd);
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
        const colEl = el && el.closest('[data-col-id]');
        if (colEl) colEl.classList.add('drag-over');
    }

    function onTouchEnd(e) {
        clearTimeout(_touchLongPressTimer);
        if (!_touchActive || !_touchTask) { _touchActive = false; return; }
        const touch = e.changedTouches[0];
        if (_touchGhost) { _touchGhost.remove(); _touchGhost = null; }
        document.querySelectorAll('.proj-col').forEach(c => c.classList.remove('drag-over'));
        const card = document.getElementById(`task-${_touchTask}`);
        if (card) card.style.opacity = '';
        // Find drop target
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const colEl = el && el.closest('[data-col-id]');
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
        if (mc) { mc.innerHTML = renderBoardView(); bindBoardEvents(); }
        const updates = p.tasks.map(t => ({ id: t.id, columnId: t.columnId, order: t.order || 0 }));
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
            if (targetCol && ['done', 'completed', 'verified', 'published', 'fixed', 'closed'].includes(targetCol.title.toLowerCase())) {
                const card = document.getElementById(`task-${taskId}`);
                if (card) card.classList.add('anim-complete');
            }
        }
    }

    // ── QUICK ADD ─────────────────────────────────────────────────
    function showQuickAdd(colId) {
        const qa = document.getElementById(`quick-add-${colId}`);
        if (!qa) return;
        qa.classList.remove('hidden');
        const inp = document.getElementById(`quick-input-${colId}`);
        if (inp) {
            inp.focus();
            inp.onkeydown = (e) => { if (e.key === 'Enter') submitQuickAdd(colId); if (e.key === 'Escape') hideQuickAdd(colId); };
        }
    }
    function hideQuickAdd(colId) {
        const qa = document.getElementById(`quick-add-${colId}`);
        if (qa) qa.classList.add('hidden');
    }
    async function submitQuickAdd(colId) {
        const inp = document.getElementById(`quick-input-${colId}`);
        const title = inp && inp.value.trim();
        if (!title) { hideQuickAdd(colId); return; }
        const p = state.currentProject;
        if (!p) return;
        try {
            const d = await api.createTask(p.id, { title, columnId: colId });
            if (d.task) {
                p.tasks.push(d.task);
                const mc = getMainContent();
                if (mc) { mc.innerHTML = renderBoardView(); bindBoardEvents(); }
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
        const title = prompt('Column title:');
        if (!title) return;
        const colors = ['#6c757d', '#0d6efd', '#ffc107', '#fd7e14', '#198754', '#17a2b8', '#dc3545'];
        const color = colors[p.columns.length % colors.length];
        const newCol = { id: genId(), title, color, order: p.columns.length };
        p.columns.push(newCol);
        try {
            await api.updateColumns(p.id, p.columns);
            const mc = getMainContent();
            if (mc) { mc.innerHTML = renderBoardView(); bindBoardEvents(); }
        } catch (e) { toast('Failed to add column', 'error'); }
    }

    function renameColumn(colId) {
        const p = state.currentProject;
        if (!p) return;
        const col = p.columns.find(c => c.id === colId);
        if (!col) return;
        const titleEl = document.querySelector(`#col-${colId} .proj-col-title`);
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
            if (mc) { mc.innerHTML = renderBoardView(); bindBoardEvents(); }
        }
        inp.onblur = save;
        inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = col.title; inp.blur(); } };
    }

    // ── TASK DETAIL PANEL ─────────────────────────────────────────
    function openTaskDetail(taskId) {
        const p = state.currentProject;
        if (!p) return;
        const task = p.tasks.find(t => t.id === taskId);
        if (!task) return;
        state.currentTask = task;
        renderDetailPanel(task);
        const panel = document.getElementById('proj-detail-panel');
        if (panel) panel.classList.add('open');
    }

    function closeDetailPanel() {
        state.currentTask = null;
        const panel = document.getElementById('proj-detail-panel');
        if (panel) panel.classList.remove('open');
    }

    function renderDetailPanel(task) {
        const panel = document.getElementById('proj-detail-panel');
        if (!panel) return;
        // Preserve unsaved description text from textarea before re-render
        const existingDescEl = document.getElementById('detail-desc');
        if (existingDescEl && task) {
            task.description = existingDescEl.value;
        }
        const p = state.currentProject;
        const cols = (p && p.columns) || [];
        const agents = state.agentRoster;
        const checklist = task.checklist || [];
        const checkDone = checklist.filter(c => c.done).length;
        const comments = task.comments || [];
        const activity = (p && p.activity || []).filter(a => a.taskId === task.id).slice().reverse().slice(0, 20);

        panel.innerHTML = `
        <div class="proj-detail-header">
            <span style="font-size:11px;color:#888">Task Detail</span>
            <div style="display:flex;gap:6px">
                <button class="proj-btn proj-btn-sm proj-btn-danger" onclick="ProjMgr.deleteCurrentTask()">🗑️ Delete</button>
                <button class="proj-btn proj-btn-sm" onclick="ProjMgr.duplicateTask('${task.id}')">📋 Duplicate</button>
                <button class="proj-detail-close" onclick="ProjMgr.closeDetailPanel()">✕</button>
            </div>
        </div>
        <div class="proj-detail-body">
            <input class="proj-detail-title-input" id="detail-title" value="${escHtml(task.title)}" placeholder="Task title">
            
            <div class="proj-section">
                <div class="proj-field">
                    <label class="proj-field-label">Column</label>
                    <select class="proj-detail-select" id="detail-col" onchange="ProjMgr.updateTaskField('columnId', this.value)">
                        ${cols.map(c => `<option value="${c.id}" ${task.columnId === c.id ? 'selected' : ''}>${escHtml(c.title)}</option>`).join('')}
                    </select>
                </div>
                <div style="display:flex;gap:8px">
                    <div class="proj-field" style="flex:1">
                        <label class="proj-field-label">Priority</label>
                        <select class="proj-detail-select" id="detail-pri" onchange="ProjMgr.updateTaskField('priority', this.value)">
                            <option value="critical" ${task.priority === 'critical' ? 'selected' : ''}>🔴 Critical</option>
                            <option value="high" ${task.priority === 'high' ? 'selected' : ''}>🟠 High</option>
                            <option value="medium" ${task.priority === 'medium' ? 'selected' : ''}>🔵 Medium</option>
                            <option value="low" ${task.priority === 'low' ? 'selected' : ''}>⚪ Low</option>
                        </select>
                    </div>
                    <div class="proj-field" style="flex:1">
                        <label class="proj-field-label">Due Date</label>
                        <input class="proj-detail-input" type="date" id="detail-due" value="${task.dueDate ? task.dueDate.split('T')[0] : ''}" onchange="ProjMgr.updateTaskField('dueDate', this.value ? new Date(this.value).toISOString() : null)">
                    </div>
                </div>
                <div class="proj-field">
                    <label class="proj-field-label">Assignee</label>
                    <select class="proj-detail-select" id="detail-assignee" onchange="ProjMgr.updateTaskField('assignee', this.value || null)">
                        <option value="">— Unassigned —</option>
                        ${agents.map(a => `<option value="${a.key || a.statusKey || a.id}" ${task.assignee === (a.key || a.statusKey || a.id) ? 'selected' : ''}>${escHtml((a.emoji || '👤') + ' ' + a.name)}</option>`).join('')}
                    </select>
                </div>
                <div class="proj-field">
                    <label class="proj-field-label">Tags</label>
                    <div class="proj-tag-input-wrap" id="detail-tags-wrap" onclick="document.getElementById('detail-tag-in').focus()">
                        ${(task.tags || []).map(t => `<span class="proj-tag">${escHtml(t)}<span class="tag-remove" onclick="ProjMgr.removeTag('${escHtml(t)}')">×</span></span>`).join('')}
                        <input class="proj-tag-input" id="detail-tag-in" placeholder="Add tag…" onkeydown="ProjMgr.handleTagKey(event)">
                    </div>
                </div>
            </div>

            <div class="proj-section">
                <div class="proj-section-header"><span class="proj-section-title">📝 Description</span></div>
                <div class="proj-desc-tabs">
                    <button class="proj-desc-tab active" id="desc-tab-edit" onclick="ProjMgr.switchDescTab('edit')">Edit</button>
                    <button class="proj-desc-tab" id="desc-tab-preview" onclick="ProjMgr.switchDescTab('preview')">Preview</button>
                </div>
                <textarea class="proj-detail-textarea" id="detail-desc" rows="4" placeholder="Task description (Markdown supported)">${escHtml(task.description || '')}</textarea>
                <div class="proj-desc-preview hidden" id="detail-desc-preview">${simpleMarkdown(task.description || '')}</div>
                <div style="text-align:right;margin-top:4px">
                    <button class="proj-btn proj-btn-sm proj-btn-gold" onclick="ProjMgr.saveDescription()">💾 Save</button>
                </div>
            </div>

            <div class="proj-section">
                <div class="proj-section-header">
                    <span class="proj-section-title">✅ Checklist</span>
                    <span style="font-size:10px;color:#888">${checkDone}/${checklist.length}</span>
                </div>
                ${checklist.length ? `
                <div class="proj-checklist-progress">
                    <div class="proj-checklist-progress-track">
                        <div class="proj-checklist-progress-fill" style="width:${checklist.length ? Math.round(checkDone/checklist.length*100) : 0}%"></div>
                    </div>
                    <span style="font-size:10px;color:#888">${checklist.length ? Math.round(checkDone/checklist.length*100) : 0}%</span>
                </div>` : ''}
                <ul class="proj-checklist" id="detail-checklist">
                    ${checklist.map((c, i) => `
                    <li class="proj-checklist-item ${c.done ? 'done' : ''}">
                        <input type="checkbox" ${c.done ? 'checked' : ''} onchange="ProjMgr.toggleChecklistItem(${i}, this.checked)">
                        <span class="proj-checklist-item-text" ondblclick="ProjMgr.editChecklistItem(${i})" title="Double-click to edit">${escHtml(c.text)}</span>
                        <button class="proj-checklist-edit" onclick="ProjMgr.editChecklistItem(${i})" title="Edit">✏️</button>
                        <button class="proj-checklist-delete" onclick="ProjMgr.deleteChecklistItem(${i})">×</button>
                    </li>`).join('')}
                </ul>
                <div style="display:flex;gap:6px;margin-top:6px">
                    <input class="proj-detail-input" id="new-checklist-item" type="text" placeholder="Add checklist item…" onkeydown="if(event.key==='Enter')ProjMgr.addChecklistItem()" style="flex:1">
                    <button class="proj-btn proj-btn-sm" onclick="ProjMgr.addChecklistItem()">Add</button>
                </div>
            </div>

            ${(task.reviewCheck && task.reviewCheck.length) ? `
            <div class="proj-section">
                <div class="proj-section-header"><span class="proj-section-title">🔍 Review Check</span></div>
                <div class="proj-review-check-list" id="detail-review-check">
                    ${task.reviewCheck.map((rc, i) => {
                        const icon = {'pass':'✅','needs_more_work':'⚠️','did_not_pass':'❌','requires_user_review':'👤'}[rc.status] || '❓';
                        const statusClass = 'review-' + (rc.status || 'pending').replace(/_/g, '-');
                        return `
                        <div class="proj-review-item ${statusClass}">
                            <span class="proj-review-icon">${icon}</span>
                            <span class="proj-review-text">${escHtml(rc.text)}</span>
                            <select class="proj-review-select" onchange="ProjMgr.updateReviewItemStatus(${i}, this.value)">
                                <option value="pass" ${rc.status === 'pass' ? 'selected' : ''}>✅ Pass</option>
                                <option value="needs_more_work" ${rc.status === 'needs_more_work' ? 'selected' : ''}>⚠️ Needs More Work</option>
                                <option value="did_not_pass" ${rc.status === 'did_not_pass' ? 'selected' : ''}>❌ Did Not Pass</option>
                                <option value="requires_user_review" ${rc.status === 'requires_user_review' ? 'selected' : ''}>👤 Requires User Review</option>
                            </select>
                        </div>`;
                    }).join('')}
                </div>
                <div style="text-align:right;margin-top:6px">
                    <button class="proj-btn proj-btn-sm proj-btn-gold" onclick="ProjMgr.saveReviewCheck()">💾 Save Review</button>
                </div>
            </div>` : ''}

            <div class="proj-section">
                <div class="proj-section-header"><span class="proj-section-title">💬 Comments</span></div>
                <div class="proj-comments-list" id="detail-comments">
                    ${comments.length === 0 ? '<div style="font-size:11px;color:#555">No comments yet</div>' : ''}
                    ${comments.map(c => `
                    <div class="proj-comment">
                        <div class="proj-comment-header">
                            <span class="proj-comment-author">${escHtml(c.author)}</span>
                            <span class="proj-comment-time">${timeAgo(c.createdAt)}</span>
                        </div>
                        <div class="proj-comment-text">${simpleMarkdown(c.text)}</div>
                    </div>`).join('')}
                </div>
                <textarea class="proj-detail-textarea" id="detail-comment-input" rows="2" placeholder="Add a comment… (Markdown supported)"></textarea>
                <div style="text-align:right;margin-top:4px">
                    <button class="proj-btn proj-btn-sm proj-btn-gold" onclick="ProjMgr.submitComment()">Post Comment</button>
                </div>
            </div>

            ${activity.length > 0 ? `
            <div class="proj-section">
                <div class="proj-section-header"><span class="proj-section-title">📜 Activity</span></div>
                <div class="proj-activity-list">
                    ${activity.map(a => `
                    <div class="proj-activity-item">
                        <div class="proj-activity-dot"></div>
                        <span class="proj-activity-time">${timeAgo(a.at)}</span>
                        <span>${escHtml(a.detail)}</span>
                    </div>`).join('')}
                </div>
            </div>` : ''}
        </div>`;

        // Bind title auto-save
        const titleEl = document.getElementById('detail-title');
        if (titleEl) {
            let titleTimer;
            titleEl.oninput = () => {
                clearTimeout(titleTimer);
                titleTimer = setTimeout(() => {
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
                    saveDescription();
                }, 1500);
            };
        }
        // Save button: cancel debounce then save immediately
        const descSaveBtn = document.querySelector('.proj-btn-gold[onclick*="saveDescription"]');
        if (descSaveBtn) {
            descSaveBtn.onclick = (e) => {
                e.preventDefault();
                clearTimeout(state._descAutoSaveTimer);
                saveDescription();
            };
        }
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
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ Saving…'; }
        try {
            await api.updateTask(projId, taskId, { description: desc });
            // Also update the card on the board
            const cardEl = document.getElementById(`task-${taskId}`);
            if (cardEl) {
                const newCard = document.createElement('div');
                newCard.innerHTML = renderTaskCard(task);
                const rendered = newCard.firstElementChild;
                if (rendered) cardEl.replaceWith(rendered);
            }
            if (saveBtn) { saveBtn.textContent = '✅ Saved'; }
            toast('Description saved', 'success');
            setTimeout(() => { if (saveBtn) { saveBtn.textContent = '💾 Save'; saveBtn.disabled = false; } }, 1500);
        } catch (e) {
            if (saveBtn) { saveBtn.textContent = '💾 Save'; saveBtn.disabled = false; }
            toast('Failed to save description', 'error');
        }
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
            await api.updateTask(p.id, task.id, { [field]: value });
            // Re-render board card
            const cardEl = document.getElementById(`task-${task.id}`);
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
            if (mc && state.currentProject) { mc.innerHTML = renderBoardView(); bindBoardEvents(); }
            // Re-open detail panel
            const task = state.currentTask;
            if (task) { openTaskDetail(task.id); }
        }
    }

    // Checklist
    async function toggleChecklistItem(idx, done) {
        const task = state.currentTask;
        if (!task || !task.checklist) return;
        task.checklist[idx].done = done;
        const li = document.querySelectorAll('#detail-checklist .proj-checklist-item')[idx];
        if (li) li.classList.toggle('done', done);
        await saveTaskField('checklist', task.checklist);
        renderDetailPanel(task);
    }
    async function deleteChecklistItem(idx) {
        const task = state.currentTask;
        if (!task || !task.checklist) return;
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
            if (e.key === 'Escape') { inp.value = item.text; inp.blur(); }
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
        if (!confirm(`Delete task "${task.title}"?`)) return;
        try {
            closeDetailPanel();
            // Animate the deletion first
            await animateTaskDelete(task.id);
            await api.deleteTask(p.id, task.id);
            p.tasks = p.tasks.filter(t => t.id !== task.id);
            const mc = getMainContent();
            if (mc) { mc.innerHTML = renderBoardView(); bindBoardEvents(); }
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
            if (d.task) { p.tasks.push(d.task); const mc = getMainContent(); if (mc) { mc.innerHTML = renderBoardView(); bindBoardEvents(); } toast('Task duplicated', 'success'); }
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
        overlay.classList.remove('hidden');

        if (type === 'new-project') {
            overlay.innerHTML = `
            <div class="proj-form-modal" style="position:static;padding:0;background:transparent" onclick="event.stopPropagation()">
            <div class="proj-form-box">
                <div class="proj-form-title">📋 NEW PROJECT</div>
                <div class="proj-form-group">
                    <label class="proj-form-label">Title *</label>
                    <input class="proj-form-input" id="pf-title" type="text" placeholder="Project title" autofocus>
                </div>
                <div class="proj-form-group">
                    <label class="proj-form-label">Description</label>
                    <textarea class="proj-form-textarea" id="pf-desc" placeholder="What is this project about?"></textarea>
                </div>
                <div class="proj-form-row">
                    <div class="proj-form-group">
                        <label class="proj-form-label">Status</label>
                        <select class="proj-form-select" id="pf-status">
                            <option value="active">Active</option>
                            <option value="paused">Paused</option>
                        </select>
                    </div>
                    <div class="proj-form-group">
                        <label class="proj-form-label">Priority</label>
                        <select class="proj-form-select" id="pf-priority">
                            <option value="critical">🔴 Critical</option>
                            <option value="high">🟠 High</option>
                            <option value="medium" selected>🔵 Medium</option>
                            <option value="low">⚪ Low</option>
                        </select>
                    </div>
                </div>
                <div class="proj-form-row">
                    <div class="proj-form-group">
                        <label class="proj-form-label">Due Date</label>
                        <input class="proj-form-input" id="pf-due" type="date">
                    </div>
                    <div class="proj-form-group">
                        <label class="proj-form-label">Tags (comma-sep)</label>
                        <input class="proj-form-input" id="pf-tags" type="text" placeholder="tag1, tag2">
                    </div>
                </div>
                ${extra ? `<input type="hidden" id="pf-template-id" value="${escHtml(extra)}">` : ''}
                <div class="proj-form-actions">
                    <button class="proj-btn" onclick="ProjMgr.hideFormModal()">Cancel</button>
                    <button class="proj-btn proj-btn-primary" onclick="ProjMgr.submitNewProject()">Create Project</button>
                </div>
            </div>
            </div>`;
            document.getElementById('pf-title').focus();

        } else if (type === 'edit-project') {
            overlay.innerHTML = `
            <div class="proj-form-modal" style="position:static;padding:0;background:transparent" onclick="event.stopPropagation()">
            <div class="proj-form-box">
                <div class="proj-form-title">✏️ EDIT PROJECT</div>
                <div class="proj-form-group">
                    <label class="proj-form-label">Title *</label>
                    <input class="proj-form-input" id="pf-title" type="text" value="${escHtml(data.title || '')}">
                </div>
                <div class="proj-form-group">
                    <label class="proj-form-label">Description</label>
                    <textarea class="proj-form-textarea" id="pf-desc">${escHtml(data.description || '')}</textarea>
                </div>
                <div class="proj-form-row">
                    <div class="proj-form-group">
                        <label class="proj-form-label">Status</label>
                        <select class="proj-form-select" id="pf-status">
                            <option value="active" ${data.status === 'active' ? 'selected' : ''}>Active</option>
                            <option value="paused" ${data.status === 'paused' ? 'selected' : ''}>Paused</option>
                            <option value="completed" ${data.status === 'completed' ? 'selected' : ''}>Completed</option>
                            <option value="archived" ${data.status === 'archived' ? 'selected' : ''}>Archived</option>
                        </select>
                    </div>
                    <div class="proj-form-group">
                        <label class="proj-form-label">Priority</label>
                        <select class="proj-form-select" id="pf-priority">
                            <option value="critical" ${data.priority === 'critical' ? 'selected' : ''}>🔴 Critical</option>
                            <option value="high" ${data.priority === 'high' ? 'selected' : ''}>🟠 High</option>
                            <option value="medium" ${data.priority === 'medium' ? 'selected' : ''}>🔵 Medium</option>
                            <option value="low" ${data.priority === 'low' ? 'selected' : ''}>⚪ Low</option>
                        </select>
                    </div>
                </div>
                <div class="proj-form-row">
                    <div class="proj-form-group">
                        <label class="proj-form-label">Due Date</label>
                        <input class="proj-form-input" id="pf-due" type="date" value="${data.dueDate ? data.dueDate.split('T')[0] : ''}">
                    </div>
                    <div class="proj-form-group">
                        <label class="proj-form-label">Tags (comma-sep)</label>
                        <input class="proj-form-input" id="pf-tags" type="text" value="${escHtml((data.tags || []).join(', '))}">
                    </div>
                </div>
                <input type="hidden" id="pf-edit-id" value="${data.id || ''}">
                <div class="proj-form-actions">
                    <button class="proj-btn" onclick="ProjMgr.hideFormModal()">Cancel</button>
                    <button class="proj-btn proj-btn-primary" onclick="ProjMgr.submitEditProject()">Save Changes</button>
                </div>
            </div>
            </div>`;

        } else if (type === 'save-template') {
            overlay.innerHTML = `
            <div class="proj-form-modal" style="position:static;padding:0;background:transparent" onclick="event.stopPropagation()">
            <div class="proj-form-box" style="max-width:400px">
                <div class="proj-form-title">💾 SAVE AS TEMPLATE</div>
                <div class="proj-form-group">
                    <label class="proj-form-label">Template Name</label>
                    <input class="proj-form-input" id="pf-tpl-title" type="text" value="${escHtml(data.title + ' Template')}" autofocus>
                </div>
                <div class="proj-form-group">
                    <label class="proj-form-label">Description</label>
                    <textarea class="proj-form-textarea" id="pf-tpl-desc" placeholder="What is this template for?">${escHtml(data.description || '')}</textarea>
                </div>
                <input type="hidden" id="pf-tpl-proj-id" value="${data.id || ''}">
                <div class="proj-form-actions">
                    <button class="proj-btn" onclick="ProjMgr.hideFormModal()">Cancel</button>
                    <button class="proj-btn proj-btn-primary" onclick="ProjMgr.submitSaveTemplate()">Save Template</button>
                </div>
            </div>
            </div>`;
        }
    }

    function hideFormModal() {
        const overlay = document.getElementById('proj-form-overlay');
        if (overlay) { overlay.innerHTML = ''; overlay.classList.add('hidden'); }
    }

    async function submitNewProject() {
        const title = (document.getElementById('pf-title') || {}).value.trim();
        if (!title) { toast('Title is required', 'error'); return; }
        const tplId = document.getElementById('pf-template-id');
        const body = {
            title,
            description: (document.getElementById('pf-desc') || {}).value || '',
            status: (document.getElementById('pf-status') || {}).value || 'active',
            priority: (document.getElementById('pf-priority') || {}).value || 'medium',
            dueDate: (document.getElementById('pf-due') || {}).value ? new Date(document.getElementById('pf-due').value).toISOString() : null,
            tags: ((document.getElementById('pf-tags') || {}).value || '').split(',').map(t => t.trim()).filter(Boolean),
        };
        try {
            let d;
            if (tplId && tplId.value) {
                d = await api.createFromTemplate({ ...body, templateId: tplId.value });
            } else {
                d = await api.createProject(body);
            }
            hideFormModal();
            if (d.project) {
                toast('Project created!', 'success');
                await openProject(d.project.id);
            }
        } catch (e) { toast('Failed to create project', 'error'); }
    }

    async function submitEditProject() {
        const id = (document.getElementById('pf-edit-id') || {}).value;
        const title = (document.getElementById('pf-title') || {}).value.trim();
        if (!title || !id) return;
        const body = {
            title,
            description: (document.getElementById('pf-desc') || {}).value || '',
            status: (document.getElementById('pf-status') || {}).value || 'active',
            priority: (document.getElementById('pf-priority') || {}).value || 'medium',
            dueDate: (document.getElementById('pf-due') || {}).value ? new Date(document.getElementById('pf-due').value).toISOString() : null,
            tags: ((document.getElementById('pf-tags') || {}).value || '').split(',').map(t => t.trim()).filter(Boolean),
        };
        try {
            const d = await api.updateProject(id, body);
            hideFormModal();
            if (state.currentProject && state.currentProject.id === id) Object.assign(state.currentProject, body);
            toast('Project updated!', 'success');
            if (state.view === 'board') { const mc = getMainContent(); if (mc) { mc.innerHTML = renderBoardView(); bindBoardEvents(); } }
            else { showListView(); }
        } catch (e) { toast('Failed to update project', 'error'); }
    }

    // ── PROJECT CRUD ──────────────────────────────────────────────
    async function archiveProject(id, e) {
        if (e) e.stopPropagation();
        if (!confirm('Archive this project?')) return;
        try {
            await api.updateProject(id, { status: 'archived' });
            toast('Project archived', 'success');
            showListView();
        } catch (e) { toast('Failed to archive', 'error'); }
    }

    async function deleteProject(id, e) {
        if (e) e.stopPropagation();
        if (!confirm('Delete this project? This cannot be undone.')) return;
        try {
            await api.deleteProject(id);
            toast('Project deleted', 'success');
            showListView();
        } catch (e) { toast('Failed to delete', 'error'); }
    }

    function filterChange(key, value) {
        state.filters[key] = value;
        const mc = getMainContent();
        if (mc) mc.innerHTML = renderListView();
    }

    function backToList() { closeDetailPanel(); showListView(); }

    // ── TEMPLATES VIEW ────────────────────────────────────────────
    async function showTemplatesView() {
        state.view = 'templates';
        closeDetailPanel();
        const mc = getMainContent();
        if (!mc) return;
        mc.innerHTML = renderListSkeleton();
        try {
            const d = await api.listTemplates();
            state.templates = d.templates || [];
        } catch (e) { state.templates = []; }
        mc.innerHTML = renderTemplatesView();
    }

    function renderTemplatesView() {
        // Merge: start with client-side defaults, then add server templates not already present
        const seenIds = new Set(DEFAULT_TEMPLATES.map(t => t.id));
        const serverOnly = state.templates.filter(t => !seenIds.has(t.id));
        const all = [...DEFAULT_TEMPLATES, ...serverOnly];
        return `
        <div class="proj-toolbar">
            <button class="proj-btn" onclick="ProjMgr.backToList()">← Back to Projects</button>
            <span class="proj-toolbar-title">📁 Templates</span>
        </div>
        <div class="proj-list-body">
            <div style="margin-bottom:16px;font-size:12px;color:#888">Choose a template to create a new project, or save your current project as a template.</div>
            <div class="proj-tpl-grid">
                ${all.map(tpl => renderTemplateCard(tpl)).join('')}
            </div>
        </div>`;
    }

    function renderTemplateCard(tpl) {
        const isBuiltin = DEFAULT_TEMPLATES.some(t => t.id === tpl.id);
        return `
        <div class="proj-tpl-card">
            <div class="proj-tpl-title">${escHtml(tpl.title)}</div>
            <div class="proj-tpl-desc">${escHtml(tpl.description || '')}</div>
            <div class="proj-tpl-cols">
                ${(tpl.columns || []).map(c => `<span class="proj-tpl-col-chip" style="background:${c.color}22;border-color:${c.color}55;color:${c.color}">${escHtml(c.title)}</span>`).join('')}
            </div>
            <div class="proj-tpl-actions">
                <button class="proj-btn proj-btn-sm proj-btn-primary" onclick="ProjMgr.newProjectDialog('${tpl.id}')">Use Template</button>
                ${!isBuiltin ? `<button class="proj-btn proj-btn-sm proj-btn-danger" onclick="ProjMgr.deleteTemplate('${tpl.id}')">Delete</button>` : ''}
            </div>
        </div>`;
    }

    async function deleteTemplate(id) {
        if (!confirm('Delete this template?')) return;
        try {
            await api.deleteTemplate(id);
            state.templates = state.templates.filter(t => t.id !== id);
            const mc = getMainContent();
            if (mc) mc.innerHTML = renderTemplatesView();
            toast('Template deleted', 'success');
        } catch (e) { toast('Failed to delete template', 'error'); }
    }

    function saveAsTemplateDialog(projectId) {
        const p = state.currentProject || state.projects.find(x => x.id === projectId);
        if (!p) return;
        showFormModal('save-template', p);
    }

    async function submitSaveTemplate() {
        const title = (document.getElementById('pf-tpl-title') || {}).value.trim();
        const projectId = (document.getElementById('pf-tpl-proj-id') || {}).value;
        const desc = (document.getElementById('pf-tpl-desc') || {}).value || '';
        if (!title) return;
        try {
            await api.saveTemplate({ title, description: desc, projectId });
            hideFormModal();
            toast('Template saved!', 'success');
        } catch (e) { toast('Failed to save template', 'error'); }
    }

    // ── REPORT VIEW ───────────────────────────────────────────────
    async function showReport(id) {
        const mc = getMainContent();
        if (!mc) return;
        mc.innerHTML = renderListSkeleton();
        state.view = 'report';
        closeDetailPanel();
        try {
            const d = await api.getReport(id);
            if (!d.report) throw new Error('No report');
            mc.innerHTML = renderReportView(d.report);
        } catch (e) {
            mc.innerHTML = `<div class="proj-loading">⚠️ Failed to generate report</div>`;
        }
    }

    function renderReportView(r) {
        const { stats, columns, agentWorkload, timeline, title } = r;
        const maxColCount = Math.max(...columns.map(c => c.count), 1);
        const maxAgentCount = Math.max(...Object.values(agentWorkload || {}), 1);

        return `
        <div class="proj-toolbar">
            <button class="proj-btn" onclick="ProjMgr.backToList()">← Back</button>
            <span class="proj-toolbar-title">📊 Report</span>
            <div style="flex:1"></div>
            <button class="proj-btn proj-btn-sm" onclick="ProjMgr.exportReport()">📤 Export Markdown</button>
        </div>
        <div class="proj-report-body">
            <div class="proj-report-header">
                <div>
                    <div class="proj-report-title">${escHtml(title)}</div>
                    <div class="proj-report-subtitle">Generated ${new Date(r.generatedAt).toLocaleString()}</div>
                </div>
            </div>

            <div class="proj-stats-grid">
                <div class="proj-stat-card">
                    <div class="proj-stat-value">${stats.total}</div>
                    <div class="proj-stat-label">Total Tasks</div>
                </div>
                <div class="proj-stat-card">
                    <div class="proj-stat-value" style="color:#4caf50">${stats.done}</div>
                    <div class="proj-stat-label">Completed</div>
                </div>
                <div class="proj-stat-card">
                    <div class="proj-stat-value" style="color:#ffc107">${stats.inProgress}</div>
                    <div class="proj-stat-label">In Progress</div>
                </div>
                <div class="proj-stat-card">
                    <div class="proj-stat-value" style="color:#f44336">${stats.overdue}</div>
                    <div class="proj-stat-label">Overdue</div>
                </div>
            </div>

            <div class="proj-chart-section">
                <div class="proj-chart-title">📊 Tasks by Column</div>
                <div class="proj-bar-chart">
                    ${columns.map(c => `
                    <div class="proj-bar-row">
                        <div class="proj-bar-label" title="${escHtml(c.title)}">${escHtml(c.title)}</div>
                        <div class="proj-bar-track">
                            <div class="proj-bar-fill" style="width:${Math.round(c.count/maxColCount*100)}%;background:${c.color}">${c.count}</div>
                        </div>
                        <div class="proj-bar-count">${c.count}</div>
                    </div>`).join('')}
                </div>
            </div>

            ${Object.keys(agentWorkload || {}).length ? `
            <div class="proj-chart-section">
                <div class="proj-chart-title">👥 Agent Workload</div>
                <div class="proj-bar-chart">
                    ${Object.entries(agentWorkload).map(([agent, count]) => `
                    <div class="proj-bar-row">
                        <div class="proj-bar-label" title="${escHtml(agent)}">${escHtml(agent)}</div>
                        <div class="proj-bar-track">
                            <div class="proj-bar-fill" style="width:${Math.round(count/maxAgentCount*100)}%;background:#ffd700"></div>
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
                        return `
                        <div class="proj-tl-item ${t.completedAt ? 'completed' : over ? 'overdue' : ''}">
                            <div class="proj-tl-title">${escHtml(t.title)}</div>
                            <div class="proj-tl-meta">
                                <span>📅 ${formatDate(t.dueDate)}</span>
                                ${t.assignee ? `<span>👤 ${escHtml(t.assignee)}</span>` : ''}
                                <span class="proj-badge badge-${t.priority || 'medium'}" style="font-size:9px">${t.priority || 'medium'}</span>
                                ${t.completedAt ? `<span style="color:#4caf50">✅ Done</span>` : over ? `<span style="color:#f87171">⚠️ Overdue</span>` : ''}
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
        const active = state.projects.filter(p => p.status === 'active').slice(0, 5);
        if (active.length === 0) {
            el.innerHTML = '<div style="font-size:10px;color:#555;padding:4px">No active projects</div>';
            return;
        }
        el.innerHTML = active.map(p => {
            const pct = p.taskCount > 0 ? Math.round(p.taskDone / p.taskCount * 100) : 0;
            return `
            <div class="sidebar-proj-item" onclick="ProjMgr.openProjectsManager();ProjMgr.openProject('${p.id}')">
                <div class="proj-dot" style="background:${priorityColor(p.priority)}"></div>
                <span class="proj-name">${escHtml(p.title)}</span>
                <span class="proj-progress-mini">${pct}%</span>
            </div>`;
        }).join('');
    }

    // Init sidebar on load
    (async function initSidebar() {
        try {
            const d = await api.listProjects('active');
            state.projects = d.projects || [];
            updateSidebar();
            // Also load agent roster for leaderboard names
            await loadAgentRoster();
            refreshLeaderboard();
        } catch (e) { /* non-fatal */ }
    })();

    // ── GLOBAL KEYBOARD ───────────────────────────────────────────
    function handleGlobalKeys(e) {
        if (e.key === 'Escape') {
            if (state.currentTask) closeDetailPanel();
            const overlay = document.getElementById('proj-form-overlay');
            if (overlay && !overlay.classList.contains('hidden')) hideFormModal();
        }
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
                    const mc = getMainContent();
                    if (mc && state.view === 'board') {
                        mc.innerHTML = renderBoardView();
                        bindBoardEvents();
                        populateBoardScoreboard();
                        updateActiveColumnIndicator();
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
                    const mc = getMainContent();
                    if (mc && state.view === 'board') {
                        mc.innerHTML = renderBoardView();
                        bindBoardEvents();
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

        const msgs = data.messages || [];
        const isActive = data.phase && data.phase !== 'idle' && data.phase !== 'stopped';

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

            let text = m.text || '';
            // Truncate very long messages
            if (text.length > 500) text = text.substring(0, 500) + '…';
            text = escHtml(text);

            return `<div class="${cls}">
                <div class="proj-chat-msg-text">${text}</div>
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
        const colEl = document.getElementById(`col-${task.columnId}`);
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
        if (!task || !p || !task.reviewCheck) return;
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
