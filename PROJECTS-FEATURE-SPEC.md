# Projects Feature — Full Specification

## Overview
A comprehensive project management suite built into the Virtual Office. Users can create, edit, track, document, organize, and report on projects — all through an intuitive, drag-and-drop interface. This is THE power tool for the Virtual Office.

## Architecture

### Files to Create
1. **`app/projects.js`** — All frontend logic (modal, board, drag-and-drop, templates, reports)
2. **`app/projects.css`** — All project-specific styles (import from index.html)

### Files to Modify
3. **`app/server.py`** — Add REST API endpoints for CRUD operations
4. **`app/index.html`** — Add Projects button to toolbar, include JS/CSS, add modal HTML
5. **`app/style.css`** — Minimal additions only (toolbar button highlight)

### Data Storage
- **File:** `{STATUS_DIR}/projects.json` (same pattern as office-config.json, meetings, etc.)
- **Format:** JSON with projects array, each containing tasks, metadata, history

---

## Data Model

```json
{
  "projects": [
    {
      "id": "proj-uuid",
      "title": "Project Name",
      "description": "Markdown description",
      "status": "active",  // active | paused | completed | archived
      "priority": "high",  // critical | high | medium | low
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601",
      "dueDate": "ISO-8601 or null",
      "createdBy": "agent-key or user",
      "tags": ["tag1", "tag2"],
      "branch": "branch-id or empty",
      "columns": [
        { "id": "col-uuid", "title": "Backlog", "color": "#6c757d", "order": 0 },
        { "id": "col-uuid", "title": "To Do", "color": "#0d6efd", "order": 1 },
        { "id": "col-uuid", "title": "In Progress", "color": "#ffc107", "order": 2 },
        { "id": "col-uuid", "title": "Review", "color": "#fd7e14", "order": 3 },
        { "id": "col-uuid", "title": "Done", "color": "#198754", "order": 4 }
      ],
      "tasks": [
        {
          "id": "task-uuid",
          "title": "Task title",
          "description": "Markdown description",
          "columnId": "col-uuid",
          "order": 0,
          "priority": "high",  // critical | high | medium | low
          "assignee": "agent-key or null",
          "assigneeBranch": "branch-id or null",
          "dueDate": "ISO-8601 or null",
          "tags": ["frontend", "urgent"],
          "checklist": [
            { "id": "chk-uuid", "text": "Sub-task", "done": false }
          ],
          "comments": [
            { "id": "cmt-uuid", "author": "agent-key", "text": "Markdown text", "createdAt": "ISO-8601" }
          ],
          "attachments": [],
          "createdAt": "ISO-8601",
          "updatedAt": "ISO-8601",
          "completedAt": "ISO-8601 or null"
        }
      ],
      "activity": [
        { "type": "task_created", "taskId": "...", "by": "user", "at": "ISO-8601", "detail": "..." }
      ],
      "template": false  // if true, this is a template not an active project
    }
  ],
  "templates": [
    {
      "id": "tpl-uuid",
      "title": "Template Name",
      "description": "Template description",
      "columns": [...],
      "taskTemplates": [
        { "title": "...", "columnIndex": 0, "priority": "medium", "tags": [] }
      ]
    }
  ]
}
```

---

## UI Design

### Entry Point
- **Toolbar button:** `📋 Projects` — added between `⏰ Cron` and `🔍 Reset` in the toolbar
- **Sidebar section:** `📋 PROJECTS` collapsible section showing active project count + quick list
- Opens a full-screen modal (like Meetings modal but bigger)

### Projects List View (Default)
- Top bar: `➕ New Project` button, `📁 Templates` button, search/filter bar
- Filter by: status, priority, branch, tag, assignee
- Sort by: name, date created, due date, priority, last updated
- Project cards in a responsive grid (2-3 columns desktop, 1 column mobile):
  - Project title + emoji/icon
  - Status badge (colored)
  - Priority indicator
  - Progress bar (tasks done / total)
  - Due date (with overdue highlighting)
  - Assigned branch badge
  - Task count summary
  - Quick actions: open, archive, delete

