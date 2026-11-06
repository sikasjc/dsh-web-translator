/**
 * Conversation bridge: readable text composition, native session event
 * sequence, dedupe, failure tolerance and lifecycle (DESIGN-CONVERSATIONS §2).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  composeAssistantText,
  composeTitle,
  composeUserText,
  conversationSessionId,
  createConversationBridge,
  IDLE_DISPOSE_MS,
  MAX_LIVE_CONVERSATIONS,
  normalizeSessionUsage,
  TRANSLATION_WORKSPACE_TITLE,
} from '../lib/conversations.js';
import {
  createFakeAgents,
  createFakeCtx,
  createFakeLogger,
  createFakeWorkspaceRegistry,
  createTempDir,
  removeTempDir,
} from './helpers.mjs';

/** One complete translate round description used by most tests. */
const ROUND = Object.freeze({
  turnId: 'tr_test',
  kind: 'translate',
  ok: true,
  texts: ['hello', 'world'],
  translations: ['你好', '世界'],
  targetLanguage: 'zh-CN',
  provider: 'modelhub',
  model: 'deepseek-flash',
  usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sourceTitle: 'Example Page',
  site: 'example.com',
});

/**
 * Bridge over a temp data dir with a fake `agents` service.
 * @returns {Promise<{bridge: object, logger: object, dir: string, agents: object}>}
 */
async function setupBridge(t, { agents, sessionTitle, now, ctx, workspaceRegistry, sessionPersistence } = {}) {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const fakeAgents = agents ?? createFakeAgents();
  const services = ctx ?? createFakeCtx({ agents: fakeAgents, sessionTitle, workspaceRegistry, sessionPersistence });
  const bridge = createConversationBridge({ ctx: services, dataDir: dir, logger, now });
  t.after(() => bridge.dispose());
  return { bridge, logger, dir, agents: fakeAgents };
}

/** Let queued promise jobs (agent disposal) run. */
function flush() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Replace the global timers with capture-only fakes for one test.
 * @returns {{timers: object[], restore: Function}}
 */
function patchTimers(t) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, ms) => {
    const timer = {
      callback,
      ms,
      cleared: false,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true;
        return this;
      },
    };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer !== null && typeof timer === 'object') timer.cleared = true;
  };
  const restore = () => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  };
  t.after(restore);
  return { timers, restore };
}

test('composes the readable user message of one translation round', () => {
  assert.equal(
    composeUserText({ kind: 'translate', texts: ['hello'], targetLanguage: 'zh-CN' }),
    '将以下内容翻译为 zh-CN：\nhello',
  );
  assert.equal(
    composeUserText({ kind: 'translate', texts: ['one', 'two'], targetLanguage: 'ja' }),
    '将以下 2 段内容翻译为 ja：\n1. one\n2. two',
  );
  assert.equal(
    composeUserText({ kind: 'translate', texts: ['', 'only'], targetLanguage: 'en' }),
    '将以下内容翻译为 en：\nonly',
    'blank segments are not rendered as numbered lines',
  );
  assert.equal(
    composeUserText({ kind: 'lookup', text: 'immersive', targetLanguage: 'zh-CN' }),
    '查词（zh-CN）：immersive',
  );
  assert.equal(
    composeUserText({ kind: 'lookup', text: 'immersive', context: '  an immersive experience  ', targetLanguage: 'zh-CN' }),
    '查词（zh-CN）：immersive\n上下文：an immersive experience',
  );
  assert.equal(
    composeUserText({ kind: 'translate', texts: ['x'] }),
    '将以下内容翻译为 目标语言：\nx',
    'a missing target language falls back to a readable placeholder',
  );
  assert.equal(typeof composeUserText(undefined), 'string', 'untrusted input never throws');
});

test('composes the readable assistant message of one translation round', () => {
  assert.equal(composeAssistantText({ kind: 'translate', translations: ['你好'] }), '你好');
  assert.equal(composeAssistantText({ kind: 'translate', translations: ['甲', '乙'] }), '1. 甲\n2. 乙');
  assert.equal(composeAssistantText({ kind: 'translate', translations: [] }), '（无译文）');
  assert.equal(composeAssistantText({ kind: 'lookup', translation: '沉浸式的' }), '沉浸式的');
  assert.equal(composeAssistantText({ kind: 'lookup', translation: '' }), '（无译文）');
  assert.equal(composeAssistantText(null), '（无译文）');
});

