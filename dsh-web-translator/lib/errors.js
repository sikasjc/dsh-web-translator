/**
 * Error taxonomy for the dsh-web-translator host API.
 *
 * Every failure leaves the HTTP layer as `{ok:false,error:{code,message}}`
 * with the status defined by DESIGN §5.9. Plugin-internal code throws
 * {@link ApiError}; anything else is reported as `INTERNAL` and logged.
 */

/** Stable API error code -> HTTP status (DESIGN §5.9). */
export const ERROR_STATUS = Object.freeze({
  BAD_REQUEST: 400,
  INVALID_SETTINGS: 400,
  INVALID_URL_OR_TEXT: 400,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  WORD_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  TEXT_LIMIT: 413,
  MODEL_RATE_LIMITED: 429,
  INTERNAL: 500,
  MODEL_UNAVAILABLE: 502,
  MODEL_AUTH: 502,
  MODEL_FAILED: 502,
  OUTPUT_TRUNCATED: 502,
  INVALID_MODEL_OUTPUT: 502,
  MODEL_TIMEOUT: 504,
});

/** One expected API failure carrying a stable code and its HTTP status. */
export class ApiError extends Error {
  /**
   * @param {string} code - key of {@link ERROR_STATUS}.
   * @param {string} message - human-readable explanation safe to return.
   */
  constructor(code, message) {
    super(typeof message === 'string' && message.length > 0 ? message : code);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 500;
  }
}

/**
 * Build one {@link ApiError}.
 * @param {string} code - key of {@link ERROR_STATUS}.
 * @param {string} [message] - optional explanation, defaults to the code.
 * @returns {ApiError}
 */
export function apiError(code, message) {
  return new ApiError(code, message ?? code);
}

/**
 * Whether a value is one of this module's API errors.
 * @param {unknown} value - value to test.
 * @returns {value is ApiError}
 */
export function isApiError(value) {
  return value instanceof ApiError
    || (value !== null
      && typeof value === 'object'
      && value.name === 'ApiError'
      && typeof value.code === 'string'
      && typeof value.status === 'number');
}

/**
 * HTTP status for a caught value.
 * @param {unknown} value - caught error.
 * @returns {number}
 */
export function statusOf(value) {
  return isApiError(value) ? value.status : 500;
}

/**
 * JSON failure envelope for a caught value; unexpected errors become `INTERNAL`.
 * @param {unknown} value - caught error.
 * @returns {{ok: false, error: {code: string, message: string}}}
 */
export function errorEnvelope(value) {
  const known = isApiError(value);
  return {
    ok: false,
    error: {
      code: known ? value.code : 'INTERNAL',
      message: known ? value.message : 'internal server error',
    },
  };
}