### Kanban Board View (Per Project)
- **Header:** Project title, status badge, description (collapsible), back button
- **Columns:** Horizontal scrolling columns (Backlog, To Do, In Progress, Review, Done)
  - Column header with title, task count, color indicator, `+` add task button
  - Add column button at the end
  - Column reordering via drag
- **Task Cards** within columns:
  - Title (click to expand)
  - Priority indicator (colored left border: critical=red, high=orange, medium=blue, low=gray)
  - Assignee avatar/emoji (from agent roster)
  - Due date badge
  - Tag pills
  - Checklist progress (if has checklist)
  - Comment count icon
- **Drag & Drop:**
  - Drag tasks between columns (changes status)
  - Drag tasks within column (reorder)
  - Visual drop indicators (line between cards, column highlight)
  - Touch-friendly (long press to start drag on mobile)
  - Smooth animations

### Task Detail Panel (Slide-in from right)
- **Title** (editable inline)
- **Description** (Markdown editor — textarea with preview toggle)
- **Status** column selector
- **Priority** dropdown
- **Assignee** dropdown (populated from agent roster + branches)
  - Shows agent emoji + name
  - Can assign to branch (shows all branch agents)
- **Due Date** date picker
- **Tags** (add/remove pills)
- **Checklist** section:
  - Add items
  - Check/uncheck
  - Drag to reorder
  - Progress bar
- **Comments** section:
  - Markdown input
  - Chronological list with author, time
- **Activity Log** (auto-generated):
  - Created, moved, assigned, priority changed, etc.
- **Actions:** Delete task, duplicate task

### Project Templates
- Built-in templates:
  - **Blank Project** (just columns)
  - **Software Development** (Backlog, Sprint, In Progress, Code Review, QA, Done)
  - **Marketing Campaign** (Ideas, Planning, In Progress, Review, Published)
  - **Bug Tracking** (Reported, Confirmed, In Progress, Fixed, Verified)
- Users can save any project as template
- Create project from template

### Project Report View
- **Summary stats:** Total tasks, completed, in progress, overdue
- **Progress chart:** Visual bar per column showing task distribution
- **Agent workload:** Tasks per agent (bar chart)
- **Timeline:** Tasks with due dates shown on a simple timeline
- **Export:** Copy report as Markdown

---

## API Endpoints (server.py)

### GET Endpoints
- `GET /api/projects` — List all projects (with optional ?status=active filter)
- `GET /api/projects/{id}` — Get single project with all tasks
- `GET /api/projects/templates` — List templates
- `GET /api/projects/{id}/report` — Generate project report

### POST Endpoints
- `POST /api/projects` — Create new project (body: {title, description, template?, columns?})
- `POST /api/projects/{id}/tasks` — Create task in project
- `POST /api/projects/{id}/tasks/{taskId}/comments` — Add comment
- `POST /api/projects/from-template` — Create project from template
- `POST /api/projects/templates` — Save project as template

### PUT Endpoints
- `PUT /api/projects/{id}` — Update project metadata
- `PUT /api/projects/{id}/tasks/{taskId}` — Update task (move, edit, assign, etc.)
- `PUT /api/projects/{id}/columns` — Reorder/add/edit columns
- `PUT /api/projects/{id}/tasks/reorder` — Batch reorder tasks (after drag-drop)

### DELETE Endpoints
- `DELETE /api/projects/{id}` — Delete/archive project
- `DELETE /api/projects/{id}/tasks/{taskId}` — Delete task
- `DELETE /api/projects/templates/{id}` — Delete template

---

## Technical Requirements

### Drag & Drop
- **Pure HTML5 drag-and-drop** (no libraries) for desktop
- **Touch events** (touchstart/touchmove/touchend) for mobile
- Visual feedback: ghost card while dragging, drop zone highlighting
- Snap-to-column behavior
- Order persistence via `order` field

### Responsive / Mobile
- Columns stack vertically on screens < 768px
- Horizontal scroll on medium screens (768-1024px)  
- Task cards full-width on mobile
- Touch-friendly tap targets (min 44px)
- Slide-in task detail panel becomes full-screen on mobile

