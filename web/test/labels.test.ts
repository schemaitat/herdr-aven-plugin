import { expect, test } from 'vitest';
import { compactId, nonOverlappingLabels } from '../src/graph/labels.js';

test('opaque ids are compact only in presentation', () => {
  expect(compactId('ses_abcdefghijk')).toBe('ses_abcd');
  expect(compactId('att_12345678')).toBe('att_1234');
  expect(compactId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e');
});

test('caption suppression is deterministic and prioritizes selection', () => {
  expect(nonOverlappingLabels([{ id: 'other', x: 2, y: 2, width: 20, height: 10 }, { id: 'selected', x: 0, y: 0, width: 20, height: 10, priority: 1 }])).toEqual(new Set(['selected']));
});
