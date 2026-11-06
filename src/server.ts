import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { sha256Hex } from "./ids.js";
import { DecisionTracker, NotFoundError, ValidationError, type Clock, type DecisionDraft, type OutcomeDraft } from "./engine.js";

const DEFAULT_BODY_LIMIT = 1024 * 1024;

export interface ServerOptions {
  port: number;
  journal: string;
  token?: string;
  clock?: Clock;
  hostname?: string;
  maxBodyBytes?: number;
}

export interface AdtServer {
  port: number;
  close(): void;
}

type ErrorCode = "unauthorized" | "validation_error" | "not_found" | "replay" | "already_recorded" | "payload_too_large" | "bad_json" | "unavailable" | "method_not_allowed" | "internal";

class HttpError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string) {
    super(message);
  }
}

const GET_ONLY = new Set([
  "/health",
  "/stats",
  "/calibration",
  "/verify",
  "/decisions",
  "/decisions/:id",
  "/decisions/:id/attribution",
  "/decisions/:id/influence",
  "/decisions/:id/children",
]);

function matchPath(pathname: string, pattern: string): string[] | null {
  const got = pathname.split("/").filter(Boolean);
  const want = pattern.split("/").filter(Boolean);
  if (got.length !== want.length) return null;
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as string;
    if (w.startsWith(":")) continue;
    if ((got[i] as string) !== w) return null;
  }
  return got;
}

function sendJson(res: ServerResponse, status: number, code: ErrorCode | null, data?: unknown, message?: string): void {
  const payload = JSON.stringify(code === null ? data : { error: code, message });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function errorResponse(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, err.code, undefined, err.message);
    return;
  }
  if (err instanceof ValidationError) {
    if (err.code === "REPLAY") sendJson(res, 409, "replay", undefined, err.message);
    else if (err.code === "ALREADY_RECORDED") sendJson(res, 409, "already_recorded", undefined, err.message);
    else if (err.code === "PAYLOAD_TOO_LARGE") sendJson(res, 413, "payload_too_large", undefined, err.message);
    else sendJson(res, 400, "validation_error", undefined, err.message);
    return;
  }
  if (err instanceof NotFoundError) {
    sendJson(res, 404, "not_found", undefined, err.message);
    return;
  }
  sendJson(res, 500, "internal", undefined, err instanceof Error ? err.message : String(err));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = header.slice(7);
  const digest = sha256Hex(token);
  const presentedDigest = sha256Hex(presented);
  if (digest.length !== presentedDigest.length) return false;
  return timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(presentedDigest, "utf8"));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "payload_too_large", `request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startServer(opts: ServerOptions): Promise<AdtServer> {
  const tracker = DecisionTracker.create(opts.journal, opts.clock);
  const token = opts.token ?? process.env.ADT_TOKEN;
  const hostname = opts.hostname ?? "127.0.0.1";
  const bodyLimit = opts.maxBodyBytes ?? DEFAULT_BODY_LIMIT;

  const server: HttpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "GET" || method === "HEAD") {
        if (pathname === "/health") {
          sendJson(res, 200, null, { ok: true, decisions: tracker.decisionCount, outcomes: tracker.outcomeCount });
          return;
        }
        if (pathname === "/stats") {
          sendJson(res, 200, null, tracker.stats());
          return;
        }
        if (pathname === "/calibration") {
          sendJson(res, 200, null, tracker.calibration());
          return;
        }
        if (pathname === "/verify") {
          sendJson(res, 200, null, tracker.verify());
          return;
        }
        if (pathname === "/decisions") {
          const filter: { agentId?: string; tag?: string; limit?: number } = {};
          const agent = url.searchParams.get("agent");
          const tag = url.searchParams.get("tag");
          const limitRaw = url.searchParams.get("limit");
          if (agent !== null) filter.agentId = agent;
          if (tag !== null) filter.tag = tag;
          if (limitRaw !== null) {
            const limit = Number.parseInt(limitRaw, 10);
            if (Number.isFinite(limit) && limit > 0) filter.limit = limit;
          }
          sendJson(res, 200, null, { decisions: tracker.listDecisions(filter) });
          return;
        }
        const dec = matchPath(pathname, "/decisions/:id");
        if (dec) {
          const id = dec[1] as string;
          const outcome = tracker.outcomesFor(id)[0];
          sendJson(res, 200, null, { decision: tracker.getDecision(id), outcome: outcome ?? null });
          return;
        }
        const attr = matchPath(pathname, "/decisions/:id/attribution");
        if (attr) {
          sendJson(res, 200, null, tracker.attribute(attr[1] as string));
          return;
        }
        const infl = matchPath(pathname, "/decisions/:id/influence");
        if (infl) {
          sendJson(res, 200, null, tracker.influence(infl[1] as string));
          return;
        }
        const kids = matchPath(pathname, "/decisions/:id/children");
        if (kids) {
          sendJson(res, 200, null, { decisions: tracker.childrenOf(kids[1] as string) });
          return;
        }
        throw new HttpError(404, "not_found", `no route for ${method} ${pathname}`);
      }

      if (method === "POST") {
        const isDecision = matchPath(pathname, "/decisions") !== null;
        const outcomeMatch = matchPath(pathname, "/decisions/:id/outcome");
        if (!isDecision && !outcomeMatch) {
          if (GET_ONLY.has(pathname)) {
            throw new HttpError(405, "method_not_allowed", `${pathname} only accepts GET`);
          }
          throw new HttpError(404, "not_found", `no route for ${method} ${pathname}`);
        }
        if (!token) {
          throw new HttpError(503, "unavailable", "write endpoints require ADT_TOKEN to be configured");
        }
        if (!authorized(req, token)) {
          throw new HttpError(401, "unauthorized", "missing or invalid bearer token");
        }
        const raw = await readBody(req, bodyLimit);
        let body: unknown;
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          throw new HttpError(400, "bad_json", "request body is not valid JSON");
        }
        if (isDecision) {
          sendJson(res, 201, null, tracker.record(body as DecisionDraft));
          return;
        }
        const id = (outcomeMatch as string[])[1] as string;
        const draft = body as Omit<OutcomeDraft, "decisionId">;
        sendJson(res, 201, null, tracker.recordOutcome({ ...draft, decisionId: id }));
        return;
      }

      throw new HttpError(405, "method_not_allowed", `${method} is not supported`);
    } catch (err) {
      errorResponse(res, err);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, hostname, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
      resolve({ port, close: () => server.close() });
    });
  });
}
