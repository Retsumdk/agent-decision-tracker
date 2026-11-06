import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, sha256Hex } from "./ids.js";
import type { JournalEnvelope, JournalRecord } from "./types.js";

export const GENESIS_HASH = "GENESIS";

export class StoreError extends Error {
  readonly file: string;
  readonly line: number;

  constructor(message: string, file: string, line: number) {
    super(`${file}:${line}: ${message}`);
    this.name = "StoreError";
    this.file = file;
    this.line = line;
  }
}

function envelopeHash(seq: number, prevHash: string, record: JournalRecord): string {
  return sha256Hex(`${seq}|${prevHash}|${canonicalJson(record)}`);
}

export interface VerifyReport {
  ok: boolean;
  records: number;
  lines: string[];
}

function parseLine(raw: string, file: string, lineNo: number): JournalEnvelope {
  let env: JournalEnvelope;
  try {
    env = JSON.parse(raw) as JournalEnvelope;
  } catch {
    throw new StoreError("malformed JSON line", file, lineNo);
  }
  if (env === null || typeof env !== "object" || typeof env.hash !== "string" || typeof env.prevHash !== "string") {
    throw new StoreError("malformed journal envelope", file, lineNo);
  }
  if (env.record === null || typeof env.record !== "object" || typeof env.record.id !== "string") {
    throw new StoreError("journal envelope is missing a record id", file, lineNo);
  }
  return env;
}

function envelopeSeq(env: JournalEnvelope, fallback: number): number {
  return typeof env.seq === "number" && Number.isFinite(env.seq) ? env.seq : fallback;
}

export class JournalStore {
  readonly file: string;
  private envelopes: JournalEnvelope[] = [];
  private headSeq = 0;
  private headHash = GENESIS_HASH;
  private fd: number | null = null;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const lines = readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      const env = parseLine(lines[i] as string, this.file, i + 1);
      const seq = envelopeSeq(env, i + 1);
      this.envelopes.push(env);
      this.headSeq = seq;
      this.headHash = env.hash;
    }
  }

  get size(): number {
    return this.envelopes.length;
  }

  get nextSeq(): number {
    return this.headSeq + 1;
  }

  all(): readonly JournalEnvelope[] {
    return this.envelopes;
  }

  verify(): VerifyReport {
    if (this.envelopes.length === 0) {
      return { ok: true, records: 0, lines: [] };
    }
    const lines: string[] = [];
    const seenIds = new Set<string>();
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    for (let i = 0; i < this.envelopes.length; i++) {
      const env = this.envelopes[i] as JournalEnvelope;
      const lineNo = i + 1;
      if (env.seq !== expectedSeq) {
        lines.push(`line ${lineNo}: sequence gap (expected ${expectedSeq}, got ${String(env.seq)})`);
      }
      if (env.prevHash !== prevHash) {
        lines.push(`line ${lineNo}: hash chain mismatch (record tampered or reordered)`);
      }
      const expected = envelopeHash(envelopeSeq(env, expectedSeq), env.prevHash, env.record);
      if (env.hash !== expected) {
        lines.push(`line ${lineNo}: hash mismatch (record tampered)`);
      }
      const rid = env.record.id;
      if (seenIds.has(rid)) {
        lines.push(`line ${lineNo}: duplicate record id ${rid}`);
      }
      seenIds.add(rid);
      prevHash = env.hash;
      expectedSeq++;
    }
    return { ok: lines.length === 0, records: this.envelopes.length, lines };
  }

  append(record: JournalRecord): JournalEnvelope {
    if (this.envelopes.some((e) => e.record.id === record.id)) {
      throw new StoreError(`duplicate record id ${record.id}`, this.file, this.envelopes.length + 1);
    }
    const seq = this.nextSeq;
    const hash = envelopeHash(seq, this.headHash, record);
    const env: JournalEnvelope = { seq, prevHash: this.headHash, hash, record };
    if (!existsSync(this.file)) {
      mkdirSync(dirname(this.file), { recursive: true });
    }
    if (this.fd === null) {
      this.fd = openSync(this.file, "a");
    }
    appendFileSync(this.fd, `${JSON.stringify(env)}\n`, "utf8");
    this.envelopes.push(env);
    this.headSeq = seq;
    this.headHash = hash;
    return env;
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