test('normalizes session usage: four buckets, cache omitted when zero', () => {
  assert.deepEqual(
    normalizeSessionUsage({ inputTokens: 11, outputTokens: 7 }),
    { inputTokens: 11, outputTokens: 7 },
  );
  assert.deepEqual(
    normalizeSessionUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  );
  assert.deepEqual(
    normalizeSessionUsage({
      inputTokens: -1, outputTokens: 2.9, cacheReadTokens: Number.NaN, cacheWriteTokens: '5',
    }),
    { inputTokens: 0, outputTokens: 2 },
    'junk counters clamp to zero and zero cache buckets are omitted',
  );
  assert.equal(normalizeSessionUsage(undefined), undefined);
  assert.equal(normalizeSessionUsage('nope'), undefined);
});

test('maps a turn id to a path-safe deterministic session id', () => {
  assert.equal(conversationSessionId('tr_abc'), 'translation-tr_abc');
  assert.equal(conversationSessionId(' lk_abc '), 'translation-lk_abc');
  assert.equal(conversationSessionId('tr/a b:c*?'), 'translation-tr-a-b-c');
  assert.equal(conversationSessionId('tr_x'), conversationSessionId('tr_x'), 'mapping is deterministic');

  const fallback = conversationSessionId('翻译会话');
  assert.match(fallback, /^translation-[0-9a-f]{12}$/);
  assert.equal(fallback, conversationSessionId('翻译会话'), 'a sanitized-away turn id keeps a stable suffix');
  assert.equal(conversationSessionId(''), conversationSessionId(''));

  const long = conversationSessionId('a'.repeat(300));
  assert.equal(long.length, 96);
  assert.ok(long.startsWith('translation-'));
  assert.match(long, /^[A-Za-z0-9._-]+$/);
});

test('composes the session title from the page title or site', () => {
  assert.equal(composeTitle({ kind: 'translate', sourceTitle: 'My Page', site: 'example.com' }), '翻译 · My Page');
  assert.equal(composeTitle({ kind: 'translate', site: 'example.com' }), '翻译 · example.com');
  assert.equal(composeTitle({ kind: 'lookup', sourceTitle: 'Word Page' }), '翻译查词 · Word Page');
  assert.equal(composeTitle({ kind: 'translate' }), '翻译');
  assert.equal(composeTitle({ kind: 'lookup' }), '翻译查词');
  assert.equal(composeTitle({ kind: 'translate', sourceTitle: '   ' }), '翻译');

  const long = composeTitle({ kind: 'translate', sourceTitle: 'x'.repeat(200) });
  assert.equal(long.length, 60);
  assert.ok(long.startsWith('翻译 · '));
});

