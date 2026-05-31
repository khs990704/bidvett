/**
 * Standard error codes + JSON serializer.
 * Source: _workspace/02_api_spec.md §4.
 *
 * All API error responses use the shape:
 *   { error: { code: string, message: string, details?: object } }
 */
import { NextResponse } from 'next/server';

export const ErrorCode = {
  BAD_REQUEST: 'ERR_BAD_REQUEST',
  WEBHOOK_SIGNATURE: 'ERR_WEBHOOK_SIGNATURE',
  UNAUTHENTICATED: 'ERR_UNAUTHENTICATED',
  OUT_OF_CREDITS: 'ERR_OUT_OF_CREDITS',
  SOFT_CAP_REACHED: 'ERR_SOFT_CAP_REACHED',
  FORBIDDEN: 'ERR_FORBIDDEN',
  NOT_FOUND: 'ERR_NOT_FOUND',
  DUPLICATE_REFUND: 'ERR_DUPLICATE_REFUND',
  INPUT_TOO_LARGE: 'ERR_INPUT_TOO_LARGE',
  VALIDATION: 'ERR_VALIDATION',
  RATE_LIMITED: 'ERR_RATE_LIMITED',
  INTERNAL: 'ERR_INTERNAL',
  PROMPT_NOT_FOUND: 'ERR_PROMPT_NOT_FOUND',
  LLM_UPSTREAM: 'ERR_LLM_UPSTREAM',
  PAYMENT_UPSTREAM: 'ERR_PAYMENT_UPSTREAM',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const DEFAULT_MESSAGES: Record<ErrorCodeValue, string> = {
  ERR_BAD_REQUEST: 'The request is malformed.',
  ERR_WEBHOOK_SIGNATURE: 'Invalid signature.',
  ERR_UNAUTHENTICATED: 'Sign in to continue.',
  ERR_OUT_OF_CREDITS: 'You have no remaining credits. Please purchase a plan.',
  ERR_SOFT_CAP_REACHED: "You've hit this period's soft cap. Try again next period.",
  ERR_FORBIDDEN: 'You do not have access to this resource.',
  ERR_NOT_FOUND: 'Not found.',
  ERR_DUPLICATE_REFUND: 'This refund was already processed.',
  ERR_INPUT_TOO_LARGE: 'The input exceeds the size limit.',
  ERR_VALIDATION: 'The response failed schema validation.',
  ERR_RATE_LIMITED: 'Too many requests. Please slow down.',
  ERR_INTERNAL: "Something went wrong. We've been notified.",
  ERR_PROMPT_NOT_FOUND: 'System prompt not configured.',
  ERR_LLM_UPSTREAM: 'The analyzer is temporarily unavailable. Please retry.',
  ERR_PAYMENT_UPSTREAM: 'Payment provider is temporarily unavailable.',
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCodeValue;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCodeValue,
    details?: Record<string, unknown>,
    message?: string,
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function apiError(
  status: number,
  code: ErrorCodeValue,
  details?: Record<string, unknown>,
  message?: string,
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message: message ?? DEFAULT_MESSAGES[code],
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
}

/**
 * Wrap a Route Handler so that ApiError thrown anywhere inside becomes the
 * canonical JSON shape, and any other thrown error becomes ERR_INTERNAL 500.
 */
export function withErrorHandling<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<Response>,
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof ApiError) {
        return apiError(err.status, err.code, err.details, err.message);
      }
      // eslint-disable-next-line no-console
      console.error('[unhandled]', err);
      return apiError(500, ErrorCode.INTERNAL);
    }
  };
}

/**
 * OpenAI upstream failure (after Silent Retry x3). Caller decides HTTP code.
 */
export class OpenAIUpstreamError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super('OpenAI upstream failure after Silent Retry x3');
    this.cause = cause;
  }
}
