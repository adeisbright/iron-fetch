//Custom Error
class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class TimeoutError extends Error {
  constructor() {
    super("Upstream timeout");
    this.name = "TimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

//Http Client Param Type
export interface IHttpClient<TBody = unknown> {
  url: string;
  method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
  timeoutMs?: number;
  headers?: Record<string, string>;
  body?: TBody;
  maxRetries?: number;
  retryDelayMs?: number;
}

//Delays Retry
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

//Check if request can retry based on returned error
const isRetryableError = (error: unknown): boolean => {
  if (error instanceof HttpError) {
    return error.status >= 500 || error.status === 429;
  }

  if (error instanceof Error) {
    return ["AbortError", "TypeError"].includes(error.name);
  }

  return false;
};

export const httpClient = async <TResponse, TBody = unknown>({
  url,
  method,
  timeoutMs = 5000,
  headers = {},
  body,
  maxRetries = 2,
  retryDelayMs = 1000,
}: IHttpClient<TBody>): Promise<TResponse> => {
  const executeRequest = async (attempt: number): Promise<TResponse> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const isJsonConfig =
        body !== undefined &&
        !(body instanceof FormData) &&
        !(body instanceof URLSearchParams);

      const requestHeaders: HeadersInit = {
        ...(isJsonConfig ? { "Content-Type": "application/json" } : {}),
        ...headers,
      };
      const response = await fetch(url, {
        signal: controller.signal,
        method,
        headers: requestHeaders,
        ...(method !== "GET" &&
          isJsonConfig && {
            body: JSON.stringify(body),
          }),
      });
      if (!response.ok) {
        throw new HttpError(response.status, response.statusText);
      }

      if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
      ) {
        return {} as TResponse;
      }

      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return (await response.json()) as TResponse;
      }
      throw new HttpError(502, "Bad Content Type From Upstream");
    } catch (error: unknown) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      if (attempt < maxRetries && isRetryableError(error)) {
        const backoff =
          retryDelayMs * Math.pow(2, attempt) + Math.random() * 100;
        await sleep(backoff);
        return executeRequest(attempt + 1);
      }
      if (isAbort) throw new TimeoutError();
      if (error instanceof Error) throw error;
      throw new Error(
        "An unexpected error occurred during the network request"
      );
    } finally {
      clearTimeout(timeoutId);
    }
  };
  return executeRequest(0);
};
