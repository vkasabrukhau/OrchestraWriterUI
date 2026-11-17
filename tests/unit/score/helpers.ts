import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { InfoMap, Instrument } from "@/shared/info-map";
import { parseMusicXml, type ParseOutcome } from "@/shared/score";

// Built from the path, not `new URL(...)`: under jsdom the global URL is jsdom's
// class, which node's fileURLToPath rejects ("The URL must be of scheme file").
export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/scores") + sep;

export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURES + rel));
}

export function parseFixture(rel: string): ParseOutcome {
  return parseMusicXml({ bytes: fixtureBytes(rel), filename: rel.split("/").pop()! });
}

export function parseOk(rel: string): Extract<ParseOutcome, { ok: true }> {
  const out = parseFixture(rel);
  if (!out.ok) throw new Error(`expected ${rel} to parse: ${out.error}`);
  return out;
}

/** [pitch, time, duration] triples for compact timing assertions. */
export function timings(inst: Instrument): Array<[number, number, number]> {
  return inst.notes.map((n) => [n.pitch, n.time, n.duration]);
}

export function part(infoMap: InfoMap, id: string): Instrument {
  const inst = infoMap.instruments.find((i) => i.id === id);
  expect(inst, `part ${id}`).toBeDefined();
  return inst!;
}
