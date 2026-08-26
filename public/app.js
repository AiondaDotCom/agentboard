// ---------------------------------------------------------------------------
// Agentboard – Frontend Application (realtime via GraphQL subscriptions)
// ---------------------------------------------------------------------------

const API_BASE = '';
let currentProjectId = null;
let ws = null;
let agents = {};
let activities = [];
let runtimePollTimer = null;
let runtimeDurationTimer = null;
let runtimeStatusSnapshot = null;

// Column config of the currently opened project: [{id, title}, ...]
// First column = inbox for new tickets, last column = finished/done.
const FALLBACK_COLUMNS = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'blocked', title: 'Blocked' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'rework', title: 'Rework' },
  { id: 'in_review', title: 'In Review' },
  { id: 'done', title: 'Done' },
];
let currentProjectColumns = FALLBACK_COLUMNS;
let boardTickets = []; // last rendered ticket list (for dependency lookups)

function doneColumnId() {
  return currentProjectColumns[currentProjectColumns.length - 1].id;
}

function columnTitle(colId, columns) {
  const cols = columns || currentProjectColumns;
  const col = cols.find(c => c.id === colId);
  return col ? col.title : colId.replace(/_/g, ' ');
}

// Well-known column ids keep their theme color; custom ones get a stable hue.
const KNOWN_COLUMN_COLORS = {
  backlog: 'var(--column-backlog)',
  ready: 'var(--column-ready)',
  in_progress: 'var(--column-in-progress)',
  in_review: 'var(--column-in-review)',
  done: 'var(--column-done)',
  blocked: 'var(--column-blocked)',
  rework: 'var(--column-rework)',
};

function columnColor(colId) {
  return KNOWN_COLUMN_COLORS[colId] || `hsl(${groupHue(colId)}, 70%, 65%)`;
}

// Ticket priorities: weight for sorting (higher = more urgent, shown on top)
const PRIORITY_META = {
  critical: { weight: 4, label: 'Critical', icon: '\u{1F525}' },
  high: { weight: 3, label: 'High', icon: '\u{2B06}\u{FE0F}' },
  medium: { weight: 2, label: 'Medium', icon: '\u{25CF}' },
  low: { weight: 1, label: 'Low', icon: '\u{2B07}\u{FE0F}' },
};

function priorityMeta(priority) {
  return PRIORITY_META[priority] || PRIORITY_META.medium;
}

function priorityBadge(ticket, cssClass) {
  const p = ticket.priority || 'medium';
  const meta = priorityMeta(p);
  return `<span class="${cssClass} prio-${p}" title="Priority: ${meta.label}">${meta.icon} ${meta.label}</span>`;
}

// Work type: what KIND of work a ticket is – decides who can take it.
// Unclassified tickets carry no work type and get no badge.
const WORK_TYPE_META = {
  mechanical: {
    label: 'Mechanical',
    icon: '\u{1F529}',
    hint: 'Solution shape is known, diff is checkable against a hard done-criterion',
  },
  judgment: {
    label: 'Judgment',
    icon: '\u{1F9E0}',
    hint: 'Design, root-cause analysis, weighing trade-offs',
  },
};

function workTypeBadge(ticket, cssClass) {
  const meta = WORK_TYPE_META[ticket.workType];
  if (!meta) return '';
  return `<span class="${cssClass} work-${ticket.workType}" title="${meta.label}: ${meta.hint}">${meta.icon} ${meta.label}</span>`;
}

