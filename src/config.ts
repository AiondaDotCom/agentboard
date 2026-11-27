import { isIP } from "node:net";

/**
 * Where the HTTP server listens.
 *
 * - `PORT`: TCP port (1-65535), default 3000.
 * - `HOST`: bind address. Default: all interfaces (IPv4 + IPv6), as before.
 *   `localhost` / `127.0.0.1` / `::1` = only this machine,
 *   a concrete IP (e.g. `192.168.1.10`) = only that interface,
 *   `0.0.0.0` = all IPv4, `::` = all interfaces.
 */
export interface ServerConfig {
  port: number;
  /** undefined = Node default (all interfaces) */
  host: string | undefined;
}

export const DEFAULT_PORT = 3000;

const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function parsePort(raw: string | undefined): number {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(value))
    throw new Error(
      `Invalid PORT "${value}": must be a number between 1 and 65535`,
    );
  const port = Number(value);
  if (port < 1 || port > 65535)
    throw new Error(`Invalid PORT "${value}": must be between 1 and 65535`);
  return port;
}

export function parseHost(raw: string | undefined): string | undefined {
  let value = raw?.trim() ?? "";
  if (value === "" || value === "*") return undefined;
  // Allow bracketed IPv6 like "[::1]"
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (isIP(value) === 0 && !HOSTNAME_RE.test(value)) {
    throw new Error(
      `Invalid HOST "${value}": must be an IP address or hostname`,
    );
  }
  return value;
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  return { port: parsePort(env["PORT"]), host: parseHost(env["HOST"]) };
}

/** True if the server is reachable from other machines (not loopback only). */
export function isWildcardHost(host: string | undefined): boolean {
  return host === undefined || host === "0.0.0.0" || host === "::";
}

/** Browser-usable base URL for the configured listen address. */
export function localBaseUrl(config: ServerConfig): string {
  const host =
    config.host === undefined || isWildcardHost(config.host)
      ? "localhost"
      : config.host;
  const urlHost = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${urlHost}:${String(config.port)}`;
}

/** Human-readable description of the bind address for the startup banner. */
export function describeBinding(host: string | undefined): string {
  if (host === undefined || host === "::") return "all interfaces";
  if (host === "0.0.0.0") return "all IPv4 interfaces";
  return host;
}
