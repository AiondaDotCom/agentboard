(() => {
  const tr = (key) => window.i18n.t(key);
  const element = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const endpoint = (target) =>
    `/api/projects/${encodeURIComponent(target.projectId)}/tickets/${encodeURIComponent(target.id)}/drafts`;
  const versionPath = (target, draft) =>
    `${endpoint(target)}/${encodeURIComponent(draft.id)}/versions/${draft.version}`;
  async function json(url, options) {
    const response = await fetch(url, options);
    if (!response.ok)
      throw new Error(`${tr('Unable to load preview')} (${response.status})`);
    return response.json();
  }
  function field(label, control) {
    const item = element('label', tr(label));
    item.append(control);
    return item;
  }
  function select(options, value) {
    const input = element('select');
    for (const [key, title] of options) {
      const option = element('option', title);
      option.value = key;
      input.append(option);
    }
    input.value = String(value);
    return input;
  }
  async function render(root, target, initial = {}) {
    const request = Symbol();
    root._draftRequest = request;
    const old = root._draftState;
    const state =
      old?.ticket === target.id
        ? old
        : {
            ticket: target.id,
            selected: null,
            width: initial.width || 390,
            height: initial.height || 1100,
            theme: initial.theme || 'light',
          };
    root._draftState = state;
    try {
      const drafts = await json(endpoint(target));
      if (root._draftRequest !== request) return;
      root.dispatchEvent(
        new CustomEvent('drafts-count', { detail: drafts.length }),
      );
      root.replaceChildren();
      if (!drafts.length) {
        root.append(
          element(
            'p',
            tr(
              'No drafts yet. An AI agent can attach an HTML mockup to this ticket.',
            ),
            'draft-caption',
          ),
        );
        return;
      }
      const controls = element('div', undefined, 'draft-controls');
      const key = (draft) => `${draft.id}:${draft.version}`;
      const requested =
        initial.draft && initial.version
          ? `${initial.draft}:${initial.version}`
          : null;
      const chosen = state.selected || requested || key(drafts[0]);
      const picker = select(
        drafts.map((d) => [key(d), `${d.title} · v${d.version} · ${d.id}`]),
        drafts.some((d) => key(d) === chosen) ? chosen : key(drafts[0]),
      );
      const pickerLabel = field('Screen and version', picker);
      pickerLabel.className = 'draft-picker';
      controls.append(pickerLabel);
      const width = select(
        [
          ['390', tr('Mobile') + ' · 390 px'],
          ['768', tr('Tablet') + ' · 768 px'],
          ['1280', tr('Desktop') + ' · 1280 px'],
        ],
        state.width,
      );
      const theme = select(
        [
          ['light', tr('Light')],
          ['dark', tr('Dark')],
        ],
        state.theme,
      );
      const height = element('input');
      height.type = 'number';
      height.min = '200';
      height.max = '12000';
      height.step = '100';
      height.value = state.height;
      controls.append(
        field('Viewport', width),
        field('Appearance', theme),
        field('Preview height', height),
      );
      const refresh = element('button', tr('Reload drafts'), 'draft-action');
      refresh.type = 'button';
      refresh.onclick = () => render(root, target);
      controls.append(refresh);
      root.append(controls);
      const content = element('div');
      root.append(content);
      function show() {
        state.selected = picker.value;
        state.width = Number(width.value);
        state.height = Math.max(
          200,
          Math.min(12000, Number(height.value) || 1100),
        );
        state.theme = theme.value;
        const draft = drafts.find((d) => key(d) === picker.value);
        if (!draft) return;
        content.replaceChildren();
        // Visible ID so the user can tell an AI exactly which draft fits
        const reference = `${tr('Draft')} ${draft.id} v${draft.version} („${draft.title}“)`;
        const idRow = element('div', undefined, 'draft-id');
        const idCode = element('code', `${draft.id} · v${draft.version}`);
        idCode.title = reference;
        const copy = element('button', tr('Copy ID'), 'draft-action');
        copy.type = 'button';
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(reference);
            copy.textContent = tr('Copied');
          } catch {
            copy.textContent = tr('Copy failed');
          }
          setTimeout(() => { copy.textContent = tr('Copy ID'); }, 1600);
        };
        idRow.append(element('span', tr('Draft ID'), 'draft-caption'), idCode, copy);
        content.append(idRow);
        const status = element('div', undefined, 'draft-state');
        const labels = {
          pending: 'Visual review pending',
          passed: 'Visually checked by AI',
          needs_changes: 'Changes needed',
        };
        status.append(
          element(
            'span',
            tr(labels[draft.reviewStatus]),
            `draft-badge ${draft.reviewStatus}`,
          ),
        );
        status.append(
          element(
            'span',
            tr(
              draft.approvedAt
                ? 'Approved by user'
                : 'Not yet approved by user',
            ),
            'draft-caption',
          ),
        );
        const url = new URL(draft.previewPath, location.origin);
        url.searchParams.set('width', state.width);
        url.searchParams.set('height', state.height);
        url.searchParams.set('theme', state.theme);
        const open = element('a', tr('Open full preview'), 'draft-action');
        open.href = url.pathname + url.search;
        open.target = '_blank';
        open.rel = 'noopener';
        status.append(open);
        const latest = Math.max(
          ...drafts.filter((d) => d.id === draft.id).map((d) => d.version),
        );
        if (draft.version === latest && !draft.approvedAt) {
          const approve = element(
            'button',
            tr('Approve this version'),
            'draft-action',
          );
          approve.type = 'button';
          approve.onclick = async () => {
            approve.disabled = true;
            try {
              await json(versionPath(target, draft) + '/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
              });
              await render(root, target);
            } catch (e) {
              approve.disabled = false;
              content.append(element('p', e.message, 'draft-error'));
            }
          };
          status.append(approve);
        }
        content.append(
          status,
          element(
            'p',
            tr(
              'Static HTML preview. AI review and your approval are separate. New versions require a new review.',
            ),
            'draft-caption',
          ),
        );
        const stage = element('div', undefined, 'draft-stage');
        const frame = element('iframe');
        frame.title = draft.title;
        frame.setAttribute('sandbox', '');
        frame.referrerPolicy = 'no-referrer';
        frame.width = state.width;
        frame.height = state.height;
        frame.style.colorScheme = state.theme;
        frame.dataset.previewLoaded = 'false';
        frame.addEventListener('load', () => {
          frame.dataset.previewLoaded = 'true';
        });
        frame.src =
          versionPath(target, draft) + '/content?theme=' + state.theme;
        stage.append(frame);
        content.append(stage);
        content.append(
          element(
            'p',
            tr(
              'Scroll the preview or increase its height to inspect all content.',
            ),
            'draft-caption',
          ),
        );
        if (draft.review) {
          content.append(
            element('h3', tr('Visual review')),
            element('div', draft.review.findings, 'draft-findings'),
          );
        }
        if (draft.screenshots.length) {
          content.append(element('h3', tr('Screenshots for this version')));
          const gallery = element('div', undefined, 'draft-shots');
          for (const shot of draft.screenshots) {
            const figure = element('figure'),
              link = element('a'),
              image = element('img');
            link.href =
              versionPath(target, draft) +
              '/screenshots/' +
              encodeURIComponent(shot.id);
            link.target = '_blank';
            link.rel = 'noopener';
            image.src = link.href;
            image.alt = `${draft.title} · ${shot.width} px · ${tr(shot.theme === 'dark' ? 'Dark' : 'Light')}`;
            image.loading = 'lazy';
            link.append(image);
            figure.append(link, element('figcaption', image.alt));
            gallery.append(figure);
          }
          content.append(gallery);
        }
      }
      for (const control of [picker, width, theme, height])
        control.addEventListener('change', show);
      show();
    } catch (e) {
      if (root._draftRequest === request) {
        // A failed load must stay visible, not hide the section as if empty
        root.dispatchEvent(new CustomEvent('drafts-count', { detail: -1 }));
        root.replaceChildren(element('p', e.message, 'draft-error'));
      }
    }
  }
  window.htmlDrafts = { render };
  const standalone = document.getElementById('standalone-draft');
  if (standalone) {
    const args = new URLSearchParams(location.search);
    if (args.get('capture') === '1')
      document.body.classList.add('draft-capture');
    const target = { projectId: args.get('project'), id: args.get('ticket') };
    const back = document.getElementById('draft-back');
    back.href = `/projects/${encodeURIComponent(target.projectId)}/tickets/${encodeURIComponent(target.id)}`;
    render(standalone, target, {
      draft: args.get('draft'),
      version: Number(args.get('version')),
      width: [390, 768, 1280].includes(Number(args.get('width')))
        ? Number(args.get('width'))
        : 390,
      height: Math.max(
        200,
        Math.min(12000, Number(args.get('height')) || 1100),
      ),
      theme: args.get('theme') === 'dark' ? 'dark' : 'light',
    });
  }
})();