// ---------------------------------------------------------------------------
// Recent agent access tracker – ticketId -> Map<agentId, {name, action, timer}>
// ---------------------------------------------------------------------------
const ticketAccesses = new Map();
const ACCESS_EFFECT_DURATION = 3200;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(`${API_BASE}${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------

async function graphqlQuery(query) {
  const res = await fetch('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  return json.data;
}

let overviewPollTimer = null;
let prevOverviewStats = {}; // projectId -> JSON string of per-column counts

async function loadProjectOverview() {
  const data = await graphqlQuery(`{
    projects {
      id name description
      columns { id title }
      tickets { column }
    }
  }`);

  const projects = data?.projects || [];
  const tbody = document.getElementById('overview-tbody');
  const empty = document.getElementById('overview-empty');
  const table = document.querySelector('.overview-table');

  if (projects.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
    return projects;
  }

  table.style.display = '';
  empty.style.display = 'none';

  const newStats = {};

  projects.forEach(p => {
    const cols = (p.columns && p.columns.length) ? p.columns : FALLBACK_COLUMNS;
    const counts = {};
    cols.forEach(c => { counts[c.id] = 0; });
    p.tickets.forEach(t => { if (counts[t.column] !== undefined) counts[t.column]++; });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    newStats[p.id] = JSON.stringify({ counts, total, cols: cols.map(c => c.id) });
  });

  function buildRowHtml(p) {
    const cols = (p.columns && p.columns.length) ? p.columns : FALLBACK_COLUMNS;
    const { counts, total } = JSON.parse(newStats[p.id]);
    const chips = cols.map(c => `
      <span class="stat-chip${counts[c.id] === 0 ? ' zero' : ''}" style="--chip-color:${columnColor(c.id)}">
        <span class="stat-chip-label">${escapeHtml(c.title)}</span>
        <span class="overview-count">${counts[c.id]}</span>
      </span>`).join('');

    return `
      <td>
        <div class="overview-project-name">${escapeHtml(p.name)}</div>
        <div class="overview-project-id" title="Click to copy full ID" onclick="event.stopPropagation(); copyId('${p.id}', this)">#${p.id.slice(0, 8)}</div>
        ${p.description ? `<div class="overview-project-desc">${escapeHtml(p.description)}</div>` : ''}
      </td>
      <td class="overview-cols">${chips}</td>
      <td class="overview-count col-total">${total}</td>
    `;
  }

  // Check if we can do an in-place update (same projects, same order)
  const existingRows = tbody.querySelectorAll('tr');
  const canPatch = existingRows.length === projects.length &&
    projects.every((p, i) => existingRows[i]?.dataset.projectId === p.id);

  if (canPatch) {
    // In-place update: rebuild only rows whose stats changed, with a flash
    projects.forEach((p, i) => {
      if (prevOverviewStats[p.id] === newStats[p.id]) return;
      const row = existingRows[i];
      row.innerHTML = buildRowHtml(p);
      row.classList.add('overview-flash');
      row.addEventListener('animationend', () => row.classList.remove('overview-flash'), { once: true });
    });
  } else {
    // Full rebuild (project list changed)
    tbody.innerHTML = '';
    projects.forEach(p => {
      const tr = document.createElement('tr');
      tr.dataset.projectId = p.id;
      tr.onclick = () => selectProject(p.id, p.name);
      tr.innerHTML = buildRowHtml(p);

      const isNew = !!prevOverviewStats[p.id] === false && Object.keys(prevOverviewStats).length > 0;
      if (isNew) {
        tr.classList.add('overview-row-new');
        tr.addEventListener('animationend', () => tr.classList.remove('overview-row-new'), { once: true });
      }

      tbody.appendChild(tr);
    });
  }

  prevOverviewStats = newStats;

  // Auto-select if exactly one project
  if (projects.length === 1 && !currentProjectId) {
    await selectProject(projects[0].id, projects[0].name);
  }

  return projects;
}

async function loadAgents() {
  const agentList = await fetchJSON('/api/agents');
  agents = {};
  agentList.forEach(a => { agents[a.id] = a; });
  document.getElementById('agent-count').textContent = `${agentList.length} agent${agentList.length !== 1 ? 's' : ''}`;
}

function formatWorkingDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const dayText = `${days} day${days === 1 ? '' : 's'}`;
  if (remainingHours === 0) return dayText;
  return `${dayText} and ${remainingHours} hour${remainingHours === 1 ? '' : 's'}`;
}

function renderRuntimeStatus(status) {
  const el = document.getElementById('runtime-status');
  const text = document.getElementById('runtime-status-text');
  el.classList.remove('runtime-working', 'runtime-idle', 'runtime-offline');
  const hostDetails = status.hosts.map(host =>
    `${host.host}: ${host.workingCodex} Codex + ${host.workingClaude} Claude + ${host.workingOpenCode} OpenCode working, ${host.idleCodex + host.idleClaude + host.idleOpenCode} idle`
  ).join('\n');
  if (status.working > 0) {
    el.classList.add('runtime-working');
    const elapsed = status.workingSince
      ? Math.max(0, Math.floor((Date.now() - Date.parse(status.workingSince)) / 1000))
      : status.workingForSeconds;
    const since = ` since ${formatWorkingDuration(elapsed)}`;
    text.textContent = `${status.working} AI${status.working === 1 ? '' : 's'} working${since}`;
  } else {
    el.classList.add(status.hosts.length ? 'runtime-idle' : 'runtime-offline');
    text.textContent = '0 AIs working';
  }
  el.title = status.hosts.length
    ? `${status.codexWorking} Codex, ${status.claudeWorking} Claude, ${status.openCodeWorking} OpenCode working; ${status.idle} idle${status.workingSince ? `\nWorking non-stop since ${new Date(status.workingSince).toLocaleString()}` : ''}\n${hostDetails}`
    : 'No current runtime heartbeat from cortex';
}

async function loadRuntimeStatus() {
  const el = document.getElementById('runtime-status');
  const text = document.getElementById('runtime-status-text');
  try {
    runtimeStatusSnapshot = await fetchJSON('/api/runtime');
    renderRuntimeStatus(runtimeStatusSnapshot);
  } catch {
    runtimeStatusSnapshot = null;
    el.classList.remove('runtime-working', 'runtime-idle');
    el.classList.add('runtime-offline');
    text.textContent = 'AI status offline';
    el.title = 'Runtime status API is unavailable';
  }
}

async function loadBoard(projectId) {
  // Fetch all pages to ensure every column is populated
  let allTickets = [];
  let page = 1;
  while (true) {
    const result = await fetchJSON(`/api/projects/${projectId}/tickets?per_page=100&page=${page}`);
    allTickets = allTickets.concat(result.data);
    if (page >= result.total_pages) break;
    page++;
  }
  renderBoard(allTickets);
  // Update snapshot after render so next diff works
  prevTicketState = snapshotTicketPositions();
  prevGroupState = snapshotGroupPositions();
}

async function loadActivity(projectId) {
  const acts = await fetchJSON(`/api/projects/${projectId}/activity`);
  activities = acts;
  renderActivity();
}

async function loadAudit() {
  const entries = await fetchJSON('/api/audit?limit=50');
  renderAudit(entries);
}

// ---------------------------------------------------------------------------
// Ticket state tracking (for move animations)
// ---------------------------------------------------------------------------

// Map ticketId -> { column, rect } from last render
let prevTicketState = new Map();

function snapshotTicketPositions() {
  const snap = new Map();
  document.querySelectorAll('.ticket-card').forEach(card => {
    const id = card.dataset.ticketId;
    const col = card.closest('.column')?.dataset.column;
    if (id && col) {
      snap.set(id, {
        column: col,
        rect: card.getBoundingClientRect(),
        title: card.querySelector('.ticket-title')?.textContent || '',
        group: card.dataset.group || '',
        assignee: card.dataset.assignee || '',
      });
    }
  });
  return snap;
}

// ---------------------------------------------------------------------------
// Ticket groups (related tickets claimed by a single agent)
// ---------------------------------------------------------------------------

// Map "column::group" -> { rect, hue } from last render (for appear/dissolve animations)
let prevGroupState = new Map();

function snapshotGroupPositions() {
  const snap = new Map();
  document.querySelectorAll('.ticket-group').forEach(w => {
    const col = w.closest('.column')?.dataset.column;
    const group = w.dataset.group;
    if (col && group) {
      snap.set(`${col}::${group}`, {
        rect: w.getBoundingClientRect(),
        hue: w.style.getPropertyValue('--group-hue'),
      });
    }
  });
  return snap;
}

// Deterministic hue per group name (for consistent coloring)
function groupHue(name) {
  let h = 0;
  for (const c of name) h = ((h * 31) + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

// group -> claiming agent ({id, name}) or null while the group is free.
// A group is claimed while any of its tickets outside the last (finished)
// column has an assignee.
function computeGroupClaims(tickets) {
  const doneId = doneColumnId();
  const claims = {};
  tickets.forEach(t => {
    if (!t.group) return;
    if (!(t.group in claims)) claims[t.group] = null;
    if (t.column !== doneId && t.assigneeId && !claims[t.group]) {
      claims[t.group] = agents[t.assigneeId] || { id: t.assigneeId, name: '???' };
    }
  });
  return claims;
}

function createGroupWrapper(group, claimer) {
  const wrap = document.createElement('div');
  wrap.className = 'ticket-group' + (claimer ? ' claimed' : '');
  wrap.dataset.group = group;
  wrap.style.setProperty('--group-hue', groupHue(group));
  wrap.innerHTML = `
    <div class="group-header">
      <span class="group-name" title="Ticket group – one agent works on all of these">&#x26D3;&#xFE0F; ${escapeHtml(group)}</span>
      <span class="group-claim ${claimer ? 'claimed' : 'free'}">${claimer ? `&#x1f512; ${escapeHtml(claimer.name)}` : 'free'}</span>
    </div>
    <div class="group-tickets"></div>
  `;
  return wrap;
}

// ---------------------------------------------------------------------------
// Rendering (with FLIP move animation)
// ---------------------------------------------------------------------------

// Build the column skeleton from the project's column config.
function renderBoardColumns() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  board.style.gridTemplateColumns = `repeat(${currentProjectColumns.length}, 1fr)`;
  currentProjectColumns.forEach(col => {
    const div = document.createElement('div');
    div.className = 'column';
    div.dataset.column = col.id;
    div.style.setProperty('--col-color', columnColor(col.id));
    div.innerHTML = `
      <div class="column-header">
        <span class="column-title">${escapeHtml(col.title.toUpperCase())}</span>
        <span class="column-count">0</span>
      </div>
      <div class="ticket-list"></div>
    `;
    board.appendChild(div);
  });
}

function renderBoard(tickets) {
  boardTickets = tickets;
  clearDependencyArrows();
  const columns = currentProjectColumns.map(c => c.id);

  // 1. Snapshot old positions
  const oldState = prevTicketState;
  const oldIds = new Set(oldState.keys());

  // Detect moves, new tickets, and in-place changes (group / assignee)
  const moved = [];   // { id, fromCol, toCol, oldRect, title }
  const created = [];  // ticket ids
  const changed = [];  // ticket ids whose group or assignee changed in place

  tickets.forEach(t => {
    const old = oldState.get(t.id);
    if (old && old.column !== t.column) {
      moved.push({ id: t.id, fromCol: old.column, toCol: t.column, oldRect: old.rect, title: old.title });
    } else if (!oldIds.has(t.id)) {
      created.push(t.id);
    } else if (old && (old.group !== (t.group || '') || old.assignee !== (t.assigneeId || ''))) {
      changed.push(t.id);
    }
  });

  // Claim state per group (shown in group headers, updates in realtime)
  const groupClaims = computeGroupClaims(tickets);
  const oldGroupState = prevGroupState;
  const newGroupKeys = new Set();

  // 2. Render the new board (tickets of the same group cluster together)
  columns.forEach(col => {
    const colEl = document.querySelector(`[data-column="${col}"] .ticket-list`);
    const countEl = document.querySelector(`[data-column="${col}"] .column-count`);
    const colTickets = tickets.filter(t => t.column === col).sort((a, b) =>
      (priorityMeta(b.priority).weight - priorityMeta(a.priority).weight) || (b.position - a.position));
    countEl.textContent = colTickets.length;
    colEl.innerHTML = '';
    const groupWrappers = new Map();
    colTickets.forEach(t => {
      const card = createTicketCard(t);

      // Hide moved tickets initially (will reveal after fly animation)
      if (moved.find(m => m.id === t.id)) {
        card.style.opacity = '0';
        card.style.transform = 'scale(0.95)';
      }

      // Animate new tickets
      if (created.includes(t.id)) {
        card.classList.add('animate-new');
        card.addEventListener('animationend', () => card.classList.remove('animate-new'), { once: true });
      }

      // Flash tickets whose group or assignee changed in place
      if (changed.includes(t.id)) {
        card.classList.add('animate-update');
        card.addEventListener('animationend', () => card.classList.remove('animate-update'), { once: true });
      }

      if (t.group) {
        let wrapper = groupWrappers.get(t.group);
        if (!wrapper) {
          wrapper = createGroupWrapper(t.group, groupClaims[t.group]);
          groupWrappers.set(t.group, wrapper);
          colEl.appendChild(wrapper);
          const key = `${col}::${t.group}`;
          newGroupKeys.add(key);
          // Animate group clusters that newly appeared in this column
          if (!oldGroupState.has(key)) {
            wrapper.classList.add('group-appear');
            wrapper.addEventListener('animationend', () => wrapper.classList.remove('group-appear'), { once: true });
          }
        }
        wrapper.querySelector('.group-tickets').appendChild(card);
      } else {
        colEl.appendChild(card);
      }
    });
  });

  // Dissolve ghosts for group clusters that disappeared from a column
  oldGroupState.forEach((info, key) => {
    if (newGroupKeys.has(key)) return;
    const ghost = document.createElement('div');
    ghost.className = 'group-ghost';
    ghost.style.left = info.rect.left + 'px';
    ghost.style.top = info.rect.top + 'px';
    ghost.style.width = info.rect.width + 'px';
    ghost.style.height = info.rect.height + 'px';
    if (info.hue) ghost.style.setProperty('--group-hue', info.hue);
    document.body.appendChild(ghost);
    ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
    setTimeout(() => { if (ghost.parentNode) ghost.remove(); }, 700);
  });

  // 3. Fly animation for moved tickets
  moved.forEach(m => {
    const newCard = document.querySelector(`.ticket-card[data-ticket-id="${m.id}"]`);
    if (!newCard) return;

    const newRect = newCard.getBoundingClientRect();

    // Create ghost element at old position
    const ghost = document.createElement('div');
    ghost.className = 'ticket-ghost';
    ghost.innerHTML = `<div class="ticket-title">${escapeHtml(m.title)}</div>`;
    ghost.style.left = m.oldRect.left + 'px';
    ghost.style.top = m.oldRect.top + 'px';
    ghost.style.width = m.oldRect.width + 'px';
    document.body.appendChild(ghost);

    // Force layout, then fly to new position
    ghost.offsetHeight;
    ghost.style.left = newRect.left + 'px';
    ghost.style.top = newRect.top + 'px';
    ghost.style.width = newRect.width + 'px';

    // After fly, reveal real card and remove ghost
    ghost.addEventListener('transitionend', () => {
      ghost.remove();
      newCard.style.opacity = '';
      newCard.style.transform = '';
      newCard.classList.add('animate-land');
      newCard.addEventListener('animationend', () => newCard.classList.remove('animate-land'), { once: true });
    }, { once: true });

    // Fallback if transitionend doesn't fire
    setTimeout(() => {
      if (ghost.parentNode) {
        ghost.remove();
        newCard.style.opacity = '';
        newCard.style.transform = '';
      }
    }, 700);
  });

  // 4. Save state for next render
  prevTicketState = snapshotTicketPositions();
  prevGroupState = snapshotGroupPositions();

  // 5. Reapply access pulses (board re-render replaces all card DOM)
  reapplyAllAccessEffects();
}

function createTicketCard(ticket) {
  const card = document.createElement('div');
  card.className = 'ticket-card';
  card.dataset.ticketId = ticket.id;
  card.dataset.group = ticket.group || '';
  card.dataset.assignee = ticket.assigneeId || '';
  if (ticket.group) card.style.setProperty('--group-hue', groupHue(ticket.group));

  const author = ticket.agentId ? (agents[ticket.agentId] || { name: '???' }) : null;
  const assignee = ticket.assigneeId ? (agents[ticket.assigneeId] || { name: '???' }) : null;
  const doneId = doneColumnId();
  const isDone = ticket.column === doneId;

  // Dependency badge: red while any dependency is unfinished, green when all done
  const deps = ticket.dependsOn || [];
  const openDeps = deps.filter(id => {
    const dep = boardTickets.find(t => t.id === id);
    return dep && dep.column !== doneId;
  });
  const depBadge = deps.length > 0
    ? `<span class="ticket-deps ${openDeps.length > 0 ? 'deps-open' : 'deps-done'}"
         title="Depends on ${deps.length} ticket${deps.length !== 1 ? 's' : ''} (${openDeps.length} unfinished) – click to show arrows"
         onclick="event.stopPropagation(); toggleDependencyArrows('${ticket.id}')">&#x2B07;&#xFE0F; ${openDeps.length > 0 ? `${openDeps.length}/${deps.length}` : deps.length}</span>`
    : '';

  card.innerHTML = `
    <div class="ticket-id" title="Click to copy full ID" onclick="event.stopPropagation(); copyId('${ticket.id}', this)">#${ticket.id.slice(0, 8)}</div>
    <div class="ticket-title">${escapeHtml(ticket.title)}</div>
    ${ticket.blockedReason ? `<div class="ticket-blocked" title="Blocked reason">&#x26d4; ${escapeHtml(ticket.blockedReason)}</div>` : ''}
    ${ticket.description ? `<div class="ticket-desc">${escapeHtml(ticket.description)}</div>` : ''}
    <div class="ticket-meta">
      ${priorityBadge(ticket, 'ticket-priority')}
      ${workTypeBadge(ticket, 'ticket-work-type')}
      ${author ? `<span class="ticket-agent" title="Author">&#x270d;&#xfe0f; ${escapeHtml(author.name)}</span>` : '<span></span>'}
      ${assignee ? `<span class="ticket-assignee" title="Assigned to">&#x1f527; ${escapeHtml(assignee.name)}</span>` : ''}
      ${depBadge}
      ${ticket.commentCount > 0 ? `<span class="ticket-comment-count" title="${ticket.commentCount} comment${ticket.commentCount !== 1 ? 's' : ''}">&#x1f4ac; ${ticket.commentCount}</span>` : ''}
      <span class="ticket-updated" title="Last touched">&#x1f552; ${formatTime(ticket.updatedAt)}</span>
    </div>
    <div class="ticket-actions">
      ${isDone
        ? `<button class="btn-small btn-open" onclick="event.stopPropagation(); openTicket('${ticket.projectId}', '${ticket.id}')">Reopen</button>`
        : `<button class="btn-small btn-close" onclick="event.stopPropagation(); closeTicket('${ticket.projectId}', '${ticket.id}')">Close</button>`
      }
    </div>
  `;

  card.style.cursor = 'pointer';
  card.addEventListener('click', () => openModal(ticket.projectId, ticket.id));

  return card;
}

// ---------------------------------------------------------------------------
// Dependency arrows (click a card's dependency badge to visualize them)
// ---------------------------------------------------------------------------

let depArrowsTicketId = null;

function clearDependencyArrows() {
  depArrowsTicketId = null;
  const svg = document.getElementById('dep-arrows');
  if (svg) {
    svg.classList.add('hidden');
    svg.querySelectorAll('path.dep-line').forEach(p => p.remove());
  }
  document.querySelectorAll('.dep-source, .dep-target').forEach(el => {
    el.classList.remove('dep-source', 'dep-target', 'dep-target-done');
  });
}

function toggleDependencyArrows(ticketId) {
  if (depArrowsTicketId === ticketId) {
    clearDependencyArrows();
    return;
  }
  clearDependencyArrows();

  const ticket = boardTickets.find(t => t.id === ticketId);
  const sourceCard = document.querySelector(`.ticket-card[data-ticket-id="${ticketId}"]`);
  if (!ticket || !sourceCard || !(ticket.dependsOn || []).length) return;

  const svg = document.getElementById('dep-arrows');
  const doneId = doneColumnId();
  depArrowsTicketId = ticketId;
  sourceCard.classList.add('dep-source');

  const srcRect = sourceCard.getBoundingClientRect();

  ticket.dependsOn.forEach(depId => {
    const targetCard = document.querySelector(`.ticket-card[data-ticket-id="${depId}"]`);
    if (!targetCard) return;
    const dep = boardTickets.find(t => t.id === depId);
    const isDepDone = dep && dep.column === doneId;

    targetCard.classList.add('dep-target');
    if (isDepDone) targetCard.classList.add('dep-target-done');

    const tgtRect = targetCard.getBoundingClientRect();

    // Start at the source edge facing the target, end at the target's near edge
    const goingRight = tgtRect.left > srcRect.right;
    const x1 = goingRight ? srcRect.right : (tgtRect.right < srcRect.left ? srcRect.left : srcRect.left + srcRect.width / 2);
    const y1 = srcRect.top + srcRect.height / 2;
    const x2 = goingRight ? tgtRect.left : (tgtRect.right < srcRect.left ? tgtRect.right : tgtRect.left + tgtRect.width / 2);
    const y2 = tgtRect.top + tgtRect.height / 2;

    const dx = Math.max(60, Math.abs(x2 - x1) / 2);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', `dep-line ${isDepDone ? 'dep-line-done' : 'dep-line-open'}`);
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + (goingRight ? dx : -dx)} ${y1}, ${x2 + (goingRight ? -dx : dx)} ${y2}, ${x2} ${y2}`);
    path.setAttribute('marker-end', `url(#dep-arrowhead-${isDepDone ? 'done' : 'open'})`);
    svg.appendChild(path);
  });

  svg.classList.remove('hidden');
}

