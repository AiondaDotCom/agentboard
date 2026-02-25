import { describe, it, expect } from 'vitest';
import { isValidColumn, VALID_COLUMNS } from '../../src/types.js';

describe('types', () => {
  describe('VALID_COLUMNS', () => {
    it('should contain all expected columns', () => {
      expect(VALID_COLUMNS).toEqual(['backlog', 'ready', 'in_progress', 'in_review', 'done']);
    });
  });

  describe('isValidColumn', () => {
    it('should return true for valid column values', () => {
      expect(isValidColumn('backlog')).toBe(true);
      expect(isValidColumn('ready')).toBe(true);
      expect(isValidColumn('in_progress')).toBe(true);
      expect(isValidColumn('in_review')).toBe(true);
      expect(isValidColumn('done')).toBe(true);
    });

    it('should return false for invalid string values', () => {
      expect(isValidColumn('invalid')).toBe(false);
      expect(isValidColumn('todo')).toBe(false);
      expect(isValidColumn('')).toBe(false);
    });

    it('should return false for non-string values', () => {
      expect(isValidColumn(undefined)).toBe(false);
      expect(isValidColumn(null)).toBe(false);
      expect(isValidColumn(42)).toBe(false);
      expect(isValidColumn({})).toBe(false);
    });
  });
});
