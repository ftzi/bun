// https://github.com/oven-sh/bun/issues/12157
// https.Server should expose the same SNI helpers as tls.Server.
import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import tls from "node:tls";

const fixtures = join(import.meta.dir, "..", "tls", "fixtures");
const load = (name: string) => readFileSync(join(fixtures, name), "utf8");

const agent1Cert = load("agent1-cert.pem");
const agent1Key = load("agent1-key.pem");
const agent2Cert = load("agent2-cert.pem");
const agent2Key = load("agent2-key.pem");
const agent3Cert = load("agent3-cert.pem");
const agent3Key = load("agent3-key.pem");
const ca1 = load("ca1-cert.pem");
// agent1's key and certificate as a PKCS#12 bundle (passphrase "sample").
const agent1Pfx = readFileSync(join(import.meta.dir, "..", "test", "fixtures", "keys", "agent1.pfx"));

async function peerCN(port: number, servername?: string, extra: tls.ConnectionOptions = {}) {
  const socket = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false, ...extra });
  const errored = once(socket, "error");
  await Promise.race([once(socket, "secureConnect"), errored.then(([e]) => Promise.reject(e))]);
  const cert = socket.getPeerCertificate();
  socket.destroy();
  return cert.subject?.CN;
}

// peerCN() that resolves with the error code when the handshake is refused.
// Deliberately not `expect().rejects`: its nested event loop spin currently segfaults on Windows.
async function handshakeOutcome(port: number, extra: tls.ConnectionOptions) {
  try {
    return { cn: await peerCN(port, undefined, extra) };
  } catch (err) {
    return { code: (err as NodeJS.ErrnoException).code };
  }
}

// Resolves with the server certificate's CN when a request round-trips, or with
// the error code when the server refuses the client (at the handshake or, for
// TLS 1.3 client-certificate failures, right after it).
async function requestOutcome(port: number, extra: https.RequestOptions = {}) {
  const { promise, resolve } = Promise.withResolvers<{ cn: string | undefined } | { code: string }>();
  https
    .get({ host: "127.0.0.1", port, rejectUnauthorized: false, agent: false, ...extra }, res => {
      res.resume();
      resolve({ cn: (res.socket as tls.TLSSocket).getPeerCertificate().subject?.CN });
    })
    .on("error", (err: NodeJS.ErrnoException) => resolve({ code: err.code ?? err.message }));
  return promise;
}

// `agent: false` so every call opens a fresh connection and therefore a fresh
// SNI lookup; a pooled keep-alive socket would keep serving the cert (and
// router) selected when it was first opened.
async function httpsGetViaSNI(port: number, servername: string) {
  const { promise, resolve, reject } = Promise.withResolvers<{ cn: string | undefined; body: string }>();
  https
    .get(
      { host: "127.0.0.1", port, servername, headers: { Host: servername }, rejectUnauthorized: false, agent: false },
      res => {
        const cn = (res.socket as tls.TLSSocket).getPeerCertificate().subject?.CN;
        res.setEncoding("utf8");
        let body = "";
        res.on("data", chunk => (body += chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ cn, body }));
      },
    )
    .on("error", reject);
  return promise;
}

async function listen(server: https.Server) {
  const listenErr = once(server, "error");
  server.listen(0);
  await Promise.race([once(server, "listening"), listenErr.then(([e]) => Promise.reject(e))]);
  return (server.address() as AddressInfo).port;
}