// Any click outside a dependency badge dismisses the arrows
document.addEventListener('click', (e) => {
  if (depArrowsTicketId && !e.target.closest('.ticket-deps')) {
    clearDependencyArrows();
  }
});
window.addEventListener('resize', clearDependencyArrows);
window.addEventListener('scroll', clearDependencyArrows, true);

window.toggleDependencyArrows = toggleDependencyArrows;

function createActivityItem(a) {
  const agent = a.agentId
    ? (a.agent ? a.agent : (agents[a.agentId] || { name: 'unknown' }))
    : { name: 'Human' };
  const item = document.createElement('div');
  item.className = 'activity-item';
  item.innerHTML = `
    <span class="activity-text">
      <span class="agent-name">${escapeHtml(agent.name)}</span>
      ${escapeHtml(a.details)}
    </span>
    <span class="activity-time">${formatTime(a.timestamp)}</span>
  `;
  return item;
}

function renderActivity() {
  const list = document.getElementById('activity-list');
  const count = document.getElementById('activity-count');
  count.textContent = `${activities.length} events`;
  list.innerHTML = '';

  activities.slice(0, 50).forEach(a => {
    list.appendChild(createActivityItem(a));
  });
}

function prependActivityEntry(a) {
  const list = document.getElementById('activity-list');
  if (!list) return;
  const item = createActivityItem(a);
  item.classList.add('activity-item-new');
  item.addEventListener('animationend', () => item.classList.remove('activity-item-new'), { once: true });
  list.insertBefore(item, list.firstChild);
  // Update count
  const count = document.getElementById('activity-count');
  const n = list.children.length;
  count.textContent = `${n} events`;
  // Keep max 50 entries
  while (list.children.length > 50) list.removeChild(list.lastChild);
}

