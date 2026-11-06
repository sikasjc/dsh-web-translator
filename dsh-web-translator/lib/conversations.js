/**
 * Translation conversation bridge: record every translation model round as a
 * real DSH conversation turn so DSH's native Conversation / Trajectory / Stats
 * views can display it (DESIGN-CONVERSATIONS.md).
 *
 * One translation action (`turnId` from the browser extension, or one lookup)
 * owns one hidden DSH Session. Every model request inside it appends one
 * `user/message` + `assistant/message` round (a native Turn). The session is a
 * plugin-created Agent (via `ctx.agents.create`) so it is persisted by the
 * agent lifecycle and openable from the client with
 * `uiWorkspace.openSession(sessionId)` — it is intentionally NOT listed in any
 * workspace.
 *
 * Failure policy: this bridge must never fail a translation. Any error while
 * creating the agent or appending events is logged once and reported as
 * `null`; the caller keeps recording into the plugin's own usage ledger.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDataDir } from './store.js';

/** Session id prefix for translation conversations (kept path-safe). */
export const SESSION_ID_PREFIX = 'translation-';
/** Maximum conversation-session id length handed to DSH (mirrors LIMITS.sessionIdChars). */
const SESSION_ID_MAX = 96;
/** Maximum number of live translation conversations before the oldest is disposed. */
export const MAX_LIVE_CONVERSATIONS = 24;
/** Idle time after which a live conversation agent is disposed (session stays persisted). */
export const IDLE_DISPOSE_MS = 15 * 60 * 1000;
/** DSH workspace title that groups every translation conversation in the sidebar. */
export const TRANSLATION_WORKSPACE_TITLE = 'dsh翻译记录';
/** Session title cap (readable in the DSH sidebar). */
const TITLE_MAX = 60;
/** Prefix of the session title, per conversation kind (DESIGN-CONVERSATIONS §1). */
const TITLE_PREFIX = Object.freeze({ translate: '翻译', lookup: '翻译查词' });

/** @returns {string} a fresh message id. */
function newMessageId() {
  return `msg_${randomBytes(8).toString('hex')}`;
}

/**
 * Deterministic short suffix used when a turn id sanitizes to nothing, so the
 * same turn id always maps to the same session (cold resume friendly).
 * @param {string} turnId - raw turn id.
 * @returns {string}
 */
function stableSuffix(turnId) {
  return createHash('sha1').update(String(turnId ?? '')).digest('hex').slice(0, 12);
}

/**
 * Deterministic, path-safe DSH session id for one translation turn id.
 * Illegal characters collapse to `-`; the id is always ≤ LIMITS.sessionIdChars.
 * @param {string} turnId - extension turn id (`tr_…` / `lk_…`).
 * @returns {string}
 */
export function conversationSessionId(turnId) {
  const raw = String(turnId ?? '').trim();
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, SESSION_ID_MAX - SESSION_ID_PREFIX.length);
  return SESSION_ID_PREFIX + (safe.length > 0 ? safe : stableSuffix(raw));
}

/**
 * Persistent grouping directory for the native conversation sessions: lives
 * under the plugin data dir (DESIGN-CONVERSATIONS §1/§2).
 * @param {string} dataDir - resolved plugin data directory.
 * @returns {string}
 */
function conversationCwd(dataDir) {
  return join(dataDir, 'conversations');
}

/** @returns {string | undefined} trimmed non-empty string. */
function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Compose the readable user-message text of one translation round.
 * @param {object} input - request description.
 * @returns {string}
 */
export function composeUserText(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const language = nonEmptyText(source.targetLanguage) ?? '目标语言';
  const texts = Array.isArray(source.texts) ? source.texts.filter((text) => typeof text === 'string' && text.length > 0) : [];
  if (source.kind === 'lookup') {
    const text = typeof source.text === 'string' ? source.text : texts[0] ?? '';
    const context = nonEmptyText(source.context);
    return `查词（${language}）：${text}${context === undefined ? '' : `\n上下文：${context}`}`;
  }
  if (texts.length === 1) return `将以下内容翻译为 ${language}：\n${texts[0]}`;
  const lines = texts.map((text, index) => `${index + 1}. ${text}`);
  return `将以下 ${texts.length} 段内容翻译为 ${language}：\n${lines.join('\n')}`;
}

/**
 * Compose the readable assistant-message text of one translation round.
 * @param {object} input - translation result description.
 * @returns {string}
 */
