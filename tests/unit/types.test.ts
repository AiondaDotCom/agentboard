import { describe, it, expect } from 'vitest';
import { DEFAULT_COLUMNS, LEGACY_COLUMNS, COLUMN_ID_RE } from '../../src/types.js';

describe('types', () => {
  describe('DEFAULT_COLUMNS', () => {
    it('should contain the 6-column default set in order', () => {
      expect(DEFAULT_COLUMNS.map((c) => c.id)).toEqual([
        'backlog', 'blocked', 'in_progress', 'rework', 'in_review', 'done',
      ]);
    });

    it('should have a title for every column', () => {
      for (const col of DEFAULT_COLUMNS) {
        expect(col.title.length).toBeGreaterThan(0);
      }
    });
  });

  describe('LEGACY_COLUMNS', () => {
    it('should contain the old 5-column set in order', () => {
      expect(LEGACY_COLUMNS.map((c) => c.id)).toEqual([
        'backlog', 'ready', 'in_progress', 'in_review', 'done',
      ]);
    });
  });

  describe('COLUMN_ID_RE', () => {
    it('should accept valid slugs', () => {
      expect(COLUMN_ID_RE.test('backlog')).toBe(true);
      expect(COLUMN_ID_RE.test('in_progress')).toBe(true);
      expect(COLUMN_ID_RE.test('qa-check')).toBe(true);
      expect(COLUMN_ID_RE.test('stage2')).toBe(true);
    });

    it('should reject invalid ids', () => {
      expect(COLUMN_ID_RE.test('')).toBe(false);
      expect(COLUMN_ID_RE.test('In Progress')).toBe(false);
      expect(COLUMN_ID_RE.test('UPPER')).toBe(false);
      expect(COLUMN_ID_RE.test('-leading')).toBe(false);
      expect(COLUMN_ID_RE.test('a'.repeat(33))).toBe(false);
    });
  });
});