### Performance
- Lazy load project data (list shows summaries, board loads full)
- Debounce save on drag operations (batch reorder saves)
- Optimistic UI updates (move card immediately, save in background)

### Styling
- Match the existing Virtual Office dark theme (#1a1a2e, #ffd700 accents)
- Use 'Press Start 2P' font for headers, system font for body text
- Consistent with existing modal patterns (meetings, skills library)
- Smooth CSS transitions on all interactions
- Color-coded priority borders and badges

### Integration Points
- Agent roster: fetch from `/agents-list` for assignee dropdowns
- Branches: fetch from office config for branch assignment
- Meetings: show active meetings related to project (future)
- All content in Markdown format (descriptions, comments)

---

## Implementation Notes

### File Organization
- `projects.js` should be self-contained — all modal logic, board rendering, drag-drop, API calls
- `projects.css` should be a separate file (loaded in index.html like other CSS)
- Follow existing patterns in `chat.js` and `game.js` for code style
- Use `fetch()` for all API calls (same as existing code)
- Generate UUIDs client-side: `crypto.randomUUID()` or fallback

### index.html Changes
1. Add `<link rel="stylesheet" href="projects.css?v=...">` in head
2. Add `📋 Projects` button in toolbar (after Cron button)
3. Add Projects modal HTML container (similar to meetingsModal pattern)
4. Add `<script src="projects.js?v=..."></script>` before closing body

### server.py Changes
1. Add `PROJECTS_FILE` constant (path in STATUS_DIR)
2. Add `_load_projects()` and `_save_projects()` helper functions
3. Add route handling in `do_GET` and `do_POST` for `/api/projects*`
4. Follow existing patterns (like meetings handlers)

### Sidebar Addition
Add a collapsible section in the sidebar HTML (index.html) between MEETINGS and SKILLS LIBRARY:
```html
<div class="projects-sidebar collapsible">
    <h4 onclick="toggleSection(this)"><span class="section-arrow">▶</span> 📋 PROJECTS</h4>
    <div class="section-body" style="display:none">
        <div id="sidebar-projects-list" class="sidebar-projects-list"></div>
        <button class="sidebar-mtg-btn" onclick="openProjectsManager()">📋 Open Projects</button>
    </div>
</div>
```

---

## Default Templates (Built-in)

```javascript
const DEFAULT_TEMPLATES = [
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
            { title: 'Done', color: '#198754' }
        ],
        taskTemplates: [
            { title: 'Set up development environment', columnIndex: 0, priority: 'high' },
            { title: 'Define acceptance criteria', columnIndex: 0, priority: 'medium' },
            { title: 'Write unit tests', columnIndex: 0, priority: 'medium' }
        ]
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
            { title: 'Published', color: '#198754' }
        ],
        taskTemplates: [
            { title: 'Define target audience', columnIndex: 0, priority: 'high' },
            { title: 'Create content calendar', columnIndex: 0, priority: 'medium' }
        ]
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
            { title: 'Verified', color: '#198754' }
        ],
        taskTemplates: []
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
            { title: 'Published', color: '#198754' }
        ],
        taskTemplates: []
    }
];
```

---

## Quality Checklist
- [ ] All CRUD operations work (create, read, update, delete)
- [ ] Drag-and-drop works on desktop (mouse)
- [ ] Drag-and-drop works on mobile (touch)
- [ ] Task assignment shows real agents from roster
- [ ] Columns can be added, renamed, reordered, deleted
- [ ] Tasks can be created, edited, moved, prioritized, deleted
- [ ] Checklist items work (add, check, reorder)
- [ ] Comments can be added with Markdown
- [ ] Templates work (built-in + save as template + create from template)
- [ ] Project report generates correct stats
- [ ] Search/filter works in project list
- [ ] Sidebar shows active projects
- [ ] Responsive on mobile (< 768px)
- [ ] All data persists after page reload
- [ ] No console errors
- [ ] Matches existing dark theme exactly
- [ ] Smooth animations and transitions
- [ ] Activity log tracks all changes