export function composeAssistantText(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  if (source.kind === 'lookup') {
    const translation = typeof source.translation === 'string' ? source.translation : '';
    return translation.length > 0 ? translation : '（无译文）';
  }
  const translations = Array.isArray(source.translations) ? source.translations : [];
  if (translations.length === 0) return '（无译文）';
  if (translations.length === 1) return translations[0];
  return translations.map((text, index) => `${index + 1}. ${text}`).join('\n');
}

/**
 * Compose the session title: `翻译 · <页面标题|站点>` or `翻译查词 · <…>`
 * (DESIGN-CONVERSATIONS §1). Falls back to the bare prefix when neither the
 * page title nor the site is known.
 * @param {object} input - creation metadata.
 * @returns {string}
 */
export function composeTitle(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const kind = source.kind === 'lookup' ? 'lookup' : 'translate';
  const base = nonEmptyText(source.sourceTitle) ?? nonEmptyText(source.site);
  const prefix = TITLE_PREFIX[kind];
  return (base === undefined ? prefix : `${prefix} · ${base}`).slice(0, TITLE_MAX);
}

/**
 * Normalize one provider usage object for the session event: the four DSH
 * buckets, with cache counters omitted when zero (DESIGN-CONVERSATIONS §2).
 * @param {unknown} usage - `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`.
 * @returns {object | undefined}
 */
export function normalizeSessionUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined;
  const count = (value) => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);
  const event = {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
  };
  const cacheRead = count(usage.cacheReadTokens);
  const cacheWrite = count(usage.cacheWriteTokens);
  if (cacheRead > 0) event.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) event.cacheWriteTokens = cacheWrite;
  return event;
}

/**
 * Create the conversation bridge.
 * @param {object} options - host seams.
 * @param {object} [options.ctx] - host context (services resolved lazily).
 * @param {string} [options.dataDir] - plugin data directory (conversation cwd lives below it).
 * @param {object} [options.logger] - logger with `warn`/`debug`.
 * @param {() => number} [options.now] - clock.
 * @returns {{recordTurn: Function, list: Function, dispose: Function, enabled: Function,
 *   cwd: Function}}
 */
