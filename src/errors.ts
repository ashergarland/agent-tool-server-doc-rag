export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'upstream_error'
  | 'internal_error';

const statusByCode: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  timeout: 504,
  unavailable: 503,
  upstream_error: 502,
  internal_error: 500,
};

const retryableByDefault: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'rate_limited',
  'timeout',
  'unavailable',
  'upstream_error',
]);

const maxDetailEntries = 10;
const maxDetailLength = 500;

/** Bounds error details so no transport can leak large or unbounded provider data. */
export const boundDetails = (details: unknown): unknown => {
  if (details === undefined || details === null) return undefined;
  if (Array.isArray(details)) return details.slice(0, maxDetailEntries).map(boundDetails);
  if (typeof details === 'string') return details.slice(0, maxDetailLength);
  if (typeof details === 'number' || typeof details === 'boolean') return details;
  if (typeof details === 'object') {
    return Object.fromEntries(
      Object.entries(details as Record<string, unknown>)
        .slice(0, maxDetailEntries)
        .map(([key, value]) => [key.slice(0, 64), boundDetails(value)]),
    );
  }
  return undefined;
};

export class AppError extends Error {
  public override readonly name = 'AppError';
  public readonly statusCode: number;
  public override readonly cause: unknown;
  public readonly details: unknown;
  public readonly retryable: boolean;

  public constructor(
    public readonly code: ErrorCode,
    message: string,
    details?: unknown,
    retryable?: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.statusCode = statusByCode[code];
    this.details = boundDetails(details);
    this.retryable = retryable ?? retryableByDefault.has(code);
    this.cause = cause;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('bad_request', message, details);
export const unauthorized = (message: string): AppError => new AppError('unauthorized', message);
export const forbidden = (message: string): AppError => new AppError('forbidden', message);
export const notFound = (message: string, details?: unknown): AppError =>
  new AppError('not_found', message, details);
export const unavailable = (message: string, details?: unknown): AppError =>
  new AppError('unavailable', message, details);
export const timedOut = (message: string, details?: unknown): AppError =>
  new AppError('timeout', message, details);
export const rateLimited = (message: string, details?: unknown): AppError =>
  new AppError('rate_limited', message, details);

export const toAppError = (error: unknown): AppError =>
  error instanceof AppError
    ? error
    : new AppError(
        'internal_error',
        'The tool server failed to complete the request',
        undefined,
        false,
        error,
      );