function createAuditItem(e) {
  const agent = e.agentId ? (agents[e.agentId] || { name: '???' }) : null;
  const item = document.createElement('div');
  item.className = 'audit-item';
  // Business-level actions (from service layer) vs HTTP-level (from middleware)
  const businessActions = ['LIST', 'READ', 'CREATE', 'UPDATE', 'DELETE', 'MOVE', 'COMMENT'];
  const isBusiness = businessActions.includes(e.method);
  if (isBusiness) {
    const details = e.requestBody ? ` (${escapeHtml(e.requestBody)})` : '';
    item.innerHTML = `
      <span class="audit-method ${e.method}">${e.method}</span>
      <span class="audit-agent">${agent ? escapeHtml(agent.name) : 'system'}</span>
      <span class="audit-path">${escapeHtml(e.path)}${details}</span>
      <span class="audit-time">${formatTime(e.timestamp)}</span>
    `;
  } else {
    item.innerHTML = `
      <span class="audit-method ${e.method}">${e.method}</span>
      <span class="audit-status">${e.statusCode}</span>
      <span class="audit-path">${escapeHtml(e.path)}${agent ? ` (${escapeHtml(agent.name)})` : ''}</span>
      <span class="audit-time">${formatTime(e.timestamp)}</span>
    `;
  }
  return item;
}