test('appends the native Turn events in contract order with append surfaces', async (t) => {
  const sessionTitle = {
    renames: [],
    rename(session, title) {
      this.renames.push({ session, title });
    },
  };
  const { bridge, agents, dir } = await setupBridge(t, { sessionTitle });
  const recorded = await bridge.recordTurn({ ...ROUND, reasoningEffort: 'max' });
  assert.deepEqual(recorded, { sessionId: 'translation-tr_test', turn: 1 });

  // Agent creation metadata (DESIGN-CONVERSATIONS §2).
  const [created] = agents.state.created;
  assert.equal(created.sessionId, 'translation-tr_test');
  assert.deepEqual(created.meta, { cwd: join(dir, 'conversations') });
  assert.deepEqual(created.agentOptions, {
    provider: 'modelhub',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  });
  assert.equal(bridge.cwd(), join(dir, 'conversations'));
  assert.equal(agents.state.inboxCleared, 1, 'the fresh agent inbox is cleared');
  assert.equal(sessionTitle.renames.length, 1);
  assert.deepEqual(sessionTitle.renames[0], {
    session: agents.state.handles[0].agent.session,
    title: '翻译 · Example Page',
  });

  // Event sequence: turn/start → step/start → user → assistant → step/end → turn/end.
  const appended = agents.state.appended;
  assert.deepEqual(appended.map((entry) => entry.type), [
    'turn/start',
    'step/start',
    'user/message',
    'assistant/message',
    'step/end',
    'turn/end',
  ]);
  const expectedUser = '将以下 2 段内容翻译为 zh-CN：\n1. hello\n2. world';
  const expectedAssistant = '1. 你好\n2. 世界';

  assert.deepEqual(appended[0].payload, { turn: 1 });
  assert.deepEqual(appended[1].payload, { turn: 1, step: 1 });

  const user = appended[2];
  assert.deepEqual(user.options, { surfaceOp: 'append' });
  assert.equal(user.payload.role, 'user');
  assert.match(user.payload.id, /^msg_[0-9a-f]{16}$/);
  assert.deepEqual(user.payload.content, [{ type: 'text', text: expectedUser }]);
  assert.deepEqual(user.payload.source, { kind: 'user' });

  const assistant = appended[3];
  assert.deepEqual(assistant.options, { surfaceOp: 'append' });
  assert.equal(assistant.payload.turn, 1);
  assert.equal(assistant.payload.step, 1);
  assert.equal(assistant.payload.message.role, 'assistant');
  assert.match(assistant.payload.message.id, /^msg_[0-9a-f]{16}$/);
  assert.deepEqual(assistant.payload.message.content, [{ type: 'text', text: expectedAssistant }]);
  assert.deepEqual(assistant.payload.message.source, {
    kind: 'model',
    provider: 'modelhub',
    model: 'deepseek-flash',
  });
  assert.deepEqual(assistant.payload.usage, { inputTokens: 11, outputTokens: 7 });
  assert.equal(assistant.payload.stream.length, 1, 'one compact text-chunks run powers ttft');
  const stream = assistant.payload.stream[0];
  assert.equal(stream.type, 'text-chunks');
  assert.equal(typeof stream.time0, 'number');
  assert.equal(stream.index, 0);
  assert.deepEqual(stream.dt, [0]);
  assert.deepEqual(stream.texts, [expectedAssistant]);

  assert.deepEqual(appended[4].payload, { turn: 1, step: 1 });
  assert.deepEqual(appended[5].payload, { turn: 1, reason: { kind: 'completed' } });
});

test('records later batches as later turns of the same native session', async (t) => {
  let tick = 1_000;
  const { bridge, agents } = await setupBridge(t, { now: () => (tick += 1) });

  const first = await bridge.recordTurn({ ...ROUND, texts: ['a'], translations: ['甲'], stepIndex: 0 });
  const second = await bridge.recordTurn({
    ...ROUND,
    texts: ['b'],
    translations: ['乙'],
    stepIndex: 1,
    usage: { inputTokens: 2, outputTokens: 1 },
  });
  const other = await bridge.recordTurn({
    ...ROUND,
    turnId: 'lk_other',
    kind: 'lookup',
    text: 'word',
    translation: '词',
  });

  assert.deepEqual(first, { sessionId: 'translation-tr_test', turn: 1 });
  assert.deepEqual(second, { sessionId: 'translation-tr_test', turn: 2 });
  assert.deepEqual(other, { sessionId: 'translation-lk_other', turn: 1 });
  assert.equal(agents.state.created.length, 2, 'one native session per turn id');

  const turnStarts = agents.state.appended
    .filter((entry) => entry.type === 'turn/start')
    .map((entry) => [entry.sessionId, entry.payload.turn]);
  assert.deepEqual(turnStarts, [
    ['translation-tr_test', 1],
    ['translation-tr_test', 2],
    ['translation-lk_other', 1],
  ]);

  const rows = bridge.list();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.turnId, row.turns]), [['lk_other', 1], ['tr_test', 2]]);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'createdAt',
    'lastAt',
    'live',
    'sessionId',
    'title',
    'turnId',
    'turns',
  ]);
  assert.equal(rows[0].title, '翻译查词 · Example Page');
  assert.equal(rows[0].live, true);
  assert.ok(rows[0].lastAt > rows[1].lastAt);
});

test('records a failed round without an assistant message', async (t) => {
  const { bridge, agents } = await setupBridge(t);
  const recorded = await bridge.recordTurn({
    ...ROUND,
    ok: false,
    error: { code: 'MODEL_RATE_LIMITED', message: 'm'.repeat(400) },
  });
  assert.deepEqual(recorded, { sessionId: 'translation-tr_test', turn: 1 });

  const appended = agents.state.appended;
  assert.deepEqual(appended.map((entry) => entry.type), [
    'turn/start',
    'step/start',
    'user/message',
    'step/end',
    'turn/end',
  ]);
  assert.equal(appended.some((entry) => entry.type === 'assistant/message'), false);
  assert.deepEqual(appended.at(-1).payload, {
    turn: 1,
    reason: {
      kind: 'error',
      error: { code: 'MODEL_RATE_LIMITED', message: 'm'.repeat(300) },
    },
  });
  assert.equal(agents.state.created.length, 1);
});

