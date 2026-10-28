export class EbayApiError extends Error {
  readonly status: number;
  readonly errorId?: number;

  constructor(message: string, status: number, errorId?: number) {
    super(message);
    this.name = "EbayApiError";
    this.status = status;
    this.errorId = errorId;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Reads the error shapes the Browse/Sell OpenAPI documents and the OAuth token endpoint return. */
export function readEbayError(status: number, body: unknown): { message: string; errorId?: number } {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const errors = record.errors;
    if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
      const first = errors[0] as Record<string, unknown>;
      const message = stringField(first.longMessage) ?? stringField(first.message);
      return {
        message: message ?? `eBay request failed (${status})`,
        errorId: typeof first.errorId === "number" ? first.errorId : undefined,
      };
    }
    const single = stringField(record.longMessage) ?? stringField(record.message);
    if (single) {
      return {
        message: single,
        errorId: typeof record.errorId === "number" ? record.errorId : undefined,
      };
    }
    const oauth = stringField(record.error_description) ?? stringField(record.error);
    if (oauth) return { message: oauth };
  }
  return { message: `eBay request failed (${status})` };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
