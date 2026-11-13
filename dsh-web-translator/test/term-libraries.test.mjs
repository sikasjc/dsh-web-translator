/** Terminology-library persistence: defaults, CRUD, validation, limits and scoping. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { createJsonStore } from '../lib/store.js';
import { createTermLibrariesService, TERM_LIBRARIES_VERSION } from '../lib/term-libraries.js';
import { createTempDir, removeTempDir } from './helpers.mjs';

/** Fresh service over one temp data directory. */
async function setupService(t) {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const filePath = join(dir, 'term-libraries.json');
  const store = createJsonStore(filePath, { defaultValue: () => ({ version: TERM_LIBRARIES_VERSION }) });
  const service = createTermLibrariesService({ store });
  return { dir, filePath, store, service };
}

test('an absent file enables every built-in pack and no custom library', async (t) => {
  const { service } = await setupService(t);
  const payload = await service.list();
  assert.ok(payload.libraries.length >= 2);
  assert.ok(payload.libraries.every((library) => library.builtin === true && library.enabled === true));
  assert.ok(payload.libraries.every((library) => Array.isArray(library.terms) && library.terms.length > 0));
  assert.deepEqual(payload.limits, { libraries: 20, termsPerLibrary: 200, nameChars: 40, sourceChars: 120, targetChars: 120 });
  assert.equal(payload.appliesTo.builtinScope, 'technical-pages');
  assert.equal(payload.appliesTo.customScope, 'always');
});

test('a custom library is created enabled, persisted and can be toggled/renamed/removed', async (t) => {
  const { service, filePath } = await setupService(t);
  const created = await service.addLibrary({ name: '  项目术语  ' });
  const libraryId = created.id;
  const createdLibrary = created.libraries.find((library) => library.id === libraryId);
  assert.equal(createdLibrary.name, '项目术语', 'name is trimmed');
  assert.equal(createdLibrary.builtin, false);
  assert.equal(createdLibrary.enabled, true);

  // Survives a service restart over the same store file.
  const restarted = createTermLibrariesService({
    store: createJsonStore(filePath, { defaultValue: () => ({ version: TERM_LIBRARIES_VERSION }) }),
  });
  const persisted = await restarted.list();
  const persistedLibrary = persisted.libraries.find((library) => library.id === libraryId);
  assert.equal(persistedLibrary.name, '项目术语');
  assert.equal(persistedLibrary.enabled, true);

  const renamed = await service.renameLibrary({ id: libraryId, name: '游戏术语' });
  assert.equal(renamed.libraries.find((library) => library.id === libraryId).name, '游戏术语');

  const disabled = await service.setEnabled({ id: libraryId, enabled: false });
  assert.equal(disabled.libraries.find((library) => library.id === libraryId).enabled, false);
  const enabled = await service.setEnabled({ id: libraryId, enabled: true });
  assert.equal(enabled.libraries.find((library) => library.id === libraryId).enabled, true);

  const removed = await service.removeLibrary({ id: libraryId });
  assert.equal(removed.libraries.some((library) => library.id === libraryId), false);
});

test('custom term entries validate, dedupe, update and remove', async (t) => {
  const { service } = await setupService(t);
  const created = await service.addLibrary({ name: '项目术语' });
  const libraryId = created.id;

  await assert.rejects(() => service.addEntry({ libraryId, source: 'behavior tree', policy: 'translate' }), /target is required/);
  await assert.rejects(() => service.addEntry({ libraryId, source: 'behavior tree', policy: 'explode' }), /policy must be one of/);
  await assert.rejects(() => service.addEntry({ libraryId, source: '   ', policy: 'keep' }), /source must not be empty/);
  await assert.rejects(() => service.addEntry({ libraryId, source: 'x'.repeat(121), policy: 'keep' }), /exceeds 120/);

  const translated = await service.addEntry({ libraryId, source: 'behavior tree', policy: 'translate', target: '行为树' });
  const translatedEntry = translated.libraries.find((library) => library.id === libraryId).terms[0];
  assert.equal(translatedEntry.target, '行为树');
  await assert.rejects(
    () => service.addEntry({ libraryId, source: 'Behavior Tree', policy: 'translate', target: '行为树' }),
    /already exists/,
  );

  const kept = await service.addEntry({ libraryId, source: 'feature flag', policy: 'keep' });
  assert.equal(kept.libraries.find((library) => library.id === libraryId).terms.length, 2);

  const updated = await service.updateEntry({ libraryId, entryId: translatedEntry.id, target: '行为树结构' });
  assert.equal(updated.libraries.find((library) => library.id === libraryId).terms[0].target, '行为树结构');
  await assert.rejects(() => service.updateEntry({ libraryId, entryId: 'te_missing', target: 'x' }), /term entry not found/);
  await assert.rejects(
    () => service.updateEntry({ libraryId, entryId: translatedEntry.id, source: 'feature flag' }),
    /already exists/,
  );

  const removed = await service.removeEntry({ libraryId, entryId: translatedEntry.id });
  assert.equal(removed.libraries.find((library) => library.id === libraryId).terms.length, 1);
  await assert.rejects(() => service.removeEntry({ libraryId, entryId: translatedEntry.id }), /term entry not found/);
});