test('ignores rounds without a turn id', async (t) => {
  const { bridge, agents } = await setupBridge(t);
  assert.equal(await bridge.recordTurn({ ...ROUND, turnId: '' }), null);
  assert.equal(await bridge.recordTurn({ ...ROUND, turnId: '   ' }), null);
  assert.equal(await bridge.recordTurn({ kind: 'translate' }), null);
  assert.equal(await bridge.recordTurn(null), null);
  assert.equal(agents.state.created.length, 0);
  assert.equal(bridge.enabled(), true);
});

test('never throws when the agents service is missing and warns once', async (t) => {
  const { bridge, logger } = await setupBridge(t, { ctx: createFakeCtx({}) });
  assert.equal(await bridge.recordTurn(ROUND), null);
  assert.equal(await bridge.recordTurn(ROUND), null);
  assert.equal(bridge.enabled(), false);
  assert.equal(logger.lines.warn.length, 1);
  assert.match(logger.lines.warn[0], /agents service is unavailable/);
  assert.deepEqual(bridge.list(), []);
});

test('never throws when agent creation fails, warns once, and recovers', async (t) => {
  let fail = true;
  const agents = createFakeAgents({
    create: async () => {
      if (fail) {
        fail = false;
        throw new Error('create boom');
      }
      return undefined;
    },
  });
  const { bridge, logger } = await setupBridge(t, { agents });

  assert.equal(await bridge.recordTurn(ROUND), null);
  assert.equal(bridge.enabled(), true, 'a create failure does not disable the bridge');
  assert.equal(logger.lines.warn.length, 1);
  assert.match(logger.lines.warn[0], /conversation create failed: create boom/);

  assert.deepEqual(await bridge.recordTurn(ROUND), { sessionId: 'translation-tr_test', turn: 1 });
  assert.equal(logger.lines.warn.length, 1, 'later successes add no warnings');
});

test('never throws when a session append fails', async (t) => {
  const agents = createFakeAgents({
    create: async () => ({
      agent: {
        session: {
          append() {
            throw new Error('append boom');
          },
        },
        inbox: { clear() {} },
      },
      dispose() {},
    }),
  });
  const { bridge, logger } = await setupBridge(t, { agents });
  assert.equal(await bridge.recordTurn(ROUND), null);
  assert.equal(logger.lines.warn.length, 1);
  assert.match(logger.lines.warn[0], /record failed: append boom/);
  const [row] = bridge.list();
  assert.equal(row.turns, 0, 'the session stays live even when the round was dropped');
});

test('tolerates a throwing sessionTitle service and a throwing logger', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const agents = createFakeAgents();
  const bridge = createConversationBridge({
    ctx: createFakeCtx({
      agents,
      sessionTitle: {
        rename() {
          throw new Error('rename boom');
        },
      },
    }),
    dataDir: dir,
    logger: { warn() { throw new Error('logger boom'); } },
  });
  t.after(() => bridge.dispose());
  assert.deepEqual(await bridge.recordTurn(ROUND), { sessionId: 'translation-tr_test', turn: 1 });
});

test('dedupes concurrent creation of one turn id into a single native session', async (t) => {
  const { bridge, agents } = await setupBridge(t);
  const results = await Promise.all([
    bridge.recordTurn({ ...ROUND, texts: ['a'], translations: ['甲'] }),
    bridge.recordTurn({ ...ROUND, texts: ['b'], translations: ['乙'] }),
  ]);
  assert.equal(agents.state.created.length, 1, 'a run never creates two sessions for one turn id');
  assert.equal(new Set(results.map((result) => result.sessionId)).size, 1);
  assert.deepEqual(results.map((result) => result.turn).sort((left, right) => left - right), [1, 2]);
  const turnStarts = agents.state.appended
    .filter((entry) => entry.type === 'turn/start')
    .map((entry) => entry.payload.turn)
    .sort((left, right) => left - right);
  assert.deepEqual(turnStarts, [1, 2]);
  const [row] = bridge.list();
  assert.equal(row.turns, 2);
});

