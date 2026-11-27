import { randomUUID } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { PNG } from 'pngjs';
import type { AgentboardDB } from '../db/database.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { loadServerConfig, localBaseUrl } from '../config.js';

/** Preview inputs keep a known harmless type; anything else becomes text. */
const ALLOWED_INPUT_TYPES = new Set([
  'text',
  'checkbox',
  'radio',
  'email',
  'number',
  'search',
  'date',
]);
const inputType = (type: string | undefined): string =>
  type !== undefined && ALLOWED_INPUT_TYPES.has(type) ? type : 'text';

export const VISUAL_REVIEW_INSTRUCTIONS =
  'Store HTML mockups with save_html_draft instead of embedding executable HTML in Markdown descriptions or comments. After creating or changing an HTML draft, open the returned preview URL in a browser and capture AND visually inspect screenshots for mobile (390px) and desktop (1280px), in light AND dark mode. Use captureUrls for clean screenshots of the saved preview, set the browser viewport to the specified width, wait for the iframe to load and fonts/layout to settle, and increase preview height or scroll as needed to inspect ALL content. Check readability, wrapping, clipping, overflow and layout. Upload the actual PNG screenshots with add_draft_screenshot for this exact version, then record your findings with review_html_draft. Correct problems in a new version and repeat. Never claim visual review from HTML source or automated checks alone. If browser/screenshot access is unavailable, leave review pending and explain the limitation. User approval is separate and cannot be given by an AI tool.';
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";
export interface DraftReview {
  status: 'passed' | 'needs_changes';
  findings: string;
  agentId: string;
  createdAt: string;
  screenshotIds: string[];
}
export interface DraftScreenshot {
  id: string;
  width: number;
  height: number;
  theme: 'light' | 'dark';
  createdAt: string;
  agentId: string;
}
export interface DraftVersion {
  id: string;
  ticketId: string;
  version: number;
  title: string;
  html: string;
  createdAt: string;
  agentId: string;
  review: DraftReview | null;
  approvedAt: string | null;
}
export interface ScreenshotInput {
  png_base64: string;
  width: number;
  height: number;
  theme: 'light' | 'dark';
}

export interface DraftPresentation extends Omit<DraftVersion, 'html'> {
  html: string | undefined;
  previewPath: string;
  previewUrl: string;
  reviewStatus: 'pending' | DraftReview['status'];
  screenshots: DraftScreenshot[];
  captureUrls: { width: number; theme: string; url: string }[];
  instructions: string;
}

function text(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > max
  )
    throw new ValidationError(
      `${name} must be nonempty and at most ${String(max)} bytes`,
    );
  return value.trim();
}
export function staticHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'style',
      'div',
      'span',
      'p',
      'br',
      'hr',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'small',
      'sub',
      'sup',
      'ul',
      'ol',
      'li',
      'dl',
      'dt',
      'dd',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'td',
      'th',
      'caption',
      'colgroup',
      'col',
      'section',
      'article',
      'header',
      'footer',
      'main',
      'nav',
      'aside',
      'figure',
      'figcaption',
      'pre',
      'code',
      'blockquote',
      'img',
      'button',
      'label',
      'input',
      'textarea',
      'select',
      'option',
    ],
    allowedAttributes: {
      '*': [
        'style',
        'class',
        'id',
        'title',
        'role',
        'aria-label',
        'aria-hidden',
      ],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      input: ['type', 'value', 'placeholder', 'checked', 'disabled'],
      textarea: ['rows', 'cols', 'placeholder', 'disabled'],
      button: ['type', 'disabled'],
      option: ['selected'],
      col: ['span'],
    },
    allowedSchemes: ['data'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    // Styles are intentionally supported. CSP isolates CSS and blocks all remote resources.
    allowVulnerableTags: true,
    parseStyleAttributes: false,
    transformTags: {
      input: (tag, attrs) => ({
        tagName: tag,
        attribs: {
          ...attrs,
          disabled: '',
          type: inputType(attrs['type']),
        },
      }),
      button: (tag, attrs) => ({
        tagName: tag,
        attribs: { ...attrs, type: 'button' },
      }),
    },
  });
}