test('built-in packs are toggleable but not editable; unknown ids are rejected', async (t) => {
  const { service } = await setupService(t);
  await assert.rejects(() => service.renameLibrary({ id: 'rust', name: 'x' }), /term library not found/);
  await assert.rejects(() => service.removeLibrary({ id: 'rust' }), /term library not found/);
  await assert.rejects(() => service.addEntry({ libraryId: 'rust', source: 'x', policy: 'keep' }), /term library not found/);
  await assert.rejects(() => service.setEnabled({ id: 'nope', enabled: false }), /term library not found/);

  const disabled = await service.setEnabled({ id: 'rust', enabled: false });
  const rust = disabled.libraries.find((library) => library.id === 'rust');
  assert.equal(rust.enabled, false);
  const active = await service.activeLibraries();
  assert.equal(active.builtin.some((library) => library.id === 'rust'), false);
  assert.equal(active.builtin.some((library) => library.id === 'programming'), true);
});

test('activeLibraries returns only enabled libraries and includes custom ones', async (t) => {
  const { service } = await setupService(t);
  const created = await service.addLibrary({ name: '项目术语' });
  await service.addEntry({ libraryId: created.id, source: 'behavior tree', policy: 'translate', target: '行为树' });
  const active = await service.activeLibraries();
  assert.ok(active.builtin.length >= 2);
  assert.equal(active.custom.length, 1);
  assert.equal(active.custom[0].terms[0].source, 'behavior tree');

  await service.setEnabled({ id: created.id, enabled: false });
  const withoutCustom = await service.activeLibraries();
  assert.deepEqual(withoutCustom.custom, []);
});

test('importLibraries creates enabled libraries atomically with name dedupe', async (t) => {
  const { service } = await setupService(t);
  await service.addLibrary({ name: '已有库' });
  const imported = await service.importLibraries({
    libraries: [
      { name: '项目术语', terms: [{ source: 'behavior tree', policy: 'translate', target: '行为树' }, { source: 'feature flag', policy: 'keep' }] },
      { name: '已有库', terms: [{ source: 'port', policy: 'translate', target: '端口' }] },
    ],
  });
  assert.deepEqual(imported.imported.map((item) => item.name), ['项目术语', '已有库 (2)'], 'existing names get a suffix');
  const project = imported.libraries.find((library) => library.name === '项目术语');
  assert.equal(project.builtin, false);
  assert.equal(project.enabled, true, 'imported libraries start enabled');
  assert.deepEqual(project.terms.map((term) => term.policy), ['translate', 'keep']);
  const active = await service.activeLibraries();
  assert.equal(active.custom.length, 3);

  const before = (await service.list()).libraries.length;
  await assert.rejects(
    () => service.importLibraries({ libraries: [{ name: '坏库', terms: [{ source: 'x', policy: 'translate' }] }] }),
    /target is required/,
  );
  assert.equal((await service.list()).libraries.length, before, 'a rejected import writes nothing');

  await assert.rejects(
    () => service.importLibraries({ libraries: [{ name: '重复源', terms: [{ source: 'x', policy: 'keep' }, { source: 'X', policy: 'keep' }] }] }),
    /duplicate term source/,
  );
  await assert.rejects(() => service.importLibraries({ libraries: [] }), /non-empty array/);
  await assert.rejects(
    () => service.importLibraries({ libraries: [{ name: '超量', terms: Array.from({ length: 201 }, (_, index) => ({ source: `term ${index}`, policy: 'keep' })) }] }),
    /exceeds 200 terms/,
  );
});

test('importLibraries respects the custom-library cap', async (t) => {
  const { service } = await setupService(t);
  for (let index = 0; index < 19; index += 1) {
    await service.addLibrary({ name: `库 ${index}` });
  }
  await assert.rejects(
    () => service.importLibraries({
      libraries: [
        { name: '新库 A', terms: [{ source: 'a', policy: 'keep' }] },
        { name: '新库 B', terms: [{ source: 'b', policy: 'keep' }] },
      ],
    }),
    /at most 20 custom libraries/,
  );
  const ok = await service.importLibraries({ libraries: [{ name: '新库 C', terms: [{ source: 'c', policy: 'keep' }] }] });
  assert.equal(ok.imported.length, 1);
});

test('library limits are enforced', async (t) => {
  const { service } = await setupService(t);
  for (let index = 0; index < 20; index += 1) {
    await service.addLibrary({ name: `库 ${index}` });
  }
  await assert.rejects(() => service.addLibrary({ name: '第 21 个' }), /at most 20 custom libraries/);
});

test('malformed persisted data is ignored and normalized when read', async (t) => {
  const { service, store } = await setupService(t);
  // Simulate a hand-edited/corrupted document through a direct mutation.
  await store.mutate((doc) => {
    doc.libraries = [
      { id: 'tl_bad', name: '', terms: [] },
      { id: 'tl_ok', name: 'ok', terms: [{ id: 'te_1', source: 'x', policy: 'translate' }] },
      { id: 'tl_ok2', name: 'ok2', terms: [{ id: 'te_2', source: 'y', policy: 'translate', target: 'Y' }] },
    ];
    doc.active = ['tl_ok2', 'missing-id'];
  });
  const payload = await service.list();
  assert.ok(payload.libraries.every((library) => library.name.length > 0));
  const custom = payload.libraries.filter((library) => library.builtin === false);
  assert.equal(custom.length, 2, 'the nameless library is dropped');
  assert.deepEqual(custom[0].terms, [], 'an entry without a translate target is dropped');
  assert.deepEqual(custom[1].terms.map((entry) => entry.target), ['Y']);
  assert.deepEqual(custom.map((library) => library.enabled), [false, true], 'unknown active ids are ignored');
});