test('caps live conversations at 24 and disposes the least recently used', async (t) => {
  let tick = 0;
  const { bridge, agents } = await setupBridge(t, { now: () => (tick += 1) });
  const sessionIds = [];
  for (let index = 0; index < MAX_LIVE_CONVERSATIONS + 1; index += 1) {
    const recorded = await bridge.recordTurn({ ...ROUND, turnId: `tr_lru_${index}` });
    sessionIds.push(recorded.sessionId);
  }
  assert.equal(agents.state.created.length, MAX_LIVE_CONVERSATIONS + 1);
  assert.equal(bridge.list().length, MAX_LIVE_CONVERSATIONS);

  await flush();
  assert.deepEqual(agents.state.disposed, [sessionIds[0]], 'the oldest live conversation is disposed');
  assert.ok(!bridge.list().some((row) => row.turnId === 'tr_lru_0'));
  assert.ok(bridge.list().some((row) => row.turnId === `tr_lru_${MAX_LIVE_CONVERSATIONS}`));
});

test('disposes an idle conversation after 15 minutes with an unref timer', async (t) => {
  const { bridge, agents } = await setupBridge(t);
  const { timers, restore } = patchTimers(t);
  try {
    await bridge.recordTurn(ROUND);
    await bridge.recordTurn(ROUND);
  } finally {
    restore();
  }
  assert.equal(timers.length, 3, 'creation and each recorded round arm/reset the idle timer');
  for (const timer of timers) {
    assert.equal(timer.ms, IDLE_DISPOSE_MS);
    assert.equal(timer.ms, 15 * 60 * 1000);
    assert.equal(timer.unrefCalled, true, 'the idle timer never keeps the host alive');
  }
  assert.equal(timers[0].cleared, true);
  assert.equal(timers[1].cleared, true);
  assert.equal(timers[2].cleared, false);

  timers[2].callback();
  await flush();
  assert.deepEqual(agents.state.disposed, ['translation-tr_test']);
  assert.deepEqual(bridge.list(), []);
});

test('disposes every live conversation on bridge dispose', async (t) => {
  const { bridge, agents } = await setupBridge(t);
  await bridge.recordTurn({ ...ROUND, turnId: 'tr_one' });
  await bridge.recordTurn({ ...ROUND, turnId: 'tr_two' });
  assert.equal(bridge.list().length, 2);

  bridge.dispose();
  await flush();
  assert.deepEqual(agents.state.disposed.sort(), ['translation-tr_one', 'translation-tr_two']);
  assert.deepEqual(bridge.list(), []);
  assert.equal(bridge.enabled(), false);

  bridge.dispose();
  await flush();
  assert.equal(agents.state.disposed.length, 2, 'dispose is idempotent');
  assert.equal(await bridge.recordTurn(ROUND), null, 'a disposed bridge records nothing');
});


test('groups conversations under the「dsh翻译记录」workspace (create once, attach each new session)', async (t) => {
  const workspaceRegistry = createFakeWorkspaceRegistry();
  const { bridge, dir } = await setupBridge(t, { workspaceRegistry });
  await bridge.recordTurn({ ...ROUND, turnId: 'tr_ws_one' });
  await bridge.recordTurn({ ...ROUND, turnId: 'tr_ws_one', stepIndex: 1, texts: ['again'] });
  await bridge.recordTurn({ ...ROUND, turnId: 'tr_ws_two' });

  assert.equal(workspaceRegistry.state.createCalls.length, 1, 'workspace create is idempotent per bridge');
  assert.deepEqual(workspaceRegistry.state.createCalls[0], { path: join(dir, 'conversations'), title: TRANSLATION_WORKSPACE_TITLE });
  assert.deepEqual(workspaceRegistry.state.attached, ['translation-tr_ws_one', 'translation-tr_ws_two']);
  assert.equal(TRANSLATION_WORKSPACE_TITLE, 'dsh翻译记录');
});