function renderAudit(entries) {
  const list = document.getElementById('audit-list');
  list.innerHTML = '';
  entries.forEach(e => list.appendChild(createAuditItem(e)));
}

function prependAuditEntry(e) {
  const list = document.getElementById('audit-list');
  if (!list || list.classList.contains('hidden')) return;
  const item = createAuditItem(e);
  item.classList.add('audit-item-new');
  item.addEventListener('animationend', () => item.classList.remove('audit-item-new'), { once: true });
  list.insertBefore(item, list.firstChild);
  // Keep max 50 entries
  while (list.children.length > 50) list.removeChild(list.lastChild);
}

// ---------------------------------------------------------------------------
// Human actions
// ---------------------------------------------------------------------------

async function closeTicket(projectId, ticketId) {
  await postJSON(`/api/projects/${projectId}/tickets/${ticketId}/close`, {});
  await loadBoard(projectId);
  await loadActivity(projectId);
}

async function openTicket(projectId, ticketId) {
  await postJSON(`/api/projects/${projectId}/tickets/${ticketId}/open`, {});
  await loadBoard(projectId);
  await loadActivity(projectId);
}

window.closeTicket = closeTicket;
window.openTicket = openTicket;

// ---------------------------------------------------------------------------
// Ticket Detail Modal
// ---------------------------------------------------------------------------

let currentModalTicket = null;

// Details sidebar helpers: a row without a value is hidden entirely (Jira-style),
// unless a placeholder like "Unassigned" is given.
function toggleSideRow(el, visible) {
  const row = el && el.closest ? el.closest('.modal-side-row') : null;
  if (row) row.classList.toggle('hidden', !visible);
}

function setSideValue(id, value, placeholder) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value || placeholder || '';
  toggleSideRow(el, !!(value || placeholder));
}

async function openModal(projectId, ticketId) {
  const modal = document.getElementById('ticket-modal');
  const [ticket, comments, revisions] = await Promise.all([
    fetchJSON(`/api/projects/${projectId}/tickets/${ticketId}`),
    fetchJSON(`/api/projects/${projectId}/tickets/${ticketId}/comments`),
    fetchJSON(`/api/projects/${projectId}/tickets/${ticketId}/revisions`),
  ]);

  currentModalTicket = ticket;

  // Header
  const modalIdEl = document.getElementById('modal-ticket-id');
  modalIdEl.textContent = `#${ticket.id.slice(0, 8)}`;
  modalIdEl.title = 'Click to copy full ID';
  modalIdEl.onclick = () => copyId(ticket.id, modalIdEl);
  const badge = document.getElementById('modal-column-badge');
  badge.textContent = columnTitle(ticket.column);
  badge.className = 'modal-column-badge ' + ticket.column;
  badge.style.setProperty('--col-color', columnColor(ticket.column));

  // Priority badge next to the column badge
  const prioEl = document.getElementById('modal-priority');
  if (prioEl) {
    const meta = priorityMeta(ticket.priority);
    prioEl.textContent = `${meta.icon} ${meta.label}`;
    prioEl.className = `modal-priority prio-${ticket.priority || 'medium'}`;
    prioEl.title = `Priority: ${meta.label}`;
  }

  // Work type badge (hidden entirely while the ticket is unclassified)
  const workEl = document.getElementById('modal-work-type');
  if (workEl) {
    const wtMeta = WORK_TYPE_META[ticket.workType];
    if (wtMeta) {
      workEl.textContent = `${wtMeta.icon} ${wtMeta.label}`;
      workEl.className = `modal-work-type work-${ticket.workType}`;
      workEl.title = `${wtMeta.label}: ${wtMeta.hint}`;
    } else {
      workEl.textContent = '';
      workEl.className = 'modal-work-type hidden';
      workEl.title = '';
    }
    toggleSideRow(workEl, !!wtMeta);
  }

  // Title
  document.getElementById('modal-title').textContent = ticket.title;

  // Details sidebar: author
  const author = ticket.agentId ? (agents[ticket.agentId] || { name: '???' }) : null;
  setSideValue('modal-author', author ? author.name : '');

  // Assignee (read-only, agents assign themselves via API)
  const assignee = ticket.assigneeId ? (agents[ticket.assigneeId] || { name: '???' }) : null;
  setSideValue('modal-assignee-display', assignee ? assignee.name : '', 'Unassigned');

  // Group
  setSideValue('modal-group-display', ticket.group || '');

  // Last touched
  setSideValue('modal-updated', formatTime(ticket.updatedAt));

  // Blocked reason (prominent when set)
  const blockedEl = document.getElementById('modal-blocked');
  if (blockedEl) {
    if (ticket.blockedReason) {
      blockedEl.innerHTML = `\u{26d4} <strong>Blocked:</strong> ${escapeHtml(ticket.blockedReason)}`;
      blockedEl.style.display = '';
    } else {
      blockedEl.style.display = 'none';
    }
  }

  // Dependencies (with live status of each dependency ticket)
  const depsEl = document.getElementById('modal-deps');
  if (depsEl) {
    const deps = ticket.dependsOn || [];
    if (deps.length > 0) {
      const doneId = doneColumnId();
      const items = deps.map(depId => {
        const dep = boardTickets.find(t => t.id === depId);
        if (!dep) return `<div class="modal-dep-item">\u{2753} #${escapeHtml(depId.slice(0, 8))} (not found)</div>`;
        const done = dep.column === doneId;
        return `
          <div class="modal-dep-item ${done ? 'dep-done' : 'dep-open'}">
            ${done ? '\u{2705}' : '\u{23f3}'}
            <span class="modal-dep-id">#${dep.id.slice(0, 8)}</span>
            <span class="modal-dep-title">${escapeHtml(dep.title)}</span>
            <span class="modal-dep-col">${escapeHtml(columnTitle(dep.column))}</span>
          </div>`;
      }).join('');
      depsEl.innerHTML = `<div class="modal-deps-label">\u{2B07}\u{FE0F} Depends on:</div>${items}`;
      depsEl.style.display = '';
    } else {
      depsEl.style.display = 'none';
    }
  }

  // Description (Markdown rendered, monospace font for ASCII art)
  document.getElementById('modal-desc').innerHTML = renderMarkdown(ticket.description || '');

  // Comments
  const commentsEl = document.getElementById('modal-comments');
  if (comments.length === 0) {
    commentsEl.innerHTML = '<div class="modal-empty">No comments yet.</div>';
  } else {
    commentsEl.innerHTML = '';
    comments.reverse().forEach(c => {
      const a = c.agentId ? (agents[c.agentId] || { name: '???' }) : { name: 'Human' };
      const div = document.createElement('div');
      div.className = 'modal-comment';
      div.innerHTML = `
        <div class="modal-comment-header">
          <span class="modal-comment-agent">\u{1f916} ${escapeHtml(a.name)}</span>
          <span class="modal-comment-time">${formatTime(c.createdAt)}</span>
        </div>
        <div class="modal-comment-body markdown-body">${renderMarkdown(c.body)}</div>
      `;
      commentsEl.appendChild(div);
    });
  }

  // Revisions
  const revisionsEl = document.getElementById('modal-revisions');
  if (revisions.length === 0) {
    revisionsEl.innerHTML = '<div class="modal-empty">No changes recorded yet.</div>';
  } else {
    revisionsEl.innerHTML = '';
    revisions.forEach(r => {
      const a = r.agentId ? (agents[r.agentId] || { name: '???' }) : { name: 'Human' };
      const div = document.createElement('div');
      div.className = 'modal-revision';

      const fieldLabel = r.field === 'column' ? 'column' : r.field;
      const oldVal = r.oldValue || '(empty)';
      const newVal = r.newValue || '(empty)';

      div.innerHTML = `
        <div class="modal-revision-header">
          <span class="modal-revision-agent">${escapeHtml(a.name)}</span>
          <span class="modal-revision-time">${formatTime(r.timestamp)}</span>
        </div>
        <div class="modal-revision-change">
          <span class="modal-revision-field">${escapeHtml(fieldLabel)}</span>:
          <span class="modal-revision-old">${escapeHtml(oldVal)}</span>
          &rarr;
          <span class="modal-revision-new">${escapeHtml(newVal)}</span>
        </div>
      `;
      revisionsEl.appendChild(div);
    });
  }

  // Reset to comments tab
  switchTab('comments');

  // Show (always start at the top of the ticket)
  modal.classList.remove('hidden');
  const body = modal.querySelector('.modal-body');
  if (body) body.scrollTop = 0;
}

function closeModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('ticket-modal').classList.add('hidden');
  currentModalTicket = null;
}

function switchTab(tabName) {
  document.querySelectorAll('.modal-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.modal-tab-content').forEach(el => {
    el.classList.toggle('hidden', el.id !== `tab-${tabName}`);
  });
}

function handleCommentAdded(data) {
  const comment = data.commentAdded;
  if (!comment) return;

  // Reload board to update comment count badges
  if (currentProjectId) loadBoard(currentProjectId);

  // If the modal is open for this ticket, prepend the new comment in realtime
  if (currentModalTicket && currentModalTicket.id === comment.ticketId) {
    const commentsEl = document.getElementById('modal-comments');
    // Remove "No comments yet." placeholder if present
    const emptyMsg = commentsEl.querySelector('.modal-empty');
    if (emptyMsg) emptyMsg.remove();

    const agent = comment.agent || { name: '???' };
    const div = document.createElement('div');
    div.className = 'modal-comment modal-comment-new';
    div.innerHTML = `
      <div class="modal-comment-header">
        <span class="modal-comment-agent">\u{1f916} ${escapeHtml(agent.name)}</span>
        <span class="modal-comment-time">${formatTime(comment.createdAt)}</span>
      </div>
      <div class="modal-comment-body markdown-body">${renderMarkdown(comment.body)}</div>
    `;
    // Newest first – prepend
    commentsEl.insertBefore(div, commentsEl.firstChild);
    div.addEventListener('animationend', () => div.classList.remove('modal-comment-new'), { once: true });
  }
}

window.openModal = openModal;
window.closeModal = closeModal;
window.switchTab = switchTab;

// ---------------------------------------------------------------------------
// Columns Editor Modal (per-project board columns)
// ---------------------------------------------------------------------------

function slugifyColumnId(title) {
  return title
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[c]))
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'col';
}

function columnEditorRow(col) {
  const row = document.createElement('div');
  row.className = 'columns-editor-row';
  row.dataset.colId = col.id || '';
  row.innerHTML = `
    <span class="columns-editor-drag">&#x2630;</span>
    <input type="text" class="columns-editor-title" value="${escapeHtml(col.title)}" placeholder="Column name" maxlength="50">
    <span class="columns-editor-id">${col.id ? escapeHtml(col.id) : ''}</span>
    <button class="btn-small" title="Move up" onclick="moveColumnRow(this, -1)">&#x25B2;</button>
    <button class="btn-small" title="Move down" onclick="moveColumnRow(this, 1)">&#x25BC;</button>
    <button class="btn-small btn-remove-column" title="Remove column" onclick="this.closest('.columns-editor-row').remove()">&#x2715;</button>
  `;
  return row;
}

function openColumnsModal() {
  if (!currentProjectId) return;
  const list = document.getElementById('columns-editor-list');
  list.innerHTML = '';
  currentProjectColumns.forEach(col => list.appendChild(columnEditorRow(col)));
  const errEl = document.getElementById('columns-error');
  errEl.style.display = 'none';
  document.getElementById('columns-modal').classList.remove('hidden');
}

function closeColumnsModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('columns-modal').classList.add('hidden');
}

function addColumnRow() {
  document.getElementById('columns-editor-list').appendChild(columnEditorRow({ id: '', title: '' }));
}

function moveColumnRow(btn, direction) {
  const row = btn.closest('.columns-editor-row');
  const sibling = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return;
  if (direction < 0) row.parentNode.insertBefore(row, sibling);
  else row.parentNode.insertBefore(sibling, row);
}