export class HtmlDraftService {
  constructor(
    private db: AgentboardDB,
    private changed: (
      projectId: string,
      ticketId: string,
      agentId: string | null,
      detail: string,
    ) => void,
  ) {}
  private ticket(projectId: string, ticketId: string): void {
    if (!this.db.getTicket(projectId, ticketId))
      throw new NotFoundError('Ticket not found');
  }
  private version(
    projectId: string,
    ticketId: string,
    id: string,
    version: number,
  ): DraftVersion {
    this.ticket(projectId, ticketId);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new ValidationError('Invalid draft version');
    const draft = this.db.getHtmlDraft(id, version);
    if (draft?.ticketId !== ticketId)
      throw new NotFoundError('Draft version not found');
    return draft;
  }
  private present(
    projectId: string,
    draft: DraftVersion,
    includeHtml = true,
  ): DraftPresentation {
    const previewPath = `/draft-preview.html?project=${encodeURIComponent(projectId)}&ticket=${encodeURIComponent(draft.ticketId)}&draft=${encodeURIComponent(draft.id)}&version=${String(draft.version)}`;
    const base =
      process.env['PUBLIC_URL'] ?? localBaseUrl(loadServerConfig());
    return {
      ...draft,
      html: includeHtml ? draft.html : undefined,
      previewPath,
      previewUrl: new URL(previewPath, base).href,
      reviewStatus: draft.review?.status ?? 'pending',
      screenshots: this.db.getDraftScreenshots(draft.id, draft.version),
      captureUrls: [390, 1280].flatMap((width) =>
        ['light', 'dark'].map((theme) => ({
          width,
          theme,
          url: new URL(
            previewPath + `&capture=1&width=${String(width)}&theme=${theme}`,
            base,
          ).href,
        })),
      ),
      instructions: VISUAL_REVIEW_INSTRUCTIONS,
    };
  }
  list(projectId: string, ticketId: string): DraftPresentation[] {
    this.ticket(projectId, ticketId);
    return this.db
      .listHtmlDrafts(ticketId)
      .map((d) => this.present(projectId, d, false));
  }
  get(
    projectId: string,
    ticketId: string,
    id: string,
    version: number,
  ): DraftPresentation {
    return this.present(
      projectId,
      this.version(projectId, ticketId, id, version),
    );
  }
  save(
    projectId: string,
    ticketId: string,
    title: string,
    html: string,
    agentId: string,
    id?: string,
    expectedVersion?: number,
  ): DraftPresentation {
    this.ticket(projectId, ticketId);
    const name = text(title, 'title', 200);
    const source = text(html, 'html', 512 * 1024);
    let version = 1;
    if (id !== undefined) {
      const current = this.db.latestHtmlDraft(id);
      if (current?.ticketId !== ticketId)
        throw new NotFoundError('Draft not found');
      if (expectedVersion !== current.version)
        throw new ConflictError(
          'Draft changed; read latest version before saving',
        );
      version = current.version + 1;
    } else if (expectedVersion !== undefined)
      throw new ValidationError('expected_version requires draft_id');
    const draft: DraftVersion = {
      id: id ?? randomUUID(),
      ticketId,
      version,
      title: name,
      html: source,
      agentId,
      createdAt: new Date().toISOString(),
      review: null,
      approvedAt: null,
    };
    this.db.saveHtmlDraft(draft);
    this.changed(
      projectId,
      ticketId,
      agentId,
      `HTML draft: ${name} v${String(version)}`,
    );
    return this.present(projectId, draft);
  }
  screenshot(
    projectId: string,
    ticketId: string,
    id: string,
    version: number,
    input: ScreenshotInput | null | undefined,
    agentId: string,
  ): DraftScreenshot {
    this.version(projectId, ticketId, id, version);
    if (
      !input ||
      !Number.isInteger(input.width) ||
      input.width < 320 ||
      input.width > 3840 ||
      !Number.isInteger(input.height) ||
      input.height < 200 ||
      input.height > 12000 ||
      !['light', 'dark'].includes(input.theme)
    )
      throw new ValidationError('Invalid screenshot viewport or theme');
    const encoded = text(input.png_base64, 'png_base64', 8 * 1024 * 1024);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new ValidationError('Expected raw PNG base64');
    const png = Buffer.from(encoded, 'base64');
    if (
      png.length < 45 ||
      png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.subarray(12, 16).toString() !== 'IHDR' ||
      png.subarray(-8, -4).toString() !== 'IEND'
    )
      throw new ValidationError('Invalid PNG');
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20);
    if (
      width < input.width ||
      width > input.width * 4 ||
      height < 1 ||
      height > 48000 ||
      width * height > 24_000_000
    )
      throw new ValidationError(
        'PNG dimensions do not match viewport or exceed limits',
      );
    try {
      PNG.sync.read(png, { checkCRC: true });
    } catch {
      throw new ValidationError('PNG image cannot be decoded');
    }
    if (this.db.getDraftScreenshots(id, version).length >= 16)
      throw new ValidationError('At most 16 screenshots per draft version');
    const shot: DraftScreenshot = {
      id: randomUUID(),
      width: input.width,
      height: input.height,
      theme: input.theme,
      agentId,
      createdAt: new Date().toISOString(),
    };
    this.db.saveDraftScreenshot(id, version, shot, png);
    this.changed(
      projectId,
      ticketId,
      agentId,
      `HTML draft screenshot v${String(version)}`,
    );
    return shot;
  }
  review(
    projectId: string,
    ticketId: string,
    id: string,
    version: number,
    status: string,
    findings: string,
    screenshotIds: string[],
    visuallyInspected: unknown,
    agentId: string,
  ): DraftPresentation {
    const draft = this.version(projectId, ticketId, id, version);
    if (this.db.latestHtmlDraft(id)?.version !== version)
      throw new ConflictError(
        'Only the latest version can receive a new review',
      );
    if (
      !['passed', 'needs_changes'].includes(status) ||
      visuallyInspected !== true
    )
      throw new ValidationError(
        'Visual inspection must be explicitly confirmed',
      );
    const notes = text(findings, 'findings', 10000);
    if (
      !Array.isArray(screenshotIds) ||
      !screenshotIds.length ||
      new Set(screenshotIds).size !== screenshotIds.length
    )
      throw new ValidationError('Actual screenshot IDs are required');
    const shots = this.db
      .getDraftScreenshots(id, version)
      .filter((s) => screenshotIds.includes(s.id));
    if (shots.length !== screenshotIds.length)
      throw new ValidationError('Screenshot does not belong to this version');
    if (
      status === 'passed' &&
      !['light', 'dark'].every(
        (theme) =>
          shots.some((s) => s.theme === theme && s.width <= 600) &&
          shots.some((s) => s.theme === theme && s.width >= 1000),
      )
    )
      throw new ValidationError(
        'Passing requires mobile and desktop screenshots in BOTH light and dark mode',
      );
    const review: DraftReview = {
      status: status as DraftReview['status'],
      findings: notes,
      screenshotIds,
      agentId,
      createdAt: new Date().toISOString(),
    };
    this.db.reviewHtmlDraft(id, version, review);
    this.changed(
      projectId,
      ticketId,
      agentId,
      `HTML draft review: ${status} v${String(version)}`,
    );
    return this.present(projectId, { ...draft, review });
  }
  approve(
    projectId: string,
    ticketId: string,
    id: string,
    version: number,
  ): DraftPresentation {
    this.version(projectId, ticketId, id, version);
    if (this.db.latestHtmlDraft(id)?.version !== version)
      throw new ConflictError('Only the latest version can be approved');
    this.db.approveHtmlDraft(id, version);
    this.changed(
      projectId,
      ticketId,
      null,
      `User approved HTML draft v${String(version)}`,
    );
    return this.get(projectId, ticketId, id, version);
  }
  image(
    projectId: string,
    ticketId: string,
    id: string,
    version: number,
    screenshotId: string,
  ): Buffer {
    this.version(projectId, ticketId, id, version);
    const data = this.db.getDraftScreenshotPng(id, version, screenshotId);
    if (!data) throw new NotFoundError('Screenshot not found');
    return data;
  }
}
