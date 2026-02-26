// ---------------------------------------------------------------------------
// Agentboard – Frontend Application (realtime via GraphQL subscriptions)
// ---------------------------------------------------------------------------

const API_BASE = '';
let currentProjectId = null;
let ws = null;
let agents = {};
let activities = [];

// ---------------------------------------------------------------------------
// Agent viewing tracker – ticketId -> Map<agentId, {name, timer}>
// ---------------------------------------------------------------------------
const ticketViewers = new Map();
const VIEWING_DURATION = 60000; // 60 seconds

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
let prevOverviewStats = {}; // projectId -> { backlog, ready, ... , total }

async function loadProjectOverview() {
  const data = await graphqlQuery(`{
    projects {
      id name description
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
    const stats = { backlog: 0, ready: 0, in_progress: 0, in_review: 0, done: 0 };
    p.tickets.forEach(t => { if (stats[t.column] !== undefined) stats[t.column]++; });
    stats.total = Object.values(stats).reduce((a, b) => a + b, 0);
    newStats[p.id] = stats;
  });

  // Check if we can do an in-place update (same projects, same order)
  const existingRows = tbody.querySelectorAll('tr');
  const canPatch = existingRows.length === projects.length &&
    projects.every((p, i) => existingRows[i]?.dataset.projectId === p.id);

  if (canPatch) {
    // In-place update: only update changed cells with animation
    const cols = ['backlog', 'ready', 'in_progress', 'in_review', 'done', 'total'];
    projects.forEach((p, i) => {
      const row = existingRows[i];
      const cells = row.querySelectorAll('.overview-count');
      const prev = prevOverviewStats[p.id] || {};
      const cur = newStats[p.id];

      cols.forEach((col, ci) => {
        const cell = cells[ci];
        if (!cell) return;
        const oldVal = prev[col] ?? -1;
        const newVal = cur[col];
        if (oldVal !== newVal) {
          cell.textContent = newVal;
          cell.className = `overview-count col-${col.replace('_', '-')}${newVal === 0 ? ' zero' : ''}`;
          cell.classList.add('overview-flash');
          cell.addEventListener('animationend', () => cell.classList.remove('overview-flash'), { once: true });

          // Ticker delta badge (like a stock ticker)
          if (oldVal >= 0) {
            const delta = newVal - oldVal;
            const badge = document.createElement('span');
            badge.className = `overview-delta ${delta > 0 ? 'delta-up' : 'delta-down'}`;
            badge.textContent = delta > 0 ? `+${delta}` : `${delta}`;
            cell.style.position = 'relative';
            cell.appendChild(badge);
            badge.addEventListener('animationend', () => badge.remove(), { once: true });
          }
        }
      });
    });
  } else {
    // Full rebuild (project list changed)
    tbody.innerHTML = '';
    const cols = ['backlog', 'ready', 'in_progress', 'in_review', 'done', 'total'];

    projects.forEach(p => {
      const stats = newStats[p.id];
      const tr = document.createElement('tr');
      tr.dataset.projectId = p.id;
      tr.onclick = () => selectProject(p.id, p.name);

      function cell(val, col) {
        return `<td class="overview-count col-${col.replace('_', '-')}${val === 0 ? ' zero' : ''}">${val}</td>`;
      }

      const isNew = !!prevOverviewStats[p.id] === false && Object.keys(prevOverviewStats).length > 0;

      tr.innerHTML = `
        <td>
          <div class="overview-project-name">${escapeHtml(p.name)}</div>
          ${p.description ? `<div class="overview-project-desc">${escapeHtml(p.description)}</div>` : ''}
        </td>
        ${cols.map(c => cell(stats[c], c)).join('')}
      `;

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

async function loadBoard(projectId) {
  const tickets = await fetchJSON(`/api/projects/${projectId}/tickets`);
  renderBoard(tickets);
  // Update snapshot after render so next diff works
  prevTicketState = snapshotTicketPositions();
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
      snap.set(id, { column: col, rect: card.getBoundingClientRect(), title: card.querySelector('.ticket-title')?.textContent || '' });
    }
  });
  return snap;
}

// ---------------------------------------------------------------------------
// Rendering (with FLIP move animation)
// ---------------------------------------------------------------------------

function renderBoard(tickets) {
  const columns = ['backlog', 'ready', 'in_progress', 'in_review', 'done'];

  // 1. Snapshot old positions
  const oldState = prevTicketState;
  const oldIds = new Set(oldState.keys());

  // Build new state map
  const newState = new Map();
  tickets.forEach(t => newState.set(t.id, t.column));

  // Detect moves and new tickets
  const moved = [];   // { id, fromCol, toCol, oldRect, title }
  const created = [];  // ticket ids

  newState.forEach((newCol, id) => {
    const old = oldState.get(id);
    if (old && old.column !== newCol) {
      moved.push({ id, fromCol: old.column, toCol: newCol, oldRect: old.rect, title: old.title });
    } else if (!oldIds.has(id)) {
      created.push(id);
    }
  });

  // 2. Render the new board
  columns.forEach(col => {
    const colEl = document.querySelector(`[data-column="${col}"] .ticket-list`);
    const countEl = document.querySelector(`[data-column="${col}"] .column-count`);
    const colTickets = tickets.filter(t => t.column === col).sort((a, b) => a.position - b.position);
    countEl.textContent = colTickets.length;
    colEl.innerHTML = '';
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

      colEl.appendChild(card);
    });
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

  // 5. Reapply viewing badges (board re-render replaces all card DOM)
  reapplyAllViewingBadges();
}

function createTicketCard(ticket) {
  const card = document.createElement('div');
  card.className = 'ticket-card';
  card.dataset.ticketId = ticket.id;

  const agent = ticket.agentId ? (agents[ticket.agentId] || { name: '???' }) : null;
  const isDone = ticket.column === 'done';

  card.innerHTML = `
    <div class="ticket-id">#${ticket.id.slice(0, 8)}</div>
    <div class="ticket-title">${escapeHtml(ticket.title)}</div>
    ${ticket.description ? `<div class="ticket-desc">${escapeHtml(ticket.description)}</div>` : ''}
    <div class="ticket-meta">
      ${agent ? `<span class="ticket-agent">&#x1f916; ${escapeHtml(agent.name)}</span>` : '<span></span>'}
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

async function openModal(projectId, ticketId) {
  const modal = document.getElementById('ticket-modal');
  const [ticket, comments, revisions] = await Promise.all([
    fetchJSON(`/api/projects/${projectId}/tickets/${ticketId}`),
    fetchJSON(`/api/projects/${projectId}/tickets/${ticketId}/comments`),
    fetchJSON(`/api/projects/${projectId}/tickets/${ticketId}/revisions`),
  ]);

  currentModalTicket = ticket;

  // Header
  document.getElementById('modal-ticket-id').textContent = `#${ticket.id.slice(0, 8)}`;
  const badge = document.getElementById('modal-column-badge');
  badge.textContent = ticket.column.replace(/_/g, ' ');
  badge.className = 'modal-column-badge ' + ticket.column;

  // Title + agent
  document.getElementById('modal-title').textContent = ticket.title;
  const agent = ticket.agentId ? (agents[ticket.agentId] || { name: '???' }) : null;
  document.getElementById('modal-agent').textContent = agent ? `\u{1f916} ${agent.name}` : '';

  // Description (monospace, preserves ASCII art)
  document.getElementById('modal-desc').textContent = ticket.description || '';

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
        <div class="modal-comment-body">${escapeHtml(c.body)}</div>
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

  // Show
  modal.classList.remove('hidden');
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

window.openModal = openModal;
window.closeModal = closeModal;
window.switchTab = switchTab;

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

window.openAgentsModal = openAgentsModal;
window.closeAgentsModal = closeAgentsModal;
window.copyApiKey = copyApiKey;

// ---------------------------------------------------------------------------
// Agent viewing indicator (shows which agents are reading a ticket)
// ---------------------------------------------------------------------------

function handleTicketViewed(data) {
  const { ticketId, agentId, agentName } = data.ticketViewed;
  console.log('[agentboard] ticketViewed event:', { ticketId: ticketId?.slice(0, 8), agentId, agentName });

  if (!ticketViewers.has(ticketId)) {
    ticketViewers.set(ticketId, new Map());
  }
  const viewers = ticketViewers.get(ticketId);

  // Clear existing timer for this agent on this ticket
  if (viewers.has(agentId)) {
    clearTimeout(viewers.get(agentId).timer);
  }

  // Auto-remove after VIEWING_DURATION
  const timer = setTimeout(() => {
    viewers.delete(agentId);
    if (viewers.size === 0) ticketViewers.delete(ticketId);
    renderViewingBadge(ticketId);
  }, VIEWING_DURATION);

  viewers.set(agentId, { name: agentName, timer });
  renderViewingBadge(ticketId);
}

function renderViewingBadge(ticketId) {
  const card = document.querySelector(`.ticket-card[data-ticket-id="${ticketId}"]`);
  if (!card) return;

  // Remove existing badges
  const existing = card.querySelector('.viewing-badges');
  if (existing) existing.remove();
  card.classList.remove('being-viewed');

  const viewers = ticketViewers.get(ticketId);
  if (!viewers || viewers.size === 0) return;

  card.classList.add('being-viewed');

  const container = document.createElement('div');
  container.className = 'viewing-badges';

  viewers.forEach(({ name }) => {
    const badge = document.createElement('div');
    badge.className = 'viewing-badge';
    badge.innerHTML = `<span class="viewing-dot"></span> ${escapeHtml(name)} <span class="viewing-label">reading</span>`;
    container.appendChild(badge);
  });

  card.insertBefore(container, card.firstChild);
}

function reapplyAllViewingBadges() {
  ticketViewers.forEach((_, ticketId) => {
    renderViewingBadge(ticketId);
  });
}

function clearAllViewingTimers() {
  ticketViewers.forEach(viewers => {
    viewers.forEach(({ timer }) => clearTimeout(timer));
  });
  ticketViewers.clear();
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
      subscribeGlobal(socket, '7', 'projectChanged', 'id name description createdAt');
      subscribeGlobal(socket, '9', 'auditAdded', 'id agentId method path statusCode requestBody timestamp');
      // Project-specific subscriptions only when viewing a project
      if (projectId) {
        subscribe(socket, '1', 'ticketCreated', projectId);
        subscribe(socket, '2', 'ticketUpdated', projectId);
        subscribe(socket, '3', 'ticketMoved', projectId);
        subscribe(socket, '4', 'activityAdded', projectId);
        subscribe(socket, '5', 'ticketDeleted', projectId);
        subscribe(socket, '8', 'ticketViewed', projectId);
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
    query = `subscription { ${eventName}(projectId: "${projectId}") { id agent { id name } ticketId action details timestamp } }`;
  } else if (eventName === 'ticketViewed') {
    query = `subscription { ${eventName}(projectId: "${projectId}") { ticketId projectId agentId agentName } }`;
  } else {
    query = `subscription { ${eventName}(projectId: "${projectId}") { id projectId title description column position agentId agent { id name } createdAt updatedAt } }`;
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

  // Project changed → reload overview if visible
  if (subId === '7') {
    if (!currentProjectId) loadProjectOverview();
    return;
  }

  // Audit event → prepend to audit log in realtime
  if (subId === '9') {
    if (data.auditAdded) prependAuditEntry(data.auditAdded);
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

  // Ticket viewed → show agent viewing indicator
  if (subId === '8') {
    handleTicketViewed(data);
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

  if (ws) { ws.close(); ws = null; }
  clearAllViewingTimers();

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
    await loadAgents();
    await loadProjectOverview(); // may auto-select if single project
  } catch (e) {
    console.error('[agentboard] Init failed:', e);
  }
  hideLoading();

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
