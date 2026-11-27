// Simplified BPMN diagrams of the business process a ticket describes (#be30299e).
// Agents send lanes/nodes/flows; this file lays them out and draws SVG.
// Every step (S…) and flow (F…) carries a sub-ID the user can copy and quote to an AI.
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const tr = (key) => window.i18n.t(key);
  const el = (tag, text, className) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (className) e.className = className;
    return e;
  };
  const svg = (tag, attrs = {}, text) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const endpoint = (t) =>
    `/api/projects/${encodeURIComponent(t.projectId)}/tickets/${encodeURIComponent(t.id)}/process-diagrams`;

  // Geometry
  const LANE_HEAD = 30, COL = 184, ROW = 120, PAD = 16;
  const TASK_W = 128, TASK_H = 60, GATE = 26, EVENT = 16;

  function wrap(text, max, lines) {
    const words = text.split(/\s+/);
    const out = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > max && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
    if (out.length > lines) {
      out.length = lines;
      out[lines - 1] = out[lines - 1].replace(/.{0,1}$/, '…');
    }
    return out.map((l) => (l.length > max + 2 ? l.slice(0, max) + '…' : l));
  }

  function textBlock(lines, x, y, className, lineHeight = 15) {
    const t = svg('text', { x, y: y - ((lines.length - 1) * lineHeight) / 2, class: className, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    lines.forEach((line, i) => t.append(svg('tspan', { x, dy: i ? lineHeight : 0 }, line)));
    return t;
  }

  /** Columns from the longest forward path; back edges (loops) are ignored for ranking. */
  function layout(d) {
    const out = new Map(d.nodes.map((n) => [n.id, []]));
    for (const f of d.flows) out.get(f.from).push(f);
    const back = new Set(), state = new Map();
    const visit = (id) => {
      state.set(id, 1);
      for (const f of out.get(id)) {
        if (state.get(f.to) === 1) back.add(f);
        else if (!state.has(f.to)) visit(f.to);
      }
      state.set(id, 2);
    };
    d.nodes.filter((n) => n.type === 'start').forEach((n) => visit(n.id));
    d.nodes.forEach((n) => { if (!state.has(n.id)) visit(n.id); });
    const rank = new Map(d.nodes.map((n) => [n.id, 0]));
    const forward = d.flows.filter((f) => !back.has(f));
    for (let i = 0; i < d.nodes.length; i++)
      for (const f of forward) rank.set(f.to, Math.max(rank.get(f.to), rank.get(f.from) + 1));
    // Several triggers: a start that joins the process later sits directly before
    // its first step instead of at the far left with a long arrow across.
    for (const n of d.nodes) {
      if (n.type !== 'start') continue;
      const next = out.get(n.id).map((f) => rank.get(f.to));
      rank.set(n.id, Math.max(0, Math.min(...next) - 1));
    }
    // Stack nodes that share lane and column into sub-rows
    const slots = new Map(), sub = new Map(), laneRows = new Map(d.lanes.map((l) => [l.id, 1]));
    for (const n of d.nodes) {
      const key = `${n.lane}|${rank.get(n.id)}`;
      const s = slots.get(key) ?? 0;
      slots.set(key, s + 1);
      sub.set(n.id, s);
      laneRows.set(n.lane, Math.max(laneRows.get(n.lane), s + 1));
    }
    let y = 0;
    const laneTop = new Map();
    for (const l of d.lanes) {
      laneTop.set(l.id, y);
      y += laneRows.get(l.id) * ROW;
    }
    const pos = new Map(d.nodes.map((n) => [n.id, {
      x: LANE_HEAD + PAD + rank.get(n.id) * COL + COL / 2,
      y: laneTop.get(n.lane) + sub.get(n.id) * ROW + ROW / 2,
      rank: rank.get(n.id),
    }]));
    const columns = Math.max(...rank.values()) + 1;
    return { pos, back, laneTop, laneRows, width: LANE_HEAD + PAD * 2 + columns * COL, height: y };
  }

  const halfWidth = (n) => (n.type === 'task' ? TASK_W / 2 : n.type === 'decision' ? GATE : EVENT);
  const halfHeight = (n) => (n.type === 'task' ? TASK_H / 2 : n.type === 'decision' ? GATE : EVENT);

  function draw(d, onSelect) {
    const g = layout(d);
    const byId = new Map(d.nodes.map((n) => [n.id, n]));
    const root = svg('svg', { class: 'pd-svg', width: g.width, height: g.height + 1, viewBox: `0 0 ${g.width} ${g.height + 1}`, role: 'group', 'aria-label': d.title });
    const defs = svg('defs');
    const marker = svg('marker', { id: `pd-arrow-${d.id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M0,0 L10,5 L0,10 z', class: 'pd-arrowhead' }));
    defs.append(marker);
    root.append(defs);
    // Lanes
    for (const l of d.lanes) {
      const top = g.laneTop.get(l.id), h = g.laneRows.get(l.id) * ROW;
      root.append(svg('rect', { x: 0.5, y: top + 0.5, width: g.width - 1, height: h, class: 'pd-lane' }));
      root.append(svg('rect', { x: 0.5, y: top + 0.5, width: LANE_HEAD, height: h, class: 'pd-lane-head' }));
      // BPMN-style: lane name runs vertically in a narrow header
      const name = textBlock(wrap(l.name, Math.max(8, Math.floor(h / 8)), 1), 0, 0, 'pd-lane-name');
      name.setAttribute('transform', `translate(${LANE_HEAD / 2 + 1},${top + h / 2}) rotate(-90)`);
      for (const span of name.children) span.setAttribute('x', 0);
      name.setAttribute('x', 0);
      root.append(name);
    }
    const items = [];
    const channels = new Map(), gaps = new Map();
    // Flows first so nodes paint over line ends
    for (const f of d.flows) {
      const a = byId.get(f.from), b = byId.get(f.to);
      const p = g.pos.get(f.from), q = g.pos.get(f.to);
      // Routing rule: horizontal runs only in the free band at the bottom of a row,
      // vertical runs only in the gaps between columns. Only same-row neighbours
      // connect directly. So no line ever passes through a shape it does not belong to.
      const boundary = (rank) => LANE_HEAD + PAD + rank * COL;
      const next = (map, key) => { const n = map.get(key) ?? 0; map.set(key, n + 1); return n % 4; };
      const tx = q.x - halfWidth(b);
      let path, lx, ly, anchor = 'start';
      if (q.rank === p.rank + 1 && Math.abs(p.y - q.y) < 1) {
        path = `M${p.x + halfWidth(a)},${p.y} H${tx}`;
        lx = (p.x + halfWidth(a) + tx) / 2;
        ly = a.type === 'decision' ? p.y + 16 : p.y - 6;
        anchor = 'middle';
      } else {
        let head, y0;
        if (a.type === 'decision' && Math.abs(p.y - q.y) >= 1) {
          // Gateways branch from top (target above) or bottom (target below)
          const up = q.y < p.y;
          y0 = up ? p.y - GATE - 10 : p.y + GATE + 10;
          head = `M${p.x},${up ? p.y - GATE : p.y + GATE} V${y0}`;
          lx = p.x + 6;
          ly = up ? y0 - 5 : y0 + 13;
        } else {
          y0 = p.y;
          head = `M${p.x + halfWidth(a)},${p.y}`;
          lx = p.x + halfWidth(a) + 4;
          // Below the line: above it sit the sub-ID badges of events and gateways
          ly = p.y + 13;
        }
        // Each column gap is split: outgoing lines use its left half, incoming its right
        // half, so an arrow into a node never lines up with a neighbour's exit stub.
        const xs = boundary(p.rank + 1) - 8 - next(gaps, `out${p.rank}`) * 5;
        if (q.rank === p.rank + 1) {
          const x2 = boundary(q.rank) + 8 + next(gaps, `in${q.rank}`) * 5;
          path = `${head} H${x2} V${q.y} H${tx}`;
        } else {
          const band = p.y + ROW / 2 - 9 - next(channels, `${p.y}`) * 5;
          const x2 = boundary(q.rank) + 8 + next(gaps, `in${q.rank}`) * 5;
          path = `${head} H${xs} V${band} H${x2} V${q.y} H${tx}`;
        }
      }
      const group = svg('g', { class: 'pd-flow', tabindex: 0, role: 'button', 'data-ref': f.ref ?? '' });
      group.append(svg('path', { d: path, class: 'pd-hit' }));
      group.append(svg('path', { d: path, class: 'pd-line', 'marker-end': `url(#pd-arrow-${d.id})` }));
      const caption = [f.ref, f.label].filter(Boolean).join(' · ');
      if (caption) {
        // One short line; the full condition is in the detail bar and the step list
        const t = svg('text', { x: lx, y: ly, class: 'pd-flow-label', 'text-anchor': anchor }, wrap(caption, anchor === 'middle' ? 18 : 14, 1)[0]);
        group.append(t);
      }
      group.setAttribute('aria-label', `${f.ref ?? ''} ${a.label} → ${b.label}${f.label ? ` (${f.label})` : ''}`);
      items.push({ kind: 'flow', item: f, group });
      root.append(group);
    }
    for (const n of d.nodes) {
      const { x, y } = g.pos.get(n.id);
      const group = svg('g', { class: `pd-node pd-${n.type}`, tabindex: 0, role: 'button', 'data-ref': n.ref ?? '', 'aria-label': `${n.ref ?? ''} ${n.label}` });
      if (n.type === 'task') {
        group.append(svg('rect', { x: x - TASK_W / 2, y: y - TASK_H / 2, width: TASK_W, height: TASK_H, rx: 10, class: 'pd-shape' }));
        group.append(textBlock(wrap(n.label, 18, 3), x, y + 2, 'pd-label'));
      } else if (n.type === 'decision') {
        group.append(svg('path', { d: `M${x},${y - GATE} L${x + GATE},${y} L${x},${y + GATE} L${x - GATE},${y} z`, class: 'pd-shape' }));
        group.append(svg('path', { d: `M${x - 9},${y - 9} L${x + 9},${y + 9} M${x + 9},${y - 9} L${x - 9},${y + 9}`, class: 'pd-gate-x' }));
        const text = textBlock(wrap(n.label, 14, 3), x - GATE - 4, y - GATE + 2, 'pd-label pd-outside');
        // Upper left of the gateway, bottom line just above the incoming arrow
        text.setAttribute('text-anchor', 'end');
        text.setAttribute('y', String(y - GATE + 2 - (text.children.length - 1) * 15));
        group.append(text);
      } else {
        group.append(svg('circle', { cx: x, cy: y, r: EVENT, class: 'pd-shape' }));
        group.append(textBlock(wrap(n.label, 20, 2), x, y + EVENT + 16, 'pd-label pd-outside'));
      }
      if (n.ref) {
        // Task: inside the top-left corner. Gateway/event: right of the shape, clear of incoming arrows.
        const w = 8 + n.ref.length * 7;
        const bx = n.type === 'task' ? x - TASK_W / 2 + 4 : x + halfWidth(n) - 2;
        const by = n.type === 'task' ? y - TASK_H / 2 + 4 : y - halfHeight(n) - 6;
        group.append(svg('rect', { x: bx, y: by, width: w, height: 15, rx: 4, class: 'pd-ref-bg' }));
        group.append(svg('text', { x: bx + w / 2, y: by + 8, class: 'pd-ref', 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, n.ref));
      }
      items.push({ kind: 'node', item: n, group });
      root.append(group);
    }
    for (const entry of items) {
      const choose = () => onSelect(entry);
      entry.group.addEventListener('click', choose);
      entry.group.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose();
        }
      });
    }
    return { root, items };
  }

  function copyButton(text, label = 'Copy ID') {
    const b = el('button', tr(label), 'draft-action pd-copy');
    b.type = 'button';
    b.onclick = async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text());
        b.textContent = tr('Copied');
      } catch {
        b.textContent = tr('Copy failed');
      }
      setTimeout(() => { b.textContent = tr(label); }, 1600);
    };
    return b;
  }

  function diagramCard(versions, target) {
    const card = el('section', undefined, 'pd-card');
    let current = versions[0];
    const header = el('div', undefined, 'pd-header');
    const title = el('h3', current.title, 'pd-title');
    const idCode = el('code', '', 'pd-id');
    const reference = () => `${tr('Process')} ${current.id} v${current.version} („${current.title}“)`;
    header.append(title, idCode);
    if (versions.length > 1) {
      const picker = el('select', undefined, 'pd-version');
      picker.setAttribute('aria-label', tr('Version'));
      for (const v of versions) {
        const o = el('option', `v${v.version}`);
        o.value = String(v.version);
        picker.append(o);
      }
      picker.onchange = () => {
        current = versions.find((v) => String(v.version) === picker.value);
        show();
      };
      header.append(picker);
    }
    header.append(copyButton(reference));
    // "Show large" moves the card into a modal <dialog> (top layer, whole window) and back
    const expand = el('button', tr('Show large'), 'draft-action');
    expand.type = 'button';
    const dialog = el('dialog', undefined, 'pd-dialog');
    dialog.setAttribute('aria-label', current.title);
    const home = document.createComment('process-diagram');
    dialog.addEventListener('close', () => {
      home.replaceWith(card);
      dialog.remove();
      expand.textContent = tr('Show large');
      expand.focus();
    });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    expand.onclick = () => {
      if (dialog.open) {
        dialog.close();
        return;
      }
      card.replaceWith(home);
      dialog.append(card);
      document.body.append(dialog);
      dialog.showModal();
      expand.textContent = tr('Show small');
    };
    header.append(expand);
    const remove = el('button', tr('Remove'), 'draft-action');
    remove.type = 'button';
    remove.onclick = async () => {
      if (!confirm(`${tr('Remove this process diagram with all versions?')}\n„${current.title}“`)) return;
      remove.disabled = true;
      try {
        const response = await fetch(`${endpoint(target)}/${encodeURIComponent(current.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!response.ok) throw new Error(`${tr('Remove failed')} (${response.status})`);
        if (dialog.open) dialog.close();
        await render(card.closest('.pd-root') ?? card.parentElement, target);
      } catch (e) {
        remove.disabled = false;
        alert(e.message);
      }
    };
    header.append(remove);
    const stage = el('div', undefined, 'pd-stage');
    const detail = el('div', undefined, 'pd-detail');
    const steps = el('details', undefined, 'pd-steps');
    card.append(header, stage, detail, steps);

    function describe(entry) {
      const byId = new Map(current.nodes.map((n) => [n.id, n]));
      const lane = (n) => current.lanes.find((l) => l.id === n.lane)?.name ?? n.lane;
      if (entry.kind === 'node') {
        const n = entry.item;
        return { ref: n.ref, text: `${n.label} · ${tr('Lane')} ${lane(n)}`, quote: `${reference()}, ${tr('Step')} ${n.ref} „${n.label}“ (${lane(n)})` };
      }
      const f = entry.item, a = byId.get(f.from), b = byId.get(f.to);
      const what = `${a.ref} „${a.label}“ → ${b.ref} „${b.label}“${f.label ? ` [${f.label}]` : ''}`;
      return { ref: f.ref, text: what, quote: `${reference()}, ${tr('Flow')} ${f.ref}: ${what}` };
    }

    function select(entry, items) {
      for (const it of items) it.group.classList.toggle('pd-selected', it === entry);
      const info = describe(entry);
      detail.replaceChildren(el('code', info.ref, 'pd-id'), el('span', info.text, 'pd-detail-text'), copyButton(() => info.quote));
      detail.classList.add('pd-detail-active');
    }

    function show() {
      idCode.textContent = `${current.id} · v${current.version}`;
      idCode.title = reference();
      const { root, items } = draw(current, (entry) => select(entry, items));
      stage.replaceChildren(root);
      detail.classList.remove('pd-detail-active');
      detail.replaceChildren(el('span', tr('Click a step or arrow to copy its sub-ID.'), 'draft-caption'));
      // Text list: readable on small screens and for screen readers
      steps.replaceChildren(el('summary', `${tr('Steps and flows')} (${items.length})`));
      const table = el('div', undefined, 'pd-list');
      for (const entry of items.sort((x, y) => (x.kind === y.kind ? Number(x.item.ref?.slice(1)) - Number(y.item.ref?.slice(1)) : x.kind === 'node' ? -1 : 1))) {
        const info = describe(entry);
        const row = el('div', undefined, 'pd-row');
        row.append(el('code', info.ref, 'pd-id'), el('span', info.text), copyButton(() => info.quote));
        row.addEventListener('mouseenter', () => entry.group.classList.add('pd-hover'));
        row.addEventListener('mouseleave', () => entry.group.classList.remove('pd-hover'));
        table.append(row);
      }
      steps.append(table);
    }
    show();
    return card;
  }

  async function render(root, target) {
    const request = Symbol();
    root._pdRequest = request;
    try {
      const response = await fetch(endpoint(target));
      if (!response.ok) throw new Error(`${tr('Unable to load process diagrams')} (${response.status})`);
      const all = await response.json();
      if (root._pdRequest !== request) return;
      const groups = new Map();
      for (const v of all) groups.set(v.id, [...(groups.get(v.id) ?? []), v]);
      root.dispatchEvent(new CustomEvent('process-count', { detail: groups.size }));
      root.replaceChildren();
      // Oldest diagram first, so the order stays put when a new one is added
      const first = (versions) => versions.reduce((min, v) => (v.createdAt < min ? v.createdAt : min), versions[0].createdAt);
      for (const versions of [...groups.values()].sort((a, b) => first(a).localeCompare(first(b))))
        root.append(diagramCard(versions.sort((a, b) => b.version - a.version), target));
    } catch (e) {
      if (root._pdRequest !== request) return;
      root.dispatchEvent(new CustomEvent('process-count', { detail: -1 }));
      root.replaceChildren(el('p', e.message, 'draft-error'));
    }
  }

  window.processDiagrams = { render, layout };
})();
