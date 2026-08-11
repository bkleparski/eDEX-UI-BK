'use strict';

class AssistantError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AssistantError';
    this.code = code;
    this.provider = options.provider || null;
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.retryAfter = Number.isFinite(options.retryAfter) ? options.retryAfter : null;
    this.details = options.details || null;
  }
}

function statusCodeToErrorCode(status) {
  if (status === 400) return 'INVALID_REQUEST';
  if (status === 401) return 'INVALID_API_KEY';
  if (status === 402) return 'INSUFFICIENT_CREDITS';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502) return 'UPSTREAM_ERROR';
  if (status === 503) return 'PROVIDER_UNAVAILABLE';
  return status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'REQUEST_FAILED';
}

function errorMessageFromBody(body, fallback) {
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 500);
  return body?.error?.message || body?.message || body?.error || fallback;
}

function providerHttpError(provider, status, body, headers) {
  const retryAfterHeader = headers?.get?.('retry-after');
  const retryAfter = Number.parseFloat(retryAfterHeader);
  return new AssistantError(
    statusCodeToErrorCode(status),
    errorMessageFromBody(body, `${provider} request failed with HTTP ${status}.`),
    { provider, status, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null }
  );
}

function normalizeNetworkError(provider, error) {
  if (error instanceof AssistantError) return error;
  if (error?.name === 'TimeoutError') {
    return new AssistantError('TIMEOUT', `${provider} request timed out.`, { provider, cause: error });
  }
  if (error?.name === 'AbortError') {
    return new AssistantError('ABORTED', `${provider} request was cancelled.`, { provider, cause: error });
  }
  return new AssistantError('PROVIDER_OFFLINE', `${provider} is unavailable.`, { provider, cause: error });
}

module.exports = { AssistantError, normalizeNetworkError, providerHttpError, statusCodeToErrorCode };
