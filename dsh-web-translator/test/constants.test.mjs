/** Contract constants: whitelist, defaults, versions and package version sync. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DEFAULTS,
  DEFAULT_SYSTEM_PROMPT,
  DICTIONARY_PROVIDERS,
  DEFAULT_TARGET_LANGUAGE,
  DEFAULT_USER_TEMPLATE,
  LIMITS,
  SETTINGS_KEYS,
  SETTINGS_VERSION,
  TARGET_LANGUAGES,
  USAGE_VERSION,
  WORDBOOK_VERSION,
} from '../lib/constants.js';
import { VERSION } from '../lib/version.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('target language whitelist is the Lead-approved fixed list', () => {
  assert.deepEqual([...TARGET_LANGUAGES], [
    'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar',
  ]);
  assert.equal(DEFAULT_TARGET_LANGUAGE, 'zh-CN');
  assert.equal(DEFAULTS.targetLanguage, 'zh-CN');
  assert.equal(DEFAULTS.translationStyle, 'auto');
  assert.deepEqual([...DICTIONARY_PROVIDERS], ['dictionaryapi.dev', 'wiktionary', 'off']);
  assert.equal(DEFAULTS.dictionaryProvider, 'dictionaryapi.dev');
  assert.equal(DEFAULTS.imageModel, 'auto');
});

test('factory defaults match DESIGN §4.1 / §4.2', () => {
  assert.equal(DEFAULTS.provider, '');
  assert.equal(DEFAULTS.model, '');
  assert.equal(DEFAULTS.reasoningEffort, 'auto');
  assert.equal(DEFAULTS.batchSegments, 10);
  assert.equal(DEFAULTS.batchChars, 1600);
  assert.equal(DEFAULTS.concurrency, 2);
  assert.equal(DEFAULTS.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  assert.equal(DEFAULTS.userTemplate, DEFAULT_USER_TEMPLATE);
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes('{{targetLanguage}}'));
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes('{{segmentCount}}'));
  assert.ok(DEFAULT_USER_TEMPLATE.includes('{{segmentsJson}}'));
});

test('limits match the DESIGN values', () => {
  assert.equal(LIMITS.systemPromptChars, 8000);
  assert.equal(LIMITS.userTemplateChars, 4000);
  assert.equal(LIMITS.requestTexts, 50);
  assert.equal(LIMITS.requestTextChars, 8000);
  assert.equal(LIMITS.batchSegments.min, 1);
  assert.equal(LIMITS.batchSegments.max, 20);
  assert.equal(LIMITS.batchChars.min, 200);
  assert.equal(LIMITS.batchChars.max, 4000);
  assert.equal(LIMITS.concurrency.min, 1);
  assert.equal(LIMITS.concurrency.max, 4);
  assert.equal(LIMITS.bodyBytes, 1024 * 1024);
  assert.equal(LIMITS.wordbookItems, 5000);
  assert.equal(LIMITS.wordbookListDefault, 200);
  assert.equal(LIMITS.wordbookListMax, 500);
  assert.equal(LIMITS.usageEvents, 500);
  assert.equal(LIMITS.usageDays, 90);
  assert.equal(LIMITS.sourceTitleChars, 200);
  assert.equal(LIMITS.clientChars, 32);
  assert.equal(LIMITS.eventSampleChars, 80);
  // Turn/trace additions (DESIGN-TURN-TRACE §2.1/§2.2).
  assert.equal(LIMITS.turnIdChars, 64);
  assert.equal(LIMITS.modeChars, 16);
  assert.equal(LIMITS.stepIndexMax, 10_000);
  assert.equal(LIMITS.outputPreviewChars, 200);
  assert.equal(LIMITS.usageTurnsDefault, 20);
  assert.equal(LIMITS.usageTurnsMax, 100);
  // Persistent translation cache (DESIGN-CACHE §2).
  assert.equal(LIMITS.translationCacheEntries, 1000);
  assert.equal(LIMITS.translationCacheTtlMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(LIMITS.translationCacheFileBytes, 4 * 1024 * 1024);
});

test('document versions and settings keys are stable', () => {
  assert.equal(SETTINGS_VERSION, 1);
  assert.equal(WORDBOOK_VERSION, 1);
  assert.equal(USAGE_VERSION, 1);
  assert.deepEqual([...SETTINGS_KEYS], [
    'provider', 'model', 'reasoningEffort', 'targetLanguage', 'translationStyle', 'dictionaryProvider', 'imageModel',
    'systemPrompt', 'userTemplate', 'batchSegments', 'batchChars', 'concurrency', 'recordHistory',
  ]);
});

test('reported version matches package.json', async () => {
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
});
