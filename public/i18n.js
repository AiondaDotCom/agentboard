// UI text only: project names, tickets, comments and custom column names stay untouched.
(() => {
  const messages = {
  "en": {
    "event.ticket_created": "Ticket “{ticket}” was created.",
    "event.ticket_updated": "Ticket “{ticket}” was updated.",
    "event.ticket_moved": "Ticket “{ticket}” was moved to {detail}.",
    "event.comment_added": "Comment added to ticket “{ticket}”.",
    "event.ticket_assigned": "Ticket “{ticket}” was assigned to {detail}.",
    "event.ticket_unassigned": "Assignment removed from ticket “{ticket}”.",
    "event.ticket_deleted": "Ticket “{ticket}” was deleted.",
    "event.ticket_transferred": "Ticket “{ticket}” moved from {detail} to {project}.",
    "event.project_created": "Project “{project}” was created.",
    "event.project_updated": "Project “{project}” was updated.",
    "event.project_deleted": "Project “{project}” was deleted.",
    "event.agent_created": "Agent “{detail}” was registered.",
    "event.agent_deleted": "Agent “{detail}” was removed."
  },
  "de": {
    "Language": "Sprache",
    "Settings": "Einstellungen",
    "Continue": "Weiter",
    "Choose your language": "Sprache auswählen",
    "Back to project overview": "Zur Projektübersicht",
    "Columns": "Spalten",
    "Configure the board columns of this project": "Spalten dieses Projekts konfigurieren",
    "Show registered agents & API keys": "Registrierte Agenten und API-Schlüssel anzeigen",
    "Sign out": "Abmelden",
    "Connecting...": "Verbindung wird hergestellt…",
    "Waiting for agents and projects": "Warte auf Agenten und Projekte",
    "Project": "Projekt",
    "Total": "Gesamt",
    "No projects yet. An AI agent will create one via the API.": "Noch keine Projekte. Ein KI-Agent kann über die API eines erstellen.",
    "ACTIVITY FEED": "AKTIVITÄTEN",
    "AUDIT LOG": "AUDIT-PROTOKOLL",
    "Show": "Anzeigen",
    "Hide": "Ausblenden",
    "Close dialog": "Dialog schließen",
    "Description": "Beschreibung",
    "Comments": "Kommentare",
    "History": "Verlauf",
    "Details": "Details",
    "Move this ticket to another project": "Dieses Ticket in ein anderes Projekt verschieben",
    "Status": "Status",
    "Priority": "Priorität",
    "Work type": "Arbeitsart",
    "Assignee": "Zuständig",
    "Author": "Autor",
    "Group": "Gruppe",
    "Updated": "Aktualisiert",
    "Board Columns": "Board-Spalten",
    "+ Add column": "+ Spalte hinzufügen",
    "Cancel": "Abbrechen",
    "Save": "Speichern",
    "Registered Agents": "Registrierte Agenten",
    "Configure the columns of this board. The first column is where new tickets land, the last column counts as finished. Columns that still contain tickets cannot be removed.": "Konfiguriere die Spalten dieses Boards. Neue Tickets landen in der ersten Spalte; die letzte gilt als abgeschlossen. Spalten mit Tickets können nicht entfernt werden.",
    "Copy an API key and share it with the agent so it can authenticate via X-Api-Key header.": "Kopiere einen API-Schlüssel für den Agenten. Er authentifiziert sich damit über den X-Api-Key-Header.",
    "Sign in": "Anmelden",
    "Enter your admin key to access the board": "Gib deinen Admin-Schlüssel ein, um das Board zu öffnen.",
    "Admin Key": "Admin-Schlüssel",
    "User": "Benutzer",
    "Signing in...": "Anmeldung läuft…",
    "Invalid key": "Ungültiger Schlüssel",
    "Invalid admin key": "Ungültiger Admin-Schlüssel",
    "Connection failed": "Verbindung fehlgeschlagen",
    "Backlog": "Backlog",
    "Ready": "Bereit",
    "Blocked": "Blockiert",
    "In Progress": "In Arbeit",
    "Rework": "Nacharbeit",
    "In Review": "In Prüfung",
    "Done": "Erledigt",
    "Critical": "Kritisch",
    "High": "Hoch",
    "Medium": "Mittel",
    "Low": "Niedrig",
    "Mechanical": "Mechanisch",
    "Judgment": "Abwägung",
    "Solution shape is known, diff is checkable against a hard done-criterion": "Lösungsweg bekannt, Änderung anhand eines klaren Abschlusskriteriums prüfbar",
    "Design, root-cause analysis, weighing trade-offs": "Entwurf, Ursachenanalyse und Abwägung von Alternativen",
    "Click to copy full ID": "Klicken, um die vollständige ID zu kopieren",
    "Ticket group – one agent works on all of these": "Ticketgruppe – ein Agent bearbeitet alle Tickets",
    "free": "frei",
    "Loading more…": "Weitere werden geladen…",
    "Blocked reason": "Grund der Blockierung",
    "Assigned to": "Zugewiesen an",
    "Last touched": "Zuletzt geändert",
    "Human": "Mensch",
    "unknown": "unbekannt",
    "system": "System",
    "Unassigned": "Nicht zugewiesen",
    "Depends on:": "Abhängig von:",
    "not found": "nicht gefunden",
    "No comments yet.": "Noch keine Kommentare.",
    "No changes recorded yet.": "Noch keine Änderungen erfasst.",
    "(empty)": "(leer)",
    "Column name": "Spaltenname",
    "Move up": "Nach oben",
    "Move down": "Nach unten",
    "Remove column": "Spalte entfernen",
    "Loading...": "Wird geladen…",
    "No agents registered yet.": "Noch keine Agenten registriert.",
    "Failed to load agents.": "Agenten konnten nicht geladen werden.",
    "Copy": "Kopieren",
    "Copied!": "Kopiert!",
    "Created": "Erstellt",
    "Back": "Zurück",
    "scanning": "sichtet",
    "reading": "liest",
    "creating": "erstellt",
    "editing": "bearbeitet",
    "moving": "verschiebt",
    "assigning": "weist zu",
    "unassigning": "hebt Zuweisung auf",
    "commenting": "kommentiert",
    "deleting": "löscht",
    "accessing": "greift zu",
    "AI status offline": "KI-Status offline",
    "Runtime status API is unavailable": "Die KI-Status-API ist nicht erreichbar",
    "No current runtime heartbeat from cortex": "Kein aktuelles Statussignal von cortex",
    "No current runtime heartbeat": "Kein aktuelles Statussignal",
    "0 AIs working": "0 KIs arbeiten",
    "{count} agents": "{count} Agenten",
    "{count} agent": "{count} Agent",
    "{count} events": "{count} Ereignisse",
    "{count} comments": "{count} Kommentare",
    "{count} comment": "{count} Kommentar",
    "{count} AIs working since {duration}": "{count} KIs arbeiten seit {duration}",
    "{count} AI working since {duration}": "{count} KI arbeitet seit {duration}",
    "{count} idle": "{count} inaktiv",
    "Working non-stop since {date}": "Durchgehend aktiv seit {date}",
    "Move ticket “{ticket}” to project “{project}”?": "Ticket „{ticket}“ in das Projekt „{project}“ verschieben?",
    " Its dependencies will be removed.": " Seine Abhängigkeiten werden entfernt.",
    "Depends on {count} tickets ({open} unfinished) – click to show arrows": "Abhängig von {count} Tickets ({open} offen) – klicken, um Pfeile anzuzeigen",
    "Notifications": "Benachrichtigungen",
    "All projects · live": "Alle Projekte · live",
    "No events yet.": "Noch keine Ereignisse.",
    "New events will appear here automatically.": "Neue Ereignisse erscheinen hier automatisch.",
    "Load older events": "Ältere Ereignisse laden",
    "Could not load events. Retry": "Ereignisse konnten nicht geladen werden. Erneut versuchen",
    "{count} unread notifications": "{count} ungelesene Benachrichtigungen",
    "Mark all as read": "Alle als gelesen markieren",
    "Deleted item": "Gelöschter Eintrag",
    "column": "Spalte",
    "title": "Titel",
    "description": "Beschreibung",
    "group": "Gruppe",
    "priority": "Priorität",
    "work_type": "Arbeitsart",
    "assignee_id": "Zuständig",
    "blocked_reason": "Blockierungsgrund",
    "depends_on": "Abhängigkeiten",
    "position": "Position",
    "event.ticket_created": "Ticket „{ticket}“ wurde erstellt.",
    "event.ticket_updated": "Ticket „{ticket}“ wurde aktualisiert.",
    "event.ticket_moved": "Ticket „{ticket}“ wurde nach „{detail}“ verschoben.",
    "event.comment_added": "Kommentar zu Ticket „{ticket}“ hinzugefügt.",
    "event.ticket_assigned": "Ticket „{ticket}“ wurde {detail} zugewiesen.",
    "event.ticket_unassigned": "Zuweisung von Ticket „{ticket}“ aufgehoben.",
    "event.ticket_deleted": "Ticket „{ticket}“ wurde gelöscht.",
    "event.ticket_transferred": "Ticket „{ticket}“ wurde von „{detail}“ nach „{project}“ verschoben.",
    "event.project_created": "Projekt „{project}“ wurde erstellt.",
    "event.project_updated": "Projekt „{project}“ wurde aktualisiert.",
    "event.project_deleted": "Projekt „{project}“ wurde gelöscht.",
    "event.agent_created": "Agent „{detail}“ wurde registriert.",
    "event.agent_deleted": "Agent „{detail}“ wurde entfernt.",
    "⚙ Columns": "⚙ Spalten",
    "Close": "Abschließen",
    "Reopen": "Wieder öffnen",
    "Updated ticket": "Ticket aktualisiert",
    "Unassigned ticket": "Zuweisung aufgehoben",
    "Read comments": "Kommentare gelesen",
    "Read ticket history": "Ticketverlauf gelesen",
    "Comment: {body}": "Kommentar: {body}",
    "Created ticket “{title}”": "Ticket „{title}“ erstellt",
    "Read ticket “{title}”": "Ticket „{title}“ gelesen",
    "Moved to {column}": "Nach „{column}“ verschoben",
    "Assigned to {name}": "Zugewiesen an {name}",
    "{count} tickets listed": "{count} Tickets aufgelistet",
    "Project read": "Projekt gelesen",
    "Ticket moved": "Ticket verschoben",
    "{count} working": "{count} aktiv",
    "Both columns need a title": "Beide Spalten benötigen einen Namen",
    "working": "aktiv",
    "Reconnecting…": "Verbindung wird wiederhergestellt…",
    "workType": "Arbeitsart",
    "assigneeId": "Zuständig",
    "blockedReason": "Blockierungsgrund",
    "dependsOn": "Abhängigkeiten"
  }
};
  let saved;
  try { saved = localStorage.getItem('agentboard.language'); } catch { /* Private browsing */ }
  let language = ['en', 'de'].includes(saved) ? saved : (navigator.language.startsWith('de') ? 'de' : 'en');
  const t = (key, values = {}) => (messages[language][key] || messages.en[key] || key)
    .replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
  function apply(root = document) {
    document.documentElement.lang = language;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    for (const attr of ['title', 'aria-label', 'placeholder']) {
      root.querySelectorAll(`[data-i18n-${attr}]`).forEach(el => el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`))));
    }
    root.querySelectorAll('[data-language-select]').forEach(el => { el.value = language; });
  }
  function setLanguage(value) {
    if (!['en', 'de'].includes(value)) return;
    language = value;
    saved = value;
    try { localStorage.setItem('agentboard.language', value); } catch { /* Still works for this session */ }
    apply();
    window.dispatchEvent(new Event('app-languagechange'));
  }
  window.i18n = { t, apply, setLanguage, get language() { return language; } };
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelectorAll('[data-language-select]').forEach(el => el.addEventListener('change', () => setLanguage(el.value)));
    const settings = document.getElementById('settings-dialog');
    const settingsToggle = document.getElementById('settings-toggle');
    settingsToggle?.addEventListener('click', () => {
      settings.showModal();
      settingsToggle.setAttribute('aria-expanded', 'true');
    });
    document.getElementById('settings-close')?.addEventListener('click', () => settings.close());
    settings?.addEventListener('close', () => settingsToggle.setAttribute('aria-expanded', 'false'));
    settings?.addEventListener('click', event => {
      if (event.target !== settings) return;
      const rect = settings.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) settings.close();
    });
    const welcome = document.getElementById('language-welcome');
    if (welcome && !saved) welcome.showModal();
    document.getElementById('language-continue')?.addEventListener('click', () => { setLanguage(language); welcome.close(); });
    document.getElementById('login-form')?.addEventListener('submit', () => setLanguage(language));
  });
})();