async function saveColumns() {
  const rows = [...document.querySelectorAll('#columns-editor-list .columns-editor-row')];
  const errEl = document.getElementById('columns-error');
  const usedIds = new Set();

  const columns = [];
  for (const row of rows) {
    const title = row.querySelector('.columns-editor-title').value.trim();
    if (!title) continue; // ignore empty rows
    // Existing columns keep their id (tickets reference it); new ones get a slug
    let id = row.dataset.colId || slugifyColumnId(title);
    while (usedIds.has(id)) id = `${id}_2`.slice(0, 32);
    usedIds.add(id);
    columns.push({ id, title });
  }

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/columns`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columns }),
    });
    const body = await res.json();
    if (!res.ok) {
      errEl.textContent = body.error || `HTTP ${res.status}`;
      errEl.style.display = 'block';
      return;
    }
    closeColumnsModal();
    // The projectChanged subscription re-renders the board; do it directly
    // too in case the WebSocket is reconnecting.
    currentProjectColumns = body.columns;
    renderBoardColumns();
    prevTicketState = new Map();
    prevGroupState = new Map();
    await loadBoard(currentProjectId);
  } catch (e) {
    errEl.textContent = String(e);
    errEl.style.display = 'block';
  }
}

window.openColumnsModal = openColumnsModal;
window.closeColumnsModal = closeColumnsModal;
window.addColumnRow = addColumnRow;
window.moveColumnRow = moveColumnRow;
window.saveColumns = saveColumns;

// ---------------------------------------------------------------------------
// Agents Modal (show API keys)
// ---------------------------------------------------------------------------

async function openAgentsModal() {
  const modal = document.getElementById('agents-modal');
  const list = document.getElementById('agents-list');
  list.innerHTML = '<div class="agents-empty">Loading...</div>';
  modal.classList.remove('hidden');

  try {
    const agentsWithKeys = await fetchJSON('/api/agents/keys');

    if (agentsWithKeys.length === 0) {
      list.innerHTML = '<div class="agents-empty">No agents registered yet.</div>';
      return;
    }

    list.innerHTML = '';
    agentsWithKeys.forEach(a => {
      const row = document.createElement('div');
      row.className = 'agent-row';
      row.innerHTML = `
        <div class="agent-row-info">
          <div class="agent-row-name">\u{1f916} ${escapeHtml(a.name)}</div>
          <div class="agent-row-key">${escapeHtml(a.apiKey)}</div>
          <div class="agent-row-meta">ID: ${a.id.slice(0, 8)} &middot; Created: ${formatTime(a.createdAt)}</div>
        </div>
        <button class="btn-copy" onclick="copyApiKey(this, '${escapeHtml(a.apiKey)}')">Copy</button>
      `;
      list.appendChild(row);
    });
  } catch {
    list.innerHTML = '<div class="agents-empty">Failed to load agents.</div>';
  }
}

function closeAgentsModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('agents-modal').classList.add('hidden');
}

function copyApiKey(btn, key) {
  navigator.clipboard.writeText(key).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1500);
  });
}

function copyId(fullId, el) {
  navigator.clipboard.writeText(fullId).then(() => {
    const original = el.textContent;
    el.textContent = 'Copied!';
    el.classList.add('copied');
    setTimeout(() => {
      el.textContent = original;
      el.classList.remove('copied');
    }, 1200);
  });
}

window.openAgentsModal = openAgentsModal;
window.closeAgentsModal = closeAgentsModal;
window.copyApiKey = copyApiKey;
window.copyId = copyId;

// ---------------------------------------------------------------------------
// Agent access indicator (briefly shows who is reading or changing a ticket)
// ---------------------------------------------------------------------------

const ACCESS_LABELS = {
  list: 'scanning',
  read: 'reading',
  create: 'creating',
  update: 'editing',
  move: 'moving',
  assign: 'assigning',
  unassign: 'unassigning',
  comment: 'commenting',
  delete: 'deleting',
};

function handleTicketAccessed(data) {
  const { ticketId, agentId, agentName, action } = data.ticketAccessed;
  console.log('[agentboard] ticketAccessed event:', { ticketId: ticketId?.slice(0, 8), agentId, agentName, action });

  if (!ticketAccesses.has(ticketId)) {
    ticketAccesses.set(ticketId, new Map());
  }
  const accesses = ticketAccesses.get(ticketId);

  if (accesses.has(agentId)) {
    clearTimeout(accesses.get(agentId).timer);
  }

  const timer = setTimeout(() => {
    accesses.delete(agentId);
    if (accesses.size === 0) ticketAccesses.delete(ticketId);
    renderAccessEffect(ticketId);
  }, ACCESS_EFFECT_DURATION);

  accesses.set(agentId, { name: agentName, action, timer });
  renderAccessEffect(ticketId, true);
}

function renderAccessEffect(ticketId, restartAnimation = false) {
  const card = document.querySelector(`.ticket-card[data-ticket-id="${ticketId}"]`);
  if (!card) return;

  const existing = card.querySelector('.access-badges');
  if (existing) existing.remove();
  card.classList.remove('ticket-accessed', 'ticket-access-write');

  const accesses = ticketAccesses.get(ticketId);
  if (!accesses || accesses.size === 0) return;

  if ([...accesses.values()].some(({ action }) => !['list', 'read'].includes(action))) {
    card.classList.add('ticket-access-write');
  }
  if (restartAnimation) void card.offsetWidth;
  card.classList.add('ticket-accessed');

  const container = document.createElement('div');
  container.className = 'access-badges';

  accesses.forEach(({ name, action }) => {
    const badge = document.createElement('div');
    const isWrite = !['list', 'read'].includes(action);
    badge.className = `access-badge${isWrite ? ' access-badge-write' : ''}`;
    badge.innerHTML = `<span class="access-dot"></span> ${escapeHtml(name)} <span class="access-label">${ACCESS_LABELS[action] || 'accessing'}</span>`;
    container.appendChild(badge);
  });

  card.insertBefore(container, card.firstChild);
}

function reapplyAllAccessEffects() {
  ticketAccesses.forEach((_, ticketId) => {
    renderAccessEffect(ticketId);
  });
}

function clearAllAccessTimers() {
  ticketAccesses.forEach(accesses => {
    accesses.forEach(({ timer }) => clearTimeout(timer));
  });
  ticketAccesses.clear();
}

// ---------------------------------------------------------------------------
// GraphQL WebSocket subscriptions (realtime)
// ---------------------------------------------------------------------------

function connectWebSocket(projectId) {
  if (ws) {
    ws.onclose = null; // prevent old socket's onclose from interfering
    ws.close();
    ws = null;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/graphql`;

  console.log('[agentboard] Connecting WebSocket to', wsUrl);
  const socket = new WebSocket(wsUrl, 'graphql-transport-ws');
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return; // stale socket
    console.log('[agentboard] WebSocket open, sending connection_init');
    socket.send(JSON.stringify({ type: 'connection_init' }));
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return; // stale socket
    const msg = JSON.parse(event.data);
    console.log('[agentboard] WS message:', msg.type, msg.id || '');

    if (msg.type === 'connection_ack') {
      console.log('[agentboard] Connected! Subscribing to events', projectId ? `for project ${projectId}` : '(overview)');
      // Always subscribe to global events
      subscribeGlobal(socket, '6', 'agentChanged', 'id name createdAt');
      subscribeGlobal(socket, '7', 'projectChanged', 'id name description columns { id title } createdAt');
      subscribeGlobal(socket, '9', 'auditAdded', 'id agentId method path statusCode requestBody timestamp');
      subscribeGlobal(socket, '11', 'runtimeStatusChanged', 'working idle codexWorking claudeWorking openCodeWorking workingSince workingForSeconds hosts { host workingCodex workingClaude workingOpenCode idleCodex idleClaude idleOpenCode reportedAt }');
      // Project-specific subscriptions only when viewing a project
      if (projectId) {
        subscribe(socket, '1', 'ticketCreated', projectId);
        subscribe(socket, '2', 'ticketUpdated', projectId);
        subscribe(socket, '3', 'ticketMoved', projectId);
        subscribe(socket, '4', 'activityAdded', projectId);
        subscribe(socket, '5', 'ticketDeleted', projectId);
        subscribe(socket, '8', 'ticketAccessed', projectId);
        subscribe(socket, '10', 'commentAdded', projectId);
      }
    }

    if (msg.type === 'next') {
      console.log('[agentboard] Subscription event:', msg.id, msg.payload);
      handleSubscriptionEvent(msg.id, msg.payload?.data);
    }

    if (msg.type === 'error') {
      console.error('[agentboard] Subscription error:', msg.payload);
    }
  };

  socket.onerror = (err) => {
    console.error('[agentboard] WebSocket error:', err);
  };

  socket.onclose = (event) => {
    console.log('[agentboard] WebSocket closed, code:', event.code, 'reason:', event.reason);
    if (ws !== socket) return; // already replaced by a new connection
    ws = null;
    // Reconnect after 2 seconds
    setTimeout(() => {
      connectWebSocket(currentProjectId);
    }, 2000);
  };
}

