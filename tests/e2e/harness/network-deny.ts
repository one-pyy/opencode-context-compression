import { createRequire, syncBuiltinESMExports } from "node:module";

const runtimeRequire = createRequire(import.meta.url);
const httpModule = runtimeRequire("node:http") as typeof import("node:http");
const httpsModule = runtimeRequire("node:https") as typeof import("node:https");

let activeRestore: (() => void) | undefined;

type FetchTarget = string | URL | Request;

export interface InstalledNetworkDeny {
  restore(): void;
}

export class UnauthorizedNetworkAccessError extends Error {
  readonly operation: string;
  readonly target: string;

  constructor(input: { readonly operation: string; readonly target: string }) {
    super(
      `Unauthorized network access blocked for ${input.operation} -> ${input.target}. Inject a safe transport fixture instead of using live network.`,
    );
    this.name = "UnauthorizedNetworkAccessError";
    this.operation = input.operation;
    this.target = input.target;
  }
}

export function installNetworkDeny(): InstalledNetworkDeny {
  if (activeRestore !== undefined) {
    throw new Error(
      "Network deny is already installed in this Node test process. Run hermetic E2E harness tests without concurrency.",
    );
  }

  const originalFetch = globalThis.fetch;
  const originalHttpRequest = httpModule.request;
  const originalHttpGet = httpModule.get;
  const originalHttpsRequest = httpsModule.request;
  const originalHttpsGet = httpsModule.get;

  globalThis.fetch = (async (input: FetchTarget) => {
    throw new UnauthorizedNetworkAccessError({
      operation: "fetch",
      target: describeFetchTarget(input),
    });
  }) as typeof fetch;

  httpModule.request = ((...args: unknown[]) => {
    throw new UnauthorizedNetworkAccessError({
      operation: "http.request",
      target: describeNodeRequestTarget("http:", args[0]),
    });
  }) as typeof httpModule.request;

  httpModule.get = ((...args: unknown[]) => {
    throw new UnauthorizedNetworkAccessError({
      operation: "http.get",
      target: describeNodeRequestTarget("http:", args[0]),
    });
  }) as typeof httpModule.get;

  httpsModule.request = ((...args: unknown[]) => {
    throw new UnauthorizedNetworkAccessError({
      operation: "https.request",
      target: describeNodeRequestTarget("https:", args[0]),
    });
  }) as typeof httpsModule.request;

  httpsModule.get = ((...args: unknown[]) => {
    throw new UnauthorizedNetworkAccessError({
      operation: "https.get",
      target: describeNodeRequestTarget("https:", args[0]),
    });
  }) as typeof httpsModule.get;

  syncBuiltinESMExports();

  activeRestore = () => {
    globalThis.fetch = originalFetch;
    httpModule.request = originalHttpRequest;
    httpModule.get = originalHttpGet;
    httpsModule.request = originalHttpsRequest;
    httpsModule.get = originalHttpsGet;
    syncBuiltinESMExports();
    activeRestore = undefined;
  };

  return {
    restore() {
      activeRestore?.();
    },
  } satisfies InstalledNetworkDeny;
}

function describeFetchTarget(input: FetchTarget): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function describeNodeRequestTarget(
  defaultProtocol: "http:" | "https:",
  target: unknown,
): string {
  if (typeof target === "string") {
    return target;
  }

  if (target instanceof URL) {
    return target.toString();
  }

  if (target && typeof target === "object") {
    const record = target as {
      readonly protocol?: unknown;
      readonly hostname?: unknown;
      readonly host?: unknown;
      readonly port?: unknown;
      readonly path?: unknown;
      readonly pathname?: unknown;
      readonly socketPath?: unknown;
    };

    if (typeof record.socketPath === "string") {
      return `${defaultProtocol}//unix:${record.socketPath}`;
    }

    const protocol =
      typeof record.protocol === "string" ? record.protocol : defaultProtocol;
    const hostname =
      typeof record.hostname === "string"
        ? record.hostname
        : typeof record.host === "string"
          ? record.host
          : "unknown-host";
    const port =
      typeof record.port === "string" || typeof record.port === "number"
        ? `:${String(record.port)}`
        : "";
    const path =
      typeof record.path === "string"
        ? record.path
        : typeof record.pathname === "string"
          ? record.pathname
          : "/";

    return `${protocol}//${hostname}${port}${path}`;
  }

  return `${defaultProtocol}//unknown-target`;
}
