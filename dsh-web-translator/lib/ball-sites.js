/**
 * 「悬浮球不展示」域名列表（DESIGN-BALL §1）。
 *
 * `ball-sites.json` 保存 `{version:1, sites:string[], updatedAt:number}`；
 * 域名统一小写、去掉协议/路径/端口/末尾点与 `www.` 前缀，精确匹配。
 */
import { apiError } from './errors.js';

/** Persisted document version. */
export const BALL_SITES_VERSION = 1;
/** Upper bound keeps the list small enough for the extension to load per page. */
export const MAX_BALL_SITES = 200;

/**
 * Normalize one hostname (accepts a hostname, URL, or URL-ish string).
 * @param {unknown} value - raw domain / URL.
 * @returns {string} normalized hostname, or '' when invalid.
 */
export function normalizeBallSite(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim().toLowerCase();
  if (!raw) return '';
  try {
    if (raw.includes('://')) {
      raw = new URL(raw).hostname;
    } else {
      raw = raw.split('/')[0].split('?')[0].split('#')[0];
      if (raw.startsWith('[')) {
        raw = raw.slice(0, raw.indexOf(']') + 1);
      } else {
        raw = raw.replace(/:\d+$/, '');
      }
    }
  } catch {
    return '';
  }
  raw = raw.replace(/\.$/, '').replace(/^www\./, '');
  if (!raw || raw.length > 253) return '';
  if (raw === 'localhost') return raw;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return raw;
  const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const labels = raw.split('.');
  if (labels.length === 0 || labels.some((label) => !labelPattern.test(label))) return '';
  return raw;
}

/**
 * Build the domain-exclusion service over one JSON store.
 * @param {{store: {read: Function, mutate: Function}, now?: () => number}} options
 * @returns {{list: Function, add: Function, remove: Function}}
 */
export function createBallSitesService({ store, now = Date.now } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.mutate !== 'function') {
    throw new TypeError('createBallSitesService requires a JSON store');
  }
  const clock = typeof now === 'function' ? now : () => Date.now();

  /** @param {object} doc - persisted document. */
  function snapshot(doc) {
    const sites = Array.isArray(doc?.sites)
      ? doc.sites.filter((site) => typeof site === 'string' && site.length > 0).slice(0, MAX_BALL_SITES)
      : [];
    return { sites, updatedAt: Number(doc?.updatedAt) || 0 };
  }

  async function list() {
    return snapshot(await store.read());
  }

  async function add(body) {
    const site = normalizeBallSite(body && typeof body === 'object' ? body.domain : body);
    if (!site) throw apiError('BAD_REQUEST', 'domain must be a valid hostname');
    return store.mutate((doc) => {
      if (!doc || typeof doc !== 'object') doc = {};
      const sites = Array.isArray(doc.sites) ? doc.sites.filter((item) => typeof item === 'string' && item) : [];
      const index = sites.indexOf(site);
      if (index < 0) {
        if (sites.length >= MAX_BALL_SITES) {
          throw apiError('BAD_REQUEST', `at most ${MAX_BALL_SITES} domains can be excluded`);
        }
        sites.push(site);
      }
      doc.version = BALL_SITES_VERSION;
      doc.sites = sites;
      doc.updatedAt = clock();
      return { ...snapshot(doc), site, added: index < 0 };
    });
  }

  async function remove(body) {
    const site = normalizeBallSite(body && typeof body === 'object' ? body.domain : body);
    if (!site) throw apiError('BAD_REQUEST', 'domain must be a valid hostname');
    return store.mutate((doc) => {
      if (!doc || typeof doc !== 'object') doc = {};
      const sites = Array.isArray(doc.sites) ? doc.sites.filter((item) => typeof item === 'string' && item) : [];
      const index = sites.indexOf(site);
      if (index >= 0) sites.splice(index, 1);
      doc.version = BALL_SITES_VERSION;
      doc.sites = sites;
      doc.updatedAt = clock();
      return { ...snapshot(doc), site, removed: index >= 0 };
    });
  }

  return { list, add, remove };
}
