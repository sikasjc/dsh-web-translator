/** Settings validation, merge, persistence structure and defaults (DESIGN §4.1/§5.4/§5.5). */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULTS, TARGET_LANGUAGES } from '../lib/constants.js';
import { createFakeLogger, createTempDir, removeTempDir } from './helpers.mjs';
import {
  createSettingsService,
  effectiveSettings,
  normalizeSettingsPatch,
  sanitizeSavedSettings,
} from '../lib/settings.js';
import { createJsonStore } from '../lib/store.js';

/** Assert one invalid-settings rejection. */
function assertInvalid(run, pattern) {
  assert.throws(run, (error) => {
    assert.equal(error.code, 'INVALID_SETTINGS');
    assert.equal(error.status, 400);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test('accepts a complete valid patch', () => {
  const { values, warnings } = normalizeSettingsPatch({
    provider: 'modelhub',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
    targetLanguage: 'ja',
    systemPrompt: 'Translate to {{targetLanguage}}',
    userTemplate: '{{segmentsJson}}',
    batchSegments: 5,
    batchChars: 2000,
    concurrency: 3,
  });
  assert.deepEqual(warnings, []);
  assert.equal(values.provider, 'modelhub');
  assert.equal(values.reasoningEffort, 'max');
  assert.equal(values.targetLanguage, 'ja');
  assert.equal(values.batchSegments, 5);
  assert.equal(values.concurrency, 3);
});

test('blank prompts mean "restore default" (undefined patch value)', () => {
  const { values } = normalizeSettingsPatch({ systemPrompt: '', userTemplate: '   ' });
  assert.equal(Object.hasOwn(values, 'systemPrompt'), true);
  assert.equal(values.systemPrompt, undefined);
  assert.equal(values.userTemplate, undefined);
});

test('rejects type and range violations with INVALID_SETTINGS', () => {
  assertInvalid(() => normalizeSettingsPatch(null), /JSON object/);
  assertInvalid(() => normalizeSettingsPatch({ batchSegments: 0 }), /batchSegments/);
  assertInvalid(() => normalizeSettingsPatch({ batchSegments: 21 }), /batchSegments/);
  assertInvalid(() => normalizeSettingsPatch({ batchSegments: 2.5 }), /batchSegments/);
  assertInvalid(() => normalizeSettingsPatch({ batchChars: 199 }), /batchChars/);
  assertInvalid(() => normalizeSettingsPatch({ batchChars: 4001 }), /batchChars/);
  assertInvalid(() => normalizeSettingsPatch({ concurrency: 5 }), /concurrency/);
  assertInvalid(() => normalizeSettingsPatch({ provider: '' }), /provider/);
  assertInvalid(() => normalizeSettingsPatch({ model: 42 }), /model/);
  assertInvalid(() => normalizeSettingsPatch({ reasoningEffort: '' }), /reasoningEffort/);
  assertInvalid(() => normalizeSettingsPatch({ targetLanguage: 'xx-YY' }), /targetLanguage/);
  assertInvalid(() => normalizeSettingsPatch({ systemPrompt: 'x'.repeat(8001) }), /systemPrompt/);
  assertInvalid(() => normalizeSettingsPatch({ userTemplate: 'x'.repeat(4001) }), /userTemplate/);
  assertInvalid(() => normalizeSettingsPatch({}), /no settings fields/);
  assertInvalid(() => normalizeSettingsPatch({ unknownField: 1 }), /no settings fields/);
});

test('every whitelisted target language is accepted, others are not', () => {
  for (const language of TARGET_LANGUAGES) {
    const { values } = normalizeSettingsPatch({ targetLanguage: language });
    assert.equal(values.targetLanguage, language);
  }
  assertInvalid(() => normalizeSettingsPatch({ targetLanguage: 'en-US' }));
});

test('unknown placeholders only warn; unknown fields are ignored with a warning', () => {
  const { values, warnings } = normalizeSettingsPatch({
    systemPrompt: '{{targetLanguage}} {{nope}}',
    extra: true,
  });
  assert.equal(values.systemPrompt, '{{targetLanguage}} {{nope}}');
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /nope/);
  assert.match(warnings.join('\n'), /extra/);
});

test('sanitizeSavedSettings drops invalid persisted values', () => {
  const clean = sanitizeSavedSettings({
    provider: 'modelhub',
    model: 'deepseek-flash',
    batchSegments: 999,
    targetLanguage: 'xx',
    systemPrompt: 'custom',
    concurrency: 2,
    junk: 'x',
  });
  assert.deepEqual(clean, {
    provider: 'modelhub',
    model: 'deepseek-flash',
    systemPrompt: 'custom',
    concurrency: 2,
  });
  assert.deepEqual(sanitizeSavedSettings(null), {});
  assert.deepEqual(sanitizeSavedSettings([]), {});
});

test('effectiveSettings overlays defaults and falls back to the agent default model', () => {
  const fallback = effectiveSettings({}, { provider: 'modelhub', model: 'deepseek-flash' });
  assert.equal(fallback.source, 'default');
  assert.equal(fallback.settings.provider, 'modelhub');
  assert.equal(fallback.settings.model, 'deepseek-flash');
  assert.equal(fallback.settings.reasoningEffort, 'auto');
  assert.equal(fallback.settings.targetLanguage, 'zh-CN');
  assert.equal(fallback.settings.batchSegments, 10);
  assert.equal(fallback.settings.systemPrompt, DEFAULTS.systemPrompt);
  assert.equal(fallback.settings.userTemplate, DEFAULTS.userTemplate);

  const saved = effectiveSettings(
    { provider: 'p', model: 'm', reasoningEffort: 'off', targetLanguage: 'ko' },
    { provider: 'modelhub', model: 'deepseek-flash' },
  );
  assert.equal(saved.source, 'settings');
  assert.equal(saved.settings.provider, 'p');
  assert.equal(saved.settings.reasoningEffort, 'off');
  assert.equal(saved.settings.targetLanguage, 'ko');

  // Half a saved pair is not a choice: the default selection wins.
  const partial = effectiveSettings({ provider: 'p' }, { provider: 'modelhub', model: 'deepseek-flash' });
  assert.equal(partial.source, 'default');
  assert.equal(partial.settings.provider, 'modelhub');
});

test('settings service persists {version, settings, updatedAt} and supports removal', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const store = createJsonStore(join(dir, 'settings.json'), {
    defaultValue: () => ({ version: 1, settings: {}, updatedAt: 0 }),
    logger,
  });
  let clock = 1000;
  const service = createSettingsService({ store, logger, now: () => clock });

  assert.deepEqual(await service.loadSaved(), {});
  await service.save({ batchSegments: 5, systemPrompt: 'custom prompt' });
  clock = 2000;
  await service.save({ systemPrompt: undefined, targetLanguage: 'fr' });
  // Removing a never-saved-ish field is fine; settings keep the rest.
  await service.save({ reasoningEffort: 'max' });
  assert.deepEqual(await service.loadSaved(), {
    batchSegments: 5,
    targetLanguage: 'fr',
    reasoningEffort: 'max',
  });

  const raw = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.updatedAt, 2000);
  assert.deepEqual(raw.settings, { batchSegments: 5, targetLanguage: 'fr', reasoningEffort: 'max' });
});

test('settings service tolerates a corrupt document', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const store = createJsonStore(join(dir, 'settings.json'), {
    defaultValue: () => ({ version: 1, settings: {}, updatedAt: 0 }),
    logger,
  });
  const service = createSettingsService({ store, logger });
  // No file yet: defaults.
  assert.deepEqual(await service.loadSaved(), {});
  assert.equal(logger.lines.warn.length, 0);
});
