import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  parsePort,
  parseHost,
  loadServerConfig,
  isWildcardHost,
  localBaseUrl,
  describeBinding,
} from "../../src/config.js";

describe("parsePort", () => {
  it("defaults to 3000 when unset or blank", () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
    expect(parsePort("")).toBe(3000);
    expect(parsePort("   ")).toBe(3000);
  });

  it("accepts valid ports", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort(" 8080 ")).toBe(8080);
    expect(parsePort("65535")).toBe(65535);
  });

  it("rejects non-numeric values", () => {
    expect(() => parsePort("abc")).toThrow('Invalid PORT "abc"');
    expect(() => parsePort("80a")).toThrow("Invalid PORT");
    expect(() => parsePort("-1")).toThrow("Invalid PORT");
    expect(() => parsePort("3.5")).toThrow("Invalid PORT");
  });

  it("rejects out-of-range values", () => {
    expect(() => parsePort("0")).toThrow("between 1 and 65535");
    expect(() => parsePort("65536")).toThrow("between 1 and 65535");
  });
});

describe("parseHost", () => {
  it("defaults to 127.0.0.1 when unset or blank, * means all interfaces", () => {
    expect(parseHost(undefined)).toBe(DEFAULT_HOST);
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(parseHost("")).toBe("127.0.0.1");
    expect(parseHost("  ")).toBe("127.0.0.1");
    expect(parseHost("*")).toBe("::");
  });

  it("accepts IPv4, IPv6 and hostnames", () => {
    expect(parseHost("127.0.0.1")).toBe("127.0.0.1");
    expect(parseHost(" 192.168.1.10 ")).toBe("192.168.1.10");
    expect(parseHost("0.0.0.0")).toBe("0.0.0.0");
    expect(parseHost("::")).toBe("::");
    expect(parseHost("::1")).toBe("::1");
    expect(parseHost("[::1]")).toBe("::1");
    expect(parseHost("localhost")).toBe("localhost");
    expect(parseHost("board.example.com")).toBe("board.example.com");
  });

  it("rejects garbage", () => {
    expect(() => parseHost("not a host")).toThrow('Invalid HOST "not a host"');
    expect(() => parseHost("http://localhost")).toThrow("Invalid HOST");
    expect(() => parseHost("-bad")).toThrow("Invalid HOST");
  });
});

describe("loadServerConfig", () => {
  it("uses defaults for an empty env", () => {
    expect(loadServerConfig({})).toEqual({ port: 3000, host: "127.0.0.1" });
  });

  it("reads PORT and HOST", () => {
    expect(loadServerConfig({ PORT: "4000", HOST: "127.0.0.1" })).toEqual({
      port: 4000,
      host: "127.0.0.1",
    });
  });

  it("falls back to process.env", () => {
    const prevPort = process.env["PORT"];
    const prevHost = process.env["HOST"];
    process.env["PORT"] = "4321";
    delete process.env["HOST"];
    try {
      expect(loadServerConfig()).toEqual({ port: 4321, host: "127.0.0.1" });
    } finally {
      if (prevPort === undefined) delete process.env["PORT"];
      else process.env["PORT"] = prevPort;
      if (prevHost !== undefined) process.env["HOST"] = prevHost;
    }
  });
});

describe("isWildcardHost / localBaseUrl / describeBinding", () => {
  it("detects wildcard hosts", () => {
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("127.0.0.1")).toBe(false);
  });

  it("builds a browser-usable base URL", () => {
    expect(localBaseUrl({ port: 3000, host: "127.0.0.1" })).toBe(
      "http://127.0.0.1:3000",
    );
    expect(localBaseUrl({ port: 8080, host: "0.0.0.0" })).toBe(
      "http://localhost:8080",
    );
    expect(localBaseUrl({ port: 8080, host: "::" })).toBe(
      "http://localhost:8080",
    );
    expect(localBaseUrl({ port: 8080, host: "192.168.1.10" })).toBe(
      "http://192.168.1.10:8080",
    );
    expect(localBaseUrl({ port: 8080, host: "::1" })).toBe("http://[::1]:8080");
    expect(localBaseUrl({ port: 8080, host: "localhost" })).toBe(
      "http://localhost:8080",
    );
  });

  it("describes the binding", () => {
    expect(describeBinding("::")).toBe("all interfaces");
    expect(describeBinding("0.0.0.0")).toBe("all IPv4 interfaces");
    expect(describeBinding("127.0.0.1")).toBe("127.0.0.1");
  });
});