export function createConversationBridge({ ctx, dataDir, logger, now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const directory = typeof dataDir === 'string' && dataDir.trim().length > 0 ? dataDir.trim() : resolveDataDir();
  const cwd = conversationCwd(directory);
  /** Live conversations keyed by turn id. */
  const conversations = new Map();
  /** In-flight session creations keyed by turn id (concurrent-batch dedupe). */
  const pending = new Map();
  let agentsService;
  let titleService;
  let workspaceRegistry;
  let persistenceService;
  /** Cached workspace entity for the translation conversation group. */
  let workspace = null;
  /** In-flight workspace creation (idempotence for concurrent rounds). */
  let workspacePromise = null;
  /** True once the host proved it has no usable workspace registry. */
  let workspaceDisabled = false;
  let disabled = false;
  let disposedAll = false;
  let warned = false;

  /** @param {string} message - diagnostic line (logged once per bridge). */
  function warn(message) {
    if (warned) return;
    warned = true;
    try {
      logger?.warn?.(`[dsh-web-translator] conversations: ${message}`);
    } catch {
      // Diagnostics only.
    }
  }

  /** Resolve optional host services once, tolerating their absence (tests). */
  function services() {
    try {
      if (agentsService === undefined) agentsService = ctx?.get?.('agents') ?? null;
      if (titleService === undefined) titleService = ctx?.get?.('sessionTitle') ?? null;
      if (workspaceRegistry === undefined) workspaceRegistry = ctx?.get?.('workspaceRegistry') ?? null;
      if (persistenceService === undefined) persistenceService = ctx?.get?.('sessionPersistence') ?? null;
    } catch {
      // Optional services only.
    }
    return { agents: agentsService, titles: titleService, workspaces: workspaceRegistry, persistence: persistenceService };
  }

  /** @param {unknown} handle - value returned by `agents.create`. */
  function handleDisposeOf(handle) {
    try {
      if (handle !== null && typeof handle === 'object' && typeof handle.dispose === 'function') return handle;
      const agent = handle?.agent;
      if (agent !== null && typeof agent === 'object' && typeof agent.dispose === 'function') return agent;
    } catch {
      // Optional host seam.
    }
    return null;
  }

  /** Dispose one live conversation agent (its session stays persisted). */
  function disposeConversation(conversation) {
    if (conversation.disposed) return;
    conversation.disposed = true;
    if (conversation.timer !== null) {
      try {
        clearTimeout(conversation.timer);
      } catch {
        // A broken timer seam must not block disposal.
      }
      conversation.timer = null;
    }
    if (conversations.get(conversation.turnId) === conversation) conversations.delete(conversation.turnId);
    const disposable = handleDisposeOf(conversation.handle);
    if (disposable !== null) {
      Promise.resolve()
        .then(() => disposable.dispose())
        .catch((error) => warn(`dispose failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /** Release the least recently used live conversation beyond the cap. */
  function trimLiveConversations() {
    while (conversations.size > MAX_LIVE_CONVERSATIONS) {
      let oldest = null;
      for (const conversation of conversations.values()) {
        if (oldest === null || conversation.lastAt < oldest.lastAt) oldest = conversation;
      }
      if (oldest === null) return;
      const sizeBefore = conversations.size;
      disposeConversation(oldest);
      if (conversations.size >= sizeBefore) {
        // Defensive: never spin forever on a conversation that could not leave
        // the map (e.g. a replaced entry with the same turn id).
        conversations.delete(oldest.turnId);
      }
    }
  }

  /** Reset the idle-disposal timer of one conversation. */
  function touchConversation(conversation) {
    conversation.lastAt = clock();
    if (conversation.timer !== null) {
      try {
        clearTimeout(conversation.timer);
      } catch {
        // Optional timer seam.
      }
      conversation.timer = null;
    }
    let timer;
    try {
      timer = setTimeout(() => {
        conversation.timer = null;
        disposeConversation(conversation);
      }, IDLE_DISPOSE_MS);
    } catch {
      // Timers unavailable (unlikely): the session simply stays live.
      return;
    }
    if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    conversation.timer = timer;
  }

  /**
   * Canonical absolute path used for workspace membership validation.
   * @param {string} path - candidate path.
   * @returns {Promise<string | null>}
   */
  async function canonicalPath(path) {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  }

  /**
   * Attach every persisted translation session (cwd inside the conversation
   * directory) to the workspace so history predating the workspace appears in
   * the group immediately. Best-effort: one bad header never blocks the rest.
   * @param {object} targetWorkspace - `workspaceRegistry.create()` result.
   * @returns {Promise<void>}
   */
  async function attachHistoricalSessions(targetWorkspace) {
    if (targetWorkspace === null || typeof targetWorkspace?.attachSession !== 'function') return;
    const { persistence } = services();
    if (persistence === null || typeof persistence?.list !== 'function') return;
    const canonical = await canonicalPath(cwd);
    if (canonical === null) return;
    let snapshots;
    try {
      snapshots = await persistence.list();
    } catch (error) {
      warn(`workspace history list failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const candidates = [];
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      const header = snapshot !== null && typeof snapshot === 'object' ? snapshot.header ?? snapshot : null;
      if (header === null || typeof header !== 'object') continue;
      if (typeof header.cwd !== 'string' || typeof header.id !== 'string' || header.id.length === 0) continue;
      if ((await canonicalPath(header.cwd)) !== canonical) continue;
      candidates.push(header);
    }
    // Attaching prepends, so attach oldest first to keep newest-first order.
    candidates.sort((left, right) => (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0));
    let attached = 0;
    for (const header of candidates) {
      try {
        await targetWorkspace.attachSession(header.id);
        attached += 1;
      } catch (error) {
        warn(`workspace attach failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      logger?.debug?.(`[dsh-web-translator] conversations: workspace "${TRANSLATION_WORKSPACE_TITLE}" holds ${attached} historical sessions`);
    } catch {
      // Diagnostics only.
    }
  }

  /**
   * Create (or reuse) the sidebar workspace that groups translation
   * conversations, then attach persisted history. Idempotent and lazy: the
   * group only appears once the feature is actually used (or history exists,
   * see the eager call in api.js). Never throws.
   * @returns {Promise<object | null>} the workspace entity, or null when the
   *   host has no workspace registry.
   */
  async function ensureWorkspace() {
    if (workspace !== null) return workspace;
    if (workspaceDisabled) return null;
    if (workspacePromise !== null) return workspacePromise;
    const { workspaces } = services();
    if (workspaces === null || typeof workspaces?.create !== 'function') {
      workspaceDisabled = true;
      return null;
    }
    workspacePromise = (async () => {
      try {
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        // Never steal the first slot: a freshly created workspace would become
        // DSH's default "new conversation" directory. Append it to the end of
        // the order instead (an existing group keeps the user's own order).
        const existing = typeof workspaces.resolveByPath === 'function'
          ? await workspaces.resolveByPath(cwd).catch(() => undefined)
          : undefined;
        const entity = existing ?? await workspaces.create(cwd, TRANSLATION_WORKSPACE_TITLE);
        workspace = entity;
        if (entity !== null && typeof entity === 'object' && typeof workspaces.insertBefore === 'function') {
          let moveToEnd = existing === undefined;
          if (!moveToEnd) {
            // Repair the first-slot state left by versions that created the group
            // without ordering it: DSH treats the first workspace as the default
            // directory for new conversations, which must stay the user's own.
            try {
              const order = typeof workspaces.list === 'function' ? workspaces.list() : [];
              moveToEnd = order.length > 1 && order[0] !== null && typeof order[0] === 'object' && order[0].id === entity.id;
            } catch {
              // Order is optional for this repair.
            }
          }
          if (moveToEnd) {
            try {
              await workspaces.insertBefore(entity.id);
            } catch (error) {
              warn(`workspace reorder failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        await attachHistoricalSessions(entity);
        return entity;
      } catch (error) {
        warn(`workspace create failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        workspacePromise = null;
      }
    })();
    return workspacePromise;
  }

  /**
   * Attach one live conversation session to the workspace so it shows in the
   * sidebar group instead of the ungrouped list. Never throws.
   * @param {string} sessionId - conversation session id.
   * @returns {Promise<void>}
   */
  async function attachWorkspaceSession(sessionId) {
    const entity = await ensureWorkspace();
    if (entity === null || typeof entity?.attachSession !== 'function') return;
    try {
      await entity.attachSession(sessionId);
    } catch (error) {
      warn(`workspace attach failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create the live translation conversation for one turn id.
   * @param {string} turnId - trimmed turn id.
   * @param {object} info - creation metadata.
   * @returns {Promise<object | null>}
   */
  async function createConversation(turnId, info) {
    const { agents, titles } = services();
    if (agents === null || typeof agents?.create !== 'function') {
      disabled = true;
      warn('the agents service is unavailable; translation conversations are ledger-only');
      return null;
    }
    try {
      await mkdir(cwd, { recursive: true, mode: 0o700 });
    } catch {
      // A missing directory only removes the ability to group persisted logs by cwd.
    }
    const sessionId = conversationSessionId(turnId);
    const agentOptions = {};
    if (typeof info.provider === 'string' && info.provider.length > 0) agentOptions.provider = info.provider;
    if (typeof info.model === 'string' && info.model.length > 0) agentOptions.model = info.model;
    if (typeof info.reasoningEffort === 'string' && info.reasoningEffort.length > 0) {
      agentOptions.reasoningEffort = info.reasoningEffort;
    }
    // Group every conversation under the dedicated workspace before the
    // session is created, so the new session attaches on first record.
    await ensureWorkspace();
    let handle;
    try {
      handle = await agents.create({
        sessionId,
        meta: { cwd },
        agentOptions,
      });
    } catch (error) {
      warn(`conversation create failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (disposedAll) {
      // The bridge was disposed while the agent was being created: release it.
      const disposable = handleDisposeOf(handle);
      if (disposable !== null) {
        Promise.resolve().then(() => disposable.dispose()).catch(() => {});
      }
      return null;
    }
    const agent = handle !== null && typeof handle === 'object' ? handle.agent ?? handle : null;
    const conversation = {
      turnId,
      sessionId,
      handle,
      session: agent?.session ?? null,
      turns: 0,
      createdAt: clock(),
      lastAt: clock(),
      timer: null,
      disposed: false,
      title: composeTitle(info),
    };
    try {
      agent?.inbox?.clear?.();
    } catch {
      // Optional seam.
    }
    try {
      titles?.rename?.(conversation.session, conversation.title);
    } catch {
      // Title pinning is best-effort.
    }
    conversations.set(turnId, conversation);
    void attachWorkspaceSession(sessionId);
    trimLiveConversations();
    touchConversation(conversation);
    return conversation;
  }

  /**
   * Return the live conversation for one turn id, creating it once. Concurrent
   * batches of the same run share one in-flight creation promise, so a run can
   * never create two native sessions for the same turn id.
   * @param {string} turnId - trimmed turn id.
   * @param {object} info - creation metadata.
   * @returns {Promise<object | null>}
   */
  async function ensureConversation(turnId, info) {
    if (disabled || disposedAll) return null;
    const existing = conversations.get(turnId);
    if (existing !== undefined) return existing;
    const inflight = pending.get(turnId);
    if (inflight !== undefined) return inflight;
    const promise = createConversation(turnId, info).finally(() => {
      pending.delete(turnId);
    });
    pending.set(turnId, promise);
    return promise;
  }

  /**
   * Append the native events of one conversation turn: user message, optional
   * assistant reply, step/turn end. The whole append block is synchronous so
   * concurrent requests sharing a session can never interleave two turns.
   * @param {object} conversation - live conversation.
   * @param {object} input - one round description.
   * @returns {{sessionId: string, turn: number}}
   */
  function appendRound(conversation, input) {
    const session = conversation.session;
    const turn = conversation.turns + 1;
    const provider = typeof input.provider === 'string' ? input.provider : '';
    const model = typeof input.model === 'string' ? input.model : '';
    session.append('turn/start', { turn });
    session.append('step/start', { turn, step: 1 });
    session.append(
      'user/message',
      {
        role: 'user',
        id: newMessageId(),
        content: [{ type: 'text', text: composeUserText(input) }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' },
    );
    if (input.ok === true) {
      const assistantText = composeAssistantText(input);
      const usage = normalizeSessionUsage(input.usage);
      const event = {
        turn,
        step: 1,
        message: {
          role: 'assistant',
          id: newMessageId(),
          content: [{ type: 'text', text: assistantText }],
          source: { kind: 'model', provider, model },
        },
        stream: [{ type: 'text-chunks', time0: clock(), index: 0, dt: [0], texts: [assistantText] }],
      };
      if (usage !== undefined) event.usage = usage;
      session.append('assistant/message', event, { surfaceOp: 'append' });
      session.append('step/end', { turn, step: 1 });
      session.append('turn/end', { turn, reason: { kind: 'completed' } });
    } else {
      const error = input.error !== null && typeof input.error === 'object' ? input.error : {};
      session.append('step/end', { turn, step: 1 });
      session.append('turn/end', {
        turn,
        reason: {
          kind: 'error',
          error: {
            message: typeof error.message === 'string' && error.message.length > 0 ? error.message.slice(0, 300) : 'translation failed',
            code: typeof error.code === 'string' && error.code.length > 0 ? error.code : 'MODEL_FAILED',
          },
        },
      });
    }
    conversation.turns = turn;
    touchConversation(conversation);
    return { sessionId: conversation.sessionId, turn };
  }

  /**
   * Append one native conversation turn (user message + assistant reply) for a
   * completed or failed translation request. Never throws.
   * @param {object} input - one round description.
   * @returns {Promise<{sessionId: string, turn: number} | null>}
   */
  async function recordTurn(input) {
    if (input === null || typeof input !== 'object') return null;
    const turnId = typeof input.turnId === 'string' ? input.turnId.trim() : '';
    if (turnId.length === 0) return null;
    try {
      const conversation = await ensureConversation(turnId, input);
      if (conversation === null || conversation.session === null) return null;
      return appendRound(conversation, input);
    } catch (error) {
      warn(`record failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * List live translation conversations (newest first) for the plugin page.
   * @returns {object[]}
   */
  function list() {
    const rows = [];
    for (const conversation of conversations.values()) {
      rows.push({
        turnId: conversation.turnId,
        sessionId: conversation.sessionId,
        title: conversation.title,
        turns: conversation.turns,
        createdAt: conversation.createdAt,
        lastAt: conversation.lastAt,
        live: !conversation.disposed,
      });
    }
    rows.sort((left, right) => right.lastAt - left.lastAt || right.createdAt - left.createdAt);
    return rows;
  }

  /** Dispose every live conversation (plugin unload). */
  function dispose() {
    disposedAll = true;
    for (const conversation of [...conversations.values()]) disposeConversation(conversation);
  }

  return {
    recordTurn,
    list,
    ensureWorkspace,
    dispose,
    enabled: () => !disabled && !disposedAll,
    /** @returns {string} the conversation cwd used for stored sessions. */
    cwd: () => cwd,
  };
}
