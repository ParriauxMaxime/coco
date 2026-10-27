import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyOf, latestModels } from '../src/preview/chat/model-view.ts';

const m = (id: string, label: string) => ({ id, label });
const catalog = [
  m('claude-opus-5-5', 'Opus 5.5'),
  m('claude-opus-5', 'Opus 5'),
  m('claude-fable-5-1', 'Fable 5.1'),
  m('claude-fable-5', 'Fable 5'),
  m('claude-opus-4-8[1m]', 'Opus 4.8 1M'),
  m('claude-opus-4-8', 'Opus 4.8'),
  m('claude-sonnet-5-5', 'Sonnet 5.5'),
  m('claude-sonnet-5', 'Sonnet 5'),
  m('claude-sonnet-5[1m]', 'Sonnet 5 1M'),
  m('claude-sonnet-4-6', 'Sonnet 4.6'),
  m('claude-haiku-5-5', 'Haiku 5.5'),
  m('claude-haiku-4-5', 'Haiku 4.5'),
];
const ids = (list: { id: string }[]) => list.map((x) => x.id);

test('latest keeps the newest release per family, in the catalog order, without 1M variants', () => {
  assert.deepEqual(ids(latestModels(catalog)), ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
});

test('latest still lists the ids it is asked to keep, an older pick or a 1M one', () => {
  assert.deepEqual(ids(latestModels(catalog, ['claude-opus-4-8', 'claude-sonnet-5[1m]'])), ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-sonnet-5-5', 'claude-sonnet-5[1m]', 'claude-haiku-5-5']);
});

test('a family is the id without its version numbers', () => {
  assert.equal(familyOf('claude-opus-4-8'), 'claude-opus');
  assert.equal(familyOf('claude-sonnet-5[1m]'), 'claude-sonnet');
  assert.equal(familyOf('gpt-5.1-codex'), 'gpt-codex');
  assert.equal(familyOf('o3'), 'o');
});