describe("https.Server", () => {
  test("exposes tls.Server methods and is an http.Server subclass", () => {
    const server = https.createServer({ key: agent1Key, cert: agent1Cert });
    expect({
      addContext: typeof server.addContext,
      setSecureContext: typeof server.setSecureContext,
      getTicketKeys: typeof server.getTicketKeys,
      setTicketKeys: typeof server.setTicketKeys,
    }).toEqual({
      addContext: "function",
      setSecureContext: "function",
      getTicketKeys: "function",
      setTicketKeys: "function",
    });
    expect(server instanceof https.Server).toBe(true);
    expect(server instanceof http.Server).toBe(true);
    expect(() => server.addContext(123 as any, {})).toThrow(TypeError);
    expect(() => server.addContext(123 as any, {})).toThrow("hostname must be a string");
  });

  // https://github.com/oven-sh/bun/issues/31125
  // supertest <= 6.1.6 and @astrojs/node pick the protocol with
  // `app instanceof https.Server`, so a plain http.Server must not match.
  test("is a distinct class from http.Server", () => {
    expect(https.Server).not.toBe(http.Server);
    const plain = http.createServer();
    const secure = new https.Server({ key: agent1Key, cert: agent1Cert });
    expect({
      plainIsHttp: plain instanceof http.Server,
      plainIsHttps: plain instanceof https.Server,
      secureIsHttp: secure instanceof http.Server,
      secureIsHttps: secure instanceof https.Server,
      httpServerHasAddContext: "addContext" in plain,
    }).toEqual({
      plainIsHttp: true,
      plainIsHttps: false,
      secureIsHttp: true,
      secureIsHttps: true,
      httpServerHasAddContext: false,
    });
  });

  test("addContext registers a SNI context before listen", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert }, (req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      server.addContext("a.example.com", { key: agent1Key, cert: agent1Cert });
      server.addContext("b.example.com", { key: agent3Key, cert: agent3Cert });

      const port = await listen(server);

      expect(await peerCN(port, "a.example.com")).toBe("agent1");
      expect(await peerCN(port, "b.example.com")).toBe("agent3");
      // A hostname with no SNI match falls through to the default context.
      expect(await peerCN(port, "unknown.example.com")).toBe("agent2");
    } finally {
      server.close();
    }
  });

  test("addContext registers a SNI context after listen", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert }, (req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      const port = await listen(server);
      expect(await peerCN(port, "a.example.com")).toBe("agent2");

      server.addContext("a.example.com", { key: agent1Key, cert: agent1Cert });
      server.addContext("b.example.com", { key: agent3Key, cert: agent3Cert });

      expect(await peerCN(port, "a.example.com")).toBe("agent1");
      expect(await peerCN(port, "b.example.com")).toBe("agent3");
      expect(await peerCN(port, "unknown.example.com")).toBe("agent2");

      // The SNI-selected domain must also have routes installed (not just
      // a TLS context), so an HTTP request over that SNI reaches the
      // request handler.
      expect(await httpsGetViaSNI(port, "a.example.com")).toEqual({ cn: "agent1", body: "ok" });
      expect(await httpsGetViaSNI(port, "b.example.com")).toEqual({ cn: "agent3", body: "ok" });
    } finally {
      server.close();
    }
  });

  test("addContext with a repeated hostname replaces the previous context", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert }, (req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      server.addContext("a.example.com", { key: agent1Key, cert: agent1Cert });
      server.addContext("a.example.com", { key: agent3Key, cert: agent3Cert });

      const port = await listen(server);
      // pre-listen: the most recently added context wins
      expect(await peerCN(port, "a.example.com")).toBe("agent3");

      // post-listen: re-adding the same hostname replaces rather than throws
      server.addContext("a.example.com", { key: agent1Key, cert: agent1Cert });
      expect(await peerCN(port, "a.example.com")).toBe("agent1");
      expect(await httpsGetViaSNI(port, "a.example.com")).toEqual({ cn: "agent1", body: "ok" });

      server.addContext("a.example.com", { key: agent3Key, cert: agent3Cert });
      expect(await peerCN(port, "a.example.com")).toBe("agent3");

      // A re-add with a malformed cert throws, and must not strip the
      // previous working SNI entry.
      expect(() =>
        server.addContext("a.example.com", { key: agent1Key, cert: "-----BEGIN CERTIFICATE-----\ntruncated" }),
      ).toThrow("PEM routines");
      expect(await peerCN(port, "a.example.com")).toBe("agent3");
    } finally {
      server.close();
    }
  });

  test("addContext re-add does not break keep-alive connections on the previous SNI context", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert }, (req, res) => {
      res.writeHead(200, { "Content-Length": "2" });
      res.end("ok");
    });
    try {
      const port = await listen(server);
      server.addContext("a.example.com", { key: agent1Key, cert: agent1Cert });

      const socket = tls.connect({ host: "127.0.0.1", port, servername: "a.example.com", rejectUnauthorized: false });
      const errored = once(socket, "error").then(([e]) => Promise.reject(e));
      const closed = once(socket, "close").then(() => Promise.reject(new Error("socket closed before response")));
      try {
        await Promise.race([once(socket, "secureConnect"), errored, closed]);
        expect(socket.getPeerCertificate().subject?.CN).toBe("agent1");

        const readResponse = async () => {
          const chunks: Buffer[] = [];
          while (true) {
            const [chunk] = await Promise.race([once(socket, "data"), closed, errored]);
            chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString("utf8");
            const sep = raw.indexOf("\r\n\r\n");
            if (sep >= 0 && raw.length >= sep + 4 + 2) return raw.slice(sep + 4, sep + 4 + 2);
          }
        };

        socket.write("GET / HTTP/1.1\r\nHost: a.example.com\r\n\r\n");
        expect(await readResponse()).toBe("ok");

        // Replace the SNI context while the keep-alive connection is open;
        // the per-domain router for the previous SSL_CTX is freed here.
        server.addContext("a.example.com", { key: agent3Key, cert: agent3Cert });

        // A second request on the same connection must fall back to the
        // default router rather than dereferencing the freed per-domain one.
        socket.write("GET / HTTP/1.1\r\nHost: a.example.com\r\n\r\n");
        expect(await readResponse()).toBe("ok");
      } finally {
        socket.destroy();
      }
    } finally {
      server.close();
    }
  });

  test("addContext rejects an empty hostname before and after listen", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert });
    try {
      const requiredServerName = '"servername" is required parameter for Server.addContext';
      expect(() => server.addContext("", { key: agent1Key, cert: agent1Cert })).toThrow(requiredServerName);
      // The rejected call must not have queued anything that breaks listen().
      const port = await listen(server);
      expect(await peerCN(port)).toBe("agent2");
      expect(() => server.addContext("", { key: agent1Key, cert: agent1Cert })).toThrow(requiredServerName);
      expect(await peerCN(port)).toBe("agent2");
    } finally {
      server.close();
    }
  });

  test("addContext accepts the same options as the constructor (pfx) before and after listen", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert });
    try {
      server.addContext("a.example.com", { pfx: agent1Pfx, passphrase: "sample" });
      const port = await listen(server);
      server.addContext("b.example.com", { pfx: agent1Pfx, passphrase: "sample" });
      expect({
        a: await peerCN(port, "a.example.com"),
        b: await peerCN(port, "b.example.com"),
        other: await peerCN(port, "c.example.com"),
      }).toEqual({ a: "agent1", b: "agent1", other: "agent2" });
    } finally {
      server.close();
    }
  });

  test("setSecureContext replaces the default context before listen", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert }, (req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      server.setSecureContext({ key: agent3Key, cert: agent3Cert });
      const port = await listen(server);
      expect(await peerCN(port)).toBe("agent3");
    } finally {
      server.close();
    }
  });

  test("setSecureContext with an invalid option applies nothing", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert }, (req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      // Rejected on `key`, after `cert` was already read: the new cert must not
      // be left paired with the old key.
      expect(() => server.setSecureContext({ cert: agent3Cert, key: 123 as any })).toThrow(
        'The "options.key" property must be of type string or an instance of Buffer, TypedArray, or DataView.',
      );
      const port = await listen(server);
      expect(await peerCN(port)).toBe("agent2");
    } finally {
      server.close();
    }
  });

  test("setSecureContext on a server with no initial TLS options does not require a client certificate", async () => {
    const server = https.createServer((req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      server.setSecureContext({ key: agent1Key, cert: agent1Cert, ca: ca1 });
      const port = await listen(server);
      expect(await peerCN(port)).toBe("agent1");
    } finally {
      server.close();
    }
  });

  test("setSecureContext accepts the same options as the constructor (pfx, minVersion)", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert });
    try {
      server.setSecureContext({ pfx: agent1Pfx, passphrase: "sample", minVersion: "TLSv1.3" });
      const port = await listen(server);
      expect(await peerCN(port)).toBe("agent1");
      expect(await handshakeOutcome(port, { maxVersion: "TLSv1.2" })).toEqual({
        code: "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
      });
    } finally {
      server.close();
    }
  });

  test("setSecureContext clears options the constructor had set but the new call omits", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert, minVersion: "TLSv1.3" });
    try {
      server.setSecureContext({ key: agent3Key, cert: agent3Cert });
      const port = await listen(server);
      expect(await peerCN(port, undefined, { maxVersion: "TLSv1.2" })).toBe("agent3");
    } finally {
      server.close();
    }
  });

  test("setSecureContext rejects an unknown secureProtocol and applies nothing", async () => {
    const server = https.createServer({ key: agent2Key, cert: agent2Cert });
    try {
      expect(() =>
        server.setSecureContext({ key: agent3Key, cert: agent3Cert, secureProtocol: "bogus_method" }),
      ).toThrow(
        expect.objectContaining({ code: "ERR_TLS_INVALID_PROTOCOL_METHOD", message: "Unknown method: bogus_method" }),
      );
      const port = await listen(server);
      expect(await peerCN(port)).toBe("agent2");
    } finally {
      server.close();
    }
  });

  test("setSecureContext keeps the client certificate policy the server was created with", async () => {
    const server = https.createServer(
      { key: agent2Key, cert: agent2Cert, ca: ca1, requestCert: true, rejectUnauthorized: true },
      (req, res) => res.end("ok"),
    );
    try {
      // Like Node, requestCert/rejectUnauthorized are server settings; swapping
      // the certificate (with a call that does not mention them) keeps them.
      server.setSecureContext({ key: agent3Key, cert: agent3Cert, ca: ca1 });
      const port = await listen(server);
      // agent1 is issued by ca1, so it is the one client the server accepts.
      expect(await requestOutcome(port, { key: agent1Key, cert: agent1Cert })).toEqual({ cn: "agent3" });
      expect(await requestOutcome(port)).toEqual({ code: expect.stringMatching(/^ERR_SSL_|^ECONNRESET$/) });
    } finally {
      server.close();
    }
  });
});