function subscribe(socket, id, eventName, projectId) {
  let query;
  if (eventName === 'activityAdded') {
    query = `subscription { ${eventName}(projectId: "${projectId}") { id agentId agent { id name } ticketId action details timestamp } }`;
  } else if (eventName === 'ticketAccessed') {
    query = `subscription { ${eventName}(projectId: "${projectId}") { ticketId projectId agentId agentName action } }`;
  } else if (eventName === 'commentAdded') {
    query = `subscription { ${eventName}(projectId: "${projectId}") { id ticketId agent { id name } body createdAt } }`;
  } else {
    query = `subscription { ${eventName}(projectId: "${projectId}") { id projectId title description column position group blockedReason priority workType dependsOn agentId assigneeId agent { id name } assignee { id name } createdAt updatedAt } }`;
  }

  socket.send(JSON.stringify({
    id,
    type: 'subscribe',
    payload: { query },
  }));
}

function subscribeGlobal(socket, id, eventName, fields) {
  socket.send(JSON.stringify({
    id,
    type: 'subscribe',
    payload: { query: `subscription { ${eventName} { ${fields} } }` },
  }));
}

function handleSubscriptionEvent(subId, data) {
  if (!data) return;

  // Agent changed → reload agents (global, no project needed)
  if (subId === '6') {
    loadAgents();
    return;
  }

  // Project changed → reload overview if visible; if the open project's
  // columns changed, re-render the board with the new column set
  if (subId === '7') {
    const changed = data.projectChanged;
    if (!currentProjectId) {
      loadProjectOverview();
    } else if (changed && changed.id === currentProjectId) {
      const newCols = (changed.columns && changed.columns.length) ? changed.columns : FALLBACK_COLUMNS;
      if (JSON.stringify(newCols) !== JSON.stringify(currentProjectColumns)) {
        currentProjectColumns = newCols;
        renderBoardColumns();
        prevTicketState = new Map();
        prevGroupState = new Map();
        loadBoard(currentProjectId);
      }
      if (changed.name) {
        currentProjectName = changed.name;
        document.getElementById('current-project-name').textContent = `← ${changed.name}`;
      }
    }
    return;
  }

  // Audit event → prepend to audit log in realtime
  if (subId === '9') {
    if (data.auditAdded) prependAuditEntry(data.auditAdded);
    return;
  }

  if (subId === '11') {
    loadRuntimeStatus();
    return;
  }

  if (!currentProjectId) return;

  // Any ticket event (create, update, move, delete) → reload board, activity, agents
  if (subId === '1' || subId === '2' || subId === '3' || subId === '5') {
    loadBoard(currentProjectId);
    loadActivity(currentProjectId);
    loadAgents();
  }

  // Activity event → prepend with animation (no full reload)
  if (subId === '4') {
    if (data.activityAdded) prependActivityEntry(data.activityAdded);
  }

  // Ticket accessed → briefly show agent and operation on its card
  if (subId === '8') {
    handleTicketAccessed(data);
  }

  // Comment added → refresh modal if open for that ticket + reload board for comment count
  if (subId === '10') {
    handleCommentAdded(data);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined' && marked.parse) {
    return marked.parse(text, { breaks: true });
  }
  return escapeHtml(text);
}

function formatTime(timestamp) {
  const date = new Date(timestamp + 'Z');
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function hideLoading() {
  const loading = document.getElementById('loading-screen');
  if (loading) {
    loading.classList.add('hidden');
  }
  // Show overview if nothing is selected yet
  if (!currentProjectId) {
    document.getElementById('project-overview').style.display = 'flex';
  }
}

let currentProjectName = null;

async function selectProject(projectId, projectName) {
  currentProjectId = projectId || null;
  currentProjectName = projectName || null;

  const board = document.getElementById('board');
  const overview = document.getElementById('project-overview');
  const activityFeed = document.getElementById('activity-feed');
  const auditPanel = document.getElementById('audit-panel');
  const projectLabel = document.getElementById('current-project-name');

  // Stop overview polling
  if (overviewPollTimer) { clearInterval(overviewPollTimer); overviewPollTimer = null; }

  if (currentProjectId) {
    overview.style.display = 'none';
    board.classList.remove('hidden');
    board.style.display = 'grid';
    activityFeed.classList.remove('hidden');
    activityFeed.style.display = 'flex';
    auditPanel.classList.remove('hidden');
    auditPanel.style.display = 'block';
    projectLabel.textContent = `\u2190 ${currentProjectName || 'Back'}`;
    projectLabel.style.display = '';
    document.getElementById('edit-columns-btn').style.display = '';

    // Load the project's column config before rendering the board
    try {
      const project = await fetchJSON(`/api/projects/${currentProjectId}`);
      currentProjectColumns = (project.columns && project.columns.length) ? project.columns : FALLBACK_COLUMNS;
    } catch {
      currentProjectColumns = FALLBACK_COLUMNS;
    }
    renderBoardColumns();
    prevTicketState = new Map();
    prevGroupState = new Map();

    await loadBoard(currentProjectId);
    await loadActivity(currentProjectId);
    await loadAudit();
    connectWebSocket(currentProjectId);
  } else {
    showOverview();
  }
}

async function showOverview() {
  currentProjectId = null;
  currentProjectName = null;

  const board = document.getElementById('board');
  const overview = document.getElementById('project-overview');
  const activityFeed = document.getElementById('activity-feed');
  const auditPanel = document.getElementById('audit-panel');
  const projectLabel = document.getElementById('current-project-name');

  board.classList.add('hidden');
  overview.style.display = 'flex';
  activityFeed.classList.add('hidden');
  auditPanel.classList.add('hidden');
  projectLabel.style.display = 'none';
  document.getElementById('edit-columns-btn').style.display = 'none';
  clearDependencyArrows();

  if (ws) { ws.close(); ws = null; }
  clearAllAccessTimers();

  await loadProjectOverview();
  connectWebSocket(null);

  // Poll for stat updates while on overview
  if (overviewPollTimer) clearInterval(overviewPollTimer);
  overviewPollTimer = setInterval(() => {
    if (!currentProjectId) loadProjectOverview();
  }, 5000);
}

window.showOverview = showOverview;

async function init() {
  try {
    await Promise.all([loadAgents(), loadRuntimeStatus()]);
    await loadProjectOverview(); // may auto-select if single project
  } catch (e) {
    console.error('[agentboard] Init failed:', e);
  }
  hideLoading();
  runtimePollTimer = setInterval(loadRuntimeStatus, 15000);
  runtimeDurationTimer = setInterval(() => {
    if (runtimeStatusSnapshot) renderRuntimeStatus(runtimeStatusSnapshot);
  }, 1000);

  // Start overview polling + WS if still on overview
  if (!currentProjectId) {
    connectWebSocket(null);
    overviewPollTimer = setInterval(() => {
      if (!currentProjectId) loadProjectOverview();
    }, 5000);
  }

  // Audit toggle
  document.getElementById('audit-toggle').addEventListener('click', () => {
    const list = document.getElementById('audit-list');
    const btn = document.getElementById('audit-toggle');
    if (list.classList.contains('hidden')) {
      list.classList.remove('hidden');
      list.style.display = 'block';
      btn.textContent = 'Hide';
      loadAudit();
    } else {
      list.classList.add('hidden');
      btn.textContent = 'Show';
    }
  });
}

// Ensure the loading screen is painted before init runs
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    init();
  });
});