test('workspace creation attaches persisted translation sessions that predate the group', async (t) => {
  const workspaceRegistry = createFakeWorkspaceRegistry();
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const bridge = createConversationBridge({
    ctx: createFakeCtx({
      agents: createFakeAgents(),
      workspaceRegistry,
      sessionPersistence: {
        async list() {
          return [
            { header: { id: 'translation-tr_old_1', cwd: join(dir, 'conversations'), createdAt: 1 } },
            { header: { id: 'translation-tr_old_2', cwd: join(dir, 'conversations'), createdAt: 2 } },
            { header: { id: 'session-foreign', cwd: '/tmp/elsewhere', createdAt: 3 } },
          ];
        },
      },
    }),
    dataDir: dir,
    logger: createFakeLogger(),
  });
  t.after(() => bridge.dispose());

  await bridge.ensureWorkspace();
  assert.deepEqual(workspaceRegistry.state.attached, ['translation-tr_old_1', 'translation-tr_old_2'], 'oldest attaches first so newest sits on top; foreign cwd is skipped');
});

test('clearRecords archives translation sessions, detaches and deletes the workspace', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const workspaceRegistry = createFakeWorkspaceRegistry();
  const bridge = createConversationBridge({
    ctx: createFakeCtx({
      agents: createFakeAgents(),
      workspaceRegistry,
      sessionPersistence: {
        async list() {
          return [{ header: { id: 'translation-tr_persisted', cwd: join(dir, 'conversations'), createdAt: 1 } }];
        },
      },
    }),
    dataDir: dir,
    logger: createFakeLogger(),
  });
  t.after(() => bridge.dispose());
  await bridge.recordTurn({ ...ROUND, turnId: 'tr_live' });

  const result = await bridge.clearRecords();
  assert.deepEqual(result, { sessions: 2, archived: 2 });
  assert.deepEqual(
    workspaceRegistry.state.archived.map((entry) => entry.sessionId).sort(),
    ['translation-tr_live', 'translation-tr_persisted'],
  );
  assert.ok(workspaceRegistry.state.archived.every((entry) => entry.options.stopActivity === true));
  assert.deepEqual(workspaceRegistry.state.deleted, ['ws-translations']);
  assert.deepEqual(workspaceRegistry.state.detached.sort(), ['translation-tr_live', 'translation-tr_persisted']);
  assert.equal(bridge.list().length, 0, 'live conversations are disposed');

  await bridge.recordTurn({ ...ROUND, turnId: 'tr_after_clear' });
  assert.equal(workspaceRegistry.state.createCalls.length, 2, 'the workspace is recreated on the next translation');
});

test('a failing workspace registry never blocks conversation recording', async (t) => {
  const workspaceRegistry = createFakeWorkspaceRegistry({
    async create() {
      throw new Error('workspace storage unavailable');
    },
  });
  const { bridge, agents, logger } = await setupBridge(t, { workspaceRegistry });
  const recorded = await bridge.recordTurn(ROUND);
  assert.deepEqual(recorded, { sessionId: 'translation-tr_test', turn: 1 }, 'conversation still records');
  assert.equal(agents.state.appended.length, 6);
  assert.equal(workspaceRegistry.state.attached.length, 0);
  assert.equal(logger.lines.warn.filter((message) => message.includes('workspace create failed')).length, 1, 'warns once');
});

test('a host without workspaceRegistry keeps recording ledger-only conversations', async (t) => {
  const { bridge, agents } = await setupBridge(t);
  assert.equal(await bridge.ensureWorkspace(), null, 'no workspace service means no group');
  const recorded = await bridge.recordTurn(ROUND);
  assert.deepEqual(recorded, { sessionId: 'translation-tr_test', turn: 1 });
  assert.equal(agents.state.appended.length, 6);
});

test('attach failure for one historical session is tolerated', async (t) => {
  let failOnce = true;
  const workspaceRegistry = createFakeWorkspaceRegistry({
    async attachSession(sessionId) {
      if (failOnce && sessionId === 'translation-tr_old_1') {
        failOnce = false;
        throw new Error('session header unavailable');
      }
    },
  });
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const bridge = createConversationBridge({
    ctx: createFakeCtx({
      agents: createFakeAgents(),
      workspaceRegistry,
      sessionPersistence: {
        async list() {
          return [
            { header: { id: 'translation-tr_old_1', cwd: join(dir, 'conversations'), createdAt: 1 } },
            { header: { id: 'translation-tr_old_2', cwd: join(dir, 'conversations'), createdAt: 2 } },
          ];
        },
      },
    }),
    dataDir: dir,
    logger: createFakeLogger(),
  });
  t.after(() => bridge.dispose());
  const workspace = await bridge.ensureWorkspace();
  assert.notEqual(workspace, null);
  assert.deepEqual(workspaceRegistry.state.attached, ['translation-tr_old_1', 'translation-tr_old_2'], 'the failing attach never blocks the next one');
});


