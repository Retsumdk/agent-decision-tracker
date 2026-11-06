import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let dir: string;
const TOKEN = "test-token-0123456789abcdef";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "adt-http-"));
  server = await startServer({ port: 0, journal: join(dir, "journal.jsonl"), token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(
  method: string,
  path: string,
  body?: unknown,
  auth = true,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const BODY = {
  agentId: "planner",
  task: "pick a deployment window",
  options: [
    { option: "now", score: 0.6 },
    { option: "later", score: 0.4 },
  ],
  chosen: "now",
  confidence: 0.6,
  confidenceBasis: "observed",
  reasoning: { summary: "pipeline is green" },
};

describe("decision-tracker HTTP server", () => {
  test("health and stats are public", async () => {
    const health = await api("GET", "/health");
    expect(health.status).toBe(200);
    expect(health.json.ok).toBe(true);

    const stats = await api("GET", "/stats");
    expect(stats.status).toBe(200);
    expect(stats.json.decisions).toBe(0);
  });

  test("mutations without a token are rejected", async () => {
    const res = await api("POST", "/decisions", BODY, false);
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("unauthorized");
  });

  test("full lifecycle: record, outcome, attribute, influence, stats", async () => {
    const created = await api("POST", "/decisions", BODY);
    expect(created.status).toBe(201);
    const decisionId = created.json.id as string;

    const outcome = await api("POST", `/decisions/${decisionId}/outcome`, {
      status: "success",
      actual: "shipped without incident",
    });
    expect(outcome.status).toBe(201);
    expect(outcome.json.decisionId).toBe(decisionId);

    const child = await api("POST", "/decisions", {
      ...BODY,
      task: "pick rollback trigger",
      parents: [decisionId],
    });
    expect(child.status).toBe(201);
    expect(child.json.parents).toEqual([decisionId]);

    const attr = await api("GET", `/decisions/${child.json.id}/attribution`);
    expect(attr.status).toBe(200);
    expect(attr.json.chain[0].id).toBe(decisionId);

    const influence = await api("GET", `/decisions/${decisionId}/influence`);
    expect(influence.status).toBe(200);
    expect(influence.json.descendants).toBe(1);
    expect(influence.json.outcomeStatuses.success).toBe(1);

    const calibration = await api("GET", "/calibration");
    expect(calibration.status).toBe(200);
    expect(calibration.json.scoredOutcomes).toBe(1);

    const stats = await api("GET", "/stats");
    expect(stats.json.decisions).toBe(2);
    expect(stats.json.outcomes).toBe(1);
    expect(stats.json.decisionsWithOutcomesPct).toBe(50);
  });

  test("replays are rejected", async () => {
    const res = await api("POST", "/decisions", BODY);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("replay");
  });

  test("unknown decision returns 404 with error code", async () => {
    const res = await api("GET", "/decisions/dec-nope");
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("not_found");
  });

  test("validation errors return 400 with code", async () => {
    const res = await api("POST", "/decisions", { ...BODY, chosen: "missing-option" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("validation_error");
  });

  test("GET-only mutations return 405", async () => {
    const res = await fetch(`${base}/stats`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
