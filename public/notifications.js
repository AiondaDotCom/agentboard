// Global durable feed: independent of the currently selected project.
(() => {
  const panel = document.getElementById('notifications-panel');
  const toggle = document.getElementById('notifications-toggle');
  const list = document.getElementById('notification-list');
  const badge = document.getElementById('notification-count');
  const more = document.getElementById('notifications-more');
  const retry = document.getElementById('notifications-retry');
  const events = new Map();
  let lastRead = 0;
  let loading = false;
  let hasMore = false;
  let historyLoaded = false;
  let connected = false;
  try { lastRead = Number(localStorage.getItem('agentboard.notifications.read')) || 0; } catch { /* session only */ }
  const newest = () => [...events.keys()].reduce((max, id) => Math.max(max, id), 0);
  const visible = () => !panel.hidden && document.visibilityState === 'visible' && list.scrollTop < 30;
  function setConnected(value) {
    connected = value;
    const status = document.getElementById('notifications-status');
    status.dataset.i18n = connected ? 'All projects · live' : 'Reconnecting…';
    status.textContent = i18n.t(status.dataset.i18n);
  }
  function updateBadge() {
    const unread = Math.max(0, newest() - lastRead);
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = !unread;
    toggle.setAttribute('aria-label', unread ? i18n.t('{count} unread notifications', { count: unread }) : i18n.t('Notifications'));
  }
  function markRead() {
    lastRead = Math.max(lastRead, newest());
    try { localStorage.setItem('agentboard.notifications.read', String(lastRead)); } catch { /* session only */ }
    updateBadge();
    list.querySelectorAll('.notification-unread').forEach(el => el.classList.remove('notification-unread'));
  }
  function message(event) {
    const detail = event.kind === 'ticket_moved' ? i18n.t(event.detail) : event.detail;
    return i18n.t(`event.${event.kind}`, { ticket: event.ticketTitle, project: event.projectName, detail });
  }
  function render(newIds = new Set()) {
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    const sorted = [...events.values()].sort((a, b) => b.id - a.id);
    if (!sorted.length) {
      const empty = document.createElement('p');
      empty.className = 'notification-empty';
      empty.textContent = `${i18n.t('No events yet.')} ${i18n.t('New events will appear here automatically.')}`;
      list.append(empty);
    }
    for (const event of sorted) {
      const deleted = event.kind.endsWith('_deleted');
      const item = document.createElement(event.projectId && !deleted ? 'a' : 'div');
      item.className = 'notification-item';
      item.dataset.eventId = event.id;
      item.classList.toggle('notification-unread', event.id > lastRead);
      if (newIds.has(event.id)) item.classList.add('notification-new');
      if (item.tagName === 'A') {
        item.href = event.ticketId ? ticketPath(event.projectId, event.ticketId) : projectPath(event.projectId);
        item.addEventListener('click', async e => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          close();
          navigate(item.getAttribute('href'));
          await applyRoute();
        });
      }
      const title = document.createElement('div');
      title.className = 'notification-message';
      title.textContent = message(event);
      const meta = document.createElement('div');
      meta.className = 'notification-meta';
      const time = new Date(event.timestamp).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' });
      meta.textContent = [event.projectName, event.actorName || i18n.t('Human'), time].filter(Boolean).join(' · ');
      item.append(title, meta);
      list.append(item);
    }
    list.scrollTop = scrollTop;
    more.hidden = !hasMore;
    updateBadge();
  }
  function receive(event) {
    const id = Number(event.id);
    if (!Number.isSafeInteger(id) || events.has(id)) return;
    events.set(id, { ...event, id });
    render(new Set([id]));
    if (visible()) markRead();
    document.getElementById('notification-announcement').textContent = message(event);
  }
  async function load(older = false) {
    if (loading) return;
    loading = true;
    more.disabled = true;
    retry.hidden = true;
    try {
      const before = older && events.size ? Math.min(...events.keys()) : null;
      const response = await fetchJSON(`/api/notifications${before ? `?before=${before}` : ''}`);
      const ids = new Set();
      for (const event of response) {
        const id = Number(event.id);
        if (!events.has(id)) ids.add(id);
        events.set(id, { ...event, id });
      }
      if (older || !historyLoaded) hasMore = response.length === 100;
      historyLoaded = true;
      render(panel.hidden ? new Set() : ids);
      if (visible()) markRead();
    } catch {
      retry.hidden = false;
    } finally {
      loading = false;
      more.disabled = false;
    }
  }
  function position() {
    const top = Math.min(document.querySelector('header').getBoundingClientRect().bottom + 8, innerHeight - 150);
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.min(640, innerHeight - top - 12)}px`;
  }
  function close() {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }
  toggle.addEventListener('click', () => {
    if (!panel.hidden) { close(); return; }
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    position();
    list.scrollTop = 0;
    markRead();
    load();
    document.getElementById('notifications-close').focus();
  });
  document.getElementById('notifications-close').addEventListener('click', () => { close(); toggle.focus(); });
  document.getElementById('notifications-read').addEventListener('click', markRead);
  more.addEventListener('click', () => load(true));
  retry.addEventListener('click', () => load());
  list.addEventListener('scroll', () => { if (visible()) markRead(); });
  document.addEventListener('click', e => { if (!panel.contains(e.target) && !toggle.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { close(); toggle.focus(); } });
  document.addEventListener('visibilitychange', () => { if (visible()) markRead(); });
  window.addEventListener('resize', position);
  window.addEventListener('app-languagechange', () => { render(); position(); });
  window.addEventListener('storage', e => {
    if (e.key === 'agentboard.notifications.read') { lastRead = Number(e.newValue) || 0; render(); }
  });
  window.boardNotifications = { receive, load, setConnected };
  setConnected(false);
  render();
})();