test('a newly created translation workspace is appended instead of becoming DSH default', async (t) => {
  const workspaceRegistry = createFakeWorkspaceRegistry();
  const { bridge } = await setupBridge(t, { workspaceRegistry });
  await bridge.ensureWorkspace();
  assert.deepEqual(workspaceRegistry.state.reordered, [{ id: 'ws-translations', beforeId: undefined }], 'create then append to the end of the order');
});

test('an existing translation workspace keeps the user order (no reorder attempt)', async (t) => {
  const existing = {
    id: 'ws-existing',
    path: '/tmp/kept',
    title: 'dsh翻译记录',
    sessionIds: [],
    async attachSession() {},
    async setTitle() {},
    async insertSessionBefore() {},
    async detachSession() {},
    async status() { return 'ok'; },
  };
  const workspaceRegistry = createFakeWorkspaceRegistry({ existing });
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  // resolveByPath only matches the workspace path, so build one rooted at the bridge cwd.
  existing.path = join(dir, 'conversations');
  const bridge = createConversationBridge({
    ctx: createFakeCtx({ agents: createFakeAgents(), workspaceRegistry }),
    dataDir: dir,
    logger: createFakeLogger(),
  });
  t.after(() => bridge.dispose());
  const workspace = await bridge.ensureWorkspace();
  assert.equal(workspace, existing, 'the existing entity is reused');
  assert.equal(workspaceRegistry.state.createCalls.length, 0, 'no duplicate workspace is created');
  assert.deepEqual(workspaceRegistry.state.reordered, [], 'user ordering is left alone');
});


test('a translation workspace stuck in the first slot is moved to the end on load', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const path = join(dir, 'conversations');
  const reordered = [];
  const entity = {
    id: 'ws-translations',
    path,
    title: TRANSLATION_WORKSPACE_TITLE,
    sessionIds: [],
    async attachSession() {},
    async setTitle() {},
    async insertSessionBefore() {},
    async detachSession() {},
    async status() { return 'ok'; },
  };
  const other = { id: 'ws-workspace', path: '/tmp/workspace-other', title: 'workspace', sessionIds: [] };
  const bridge = createConversationBridge({
    ctx: {
      get(name) {
        if (name === 'agents') return createFakeAgents();
        if (name === 'workspaceRegistry') {
          return {
            async resolveByPath(candidate) { return candidate === path ? entity : undefined; },
            async create() { return entity; },
            list() { return [entity, other]; },
            async insertBefore(id, beforeId) { reordered.push({ id, beforeId }); return []; },
          };
        }
        return undefined;
      },
    },
    dataDir: dir,
    logger: createFakeLogger(),
  });
  t.after(() => bridge.dispose());
  await bridge.ensureWorkspace();
  assert.deepEqual(reordered, [{ id: 'ws-translations', beforeId: undefined }], 'the default new-conversation directory stays the user workspace');
});


test('lookup rounds never write dictionary metadata into the DSH session', async (t) => {
  const { bridge, agents } = await setupBridge(t);
  await bridge.recordTurn({
    ...ROUND,
    kind: 'lookup',
    texts: undefined,
    text: 'immersive',
    translation: '沉浸式的',
    dictionary: {
      word: 'immersive',
      phonetic: '/ɪˈmɜːsɪv/',
      audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/immersive.mp3',
      meanings: [{ partOfSpeech: 'adjective', definitions: ['deeply engaging'] }],
    },
  });
  const recorded = JSON.stringify(agents.state.appended);
  assert.match(recorded, /沉浸式的/, 'the model translation is recorded');
  assert.equal(recorded.includes('dictionaryapi.dev'), false, 'dictionary audio URL is not recorded');
  assert.equal(recorded.includes('ɪˈmɜːsɪv'), false, 'dictionary phonetics are not recorded');
  assert.equal(recorded.includes('deeply engaging'), false, 'dictionary definitions are not recorded');
});
