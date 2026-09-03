/**
 * Tests for the sample flat.
 *
 * The one that matters is `validate(sampleFlat())` being exactly `[]` — no errors AND no warnings.
 * Everything downstream is built against this document, so the moment it carries a warning, "is the
 * validator output clean?" stops being a usable signal while working on the viewport or the solver.
 */

import { expect, test } from 'vitest';

import { PlanDocSchema, SCHEMA_VERSION } from './schema';
import { sampleFlat } from './sample';
import { validate } from './validate';

test('the sample flat is a shape-valid document', () => {
  const parsed = PlanDocSchema.safeParse(sampleFlat());
  expect(parsed.success).toBe(true);
  expect(sampleFlat().schemaVersion).toBe(SCHEMA_VERSION);
});

test('the sample flat has no issues at all — not one error, not one warning', () => {
  // Mapped to strings so a failure prints what is wrong rather than a wall of objects.
  expect(validate(sampleFlat()).map((i) => `${i.severity} ${i.code}: ${i.message}`)).toEqual([]);
});

test('every call returns a fresh, independent document', () => {
  const a = sampleFlat();
  const b = sampleFlat();

  expect(a).toEqual(b);
  expect(a).not.toBe(b);
  expect(a.levels[0].nodes[0]).not.toBe(b.levels[0].nodes[0]);
  // `meta` is the easy one to get wrong: a shared constant would be handed to every element of
  // every document this function ever returns.
  expect(a.levels[0].nodes[0].meta).not.toBe(b.levels[0].nodes[0].meta);

  a.levels[0].nodes[0].x = 999999;
  a.levels[0].nodes[0].meta.confidence = 0;
  a.levels[0].walls.pop();
  a.name = 'edited';

  expect(b.levels[0].nodes[0].x).toBe(0);
  expect(b.levels[0].nodes[0].meta.confidence).toBe(1);
  expect(b.levels[0].walls).toHaveLength(25);
  expect(b.name).toBe('Sample 2BHK');
  expect(sampleFlat()).toEqual(b);
});

test('the scale is confirmed and self-consistent', () => {
  const { scale } = sampleFlat();
  expect(scale.status).toBe('confirmed');
  if (scale.status !== 'confirmed') return;
  expect(scale.reference.lengthMm / scale.reference.lengthPx).toBe(scale.mmPerPx);
});

test('it is a real flat: six rooms or more, all named differently', () => {
  const rooms = sampleFlat().levels[0].rooms;
  expect(rooms.length).toBeGreaterThanOrEqual(6);
  expect(new Set(rooms.map((r) => r.name)).size).toBe(rooms.length);
});

test('both wall thicknesses are present, and the balcony parapet is not full height', () => {
  const walls = sampleFlat().levels[0].walls;
  const thicknesses = new Set(walls.map((w) => w.thicknessMm));
  expect(thicknesses).toContain(230); // external brickwork
  expect(thicknesses).toContain(115); // internal partitions

  const parapets = walls.filter((w) => w.heightMm < 2900);
  expect(parapets.length).toBeGreaterThan(0);
  expect(parapets.every((w) => w.heightMm === 1100)).toBe(true);
});

test('there are real T-junctions: nodes shared by three or more walls', () => {
  const level = sampleFlat().levels[0];
  const degree = new Map<string, number>();
  for (const w of level.walls) {
    degree.set(w.a, (degree.get(w.a) ?? 0) + 1);
    degree.set(w.b, (degree.get(w.b) ?? 0) + 1);
  }

  const junctions = [...degree.values()].filter((n) => n >= 3);
  // A box has none of these, and they are exactly what the mitering code will get wrong.
  expect(junctions.length).toBeGreaterThanOrEqual(8);
  expect(Math.max(...degree.values())).toBeGreaterThanOrEqual(4); // n16, a four-way junction
});

test('the NBC door widths are the ones actually used', () => {
  const doors = sampleFlat().levels[0].openings.filter((o) => o.kind === 'door');
  const widths = doors.map((d) => d.widthMm);
  expect(widths).toContain(1000); // main entrance
  expect(widths).toContain(900); // bedroom
  expect(widths).toContain(800); // kitchen
  expect(widths).toContain(750); // bathroom
});

test('each doorway has the leaf it would really be built with', () => {
  const doors = sampleFlat().levels[0].openings.filter((o) => o.kind === 'door');
  const byId = new Map(doors.map((d) => [d.id, d]));

  expect(byId.get('d7')?.leaf).toBe('none'); // living -> passage: a cased opening, no leaf
  expect(byId.get('d8')?.leaf).toBe('sliding'); // living -> balcony: a slider
  expect(doors.filter((d) => d.leaf === 'hinged')).toHaveLength(6);

  // Only the hinged ones cost their room a sector of floor, and only they carry the data to say so.
  for (const d of doors) expect('swing' in d).toBe(d.leaf === 'hinged');
});

test('every stored length and coordinate is an integer number of millimetres', () => {
  const level = sampleFlat().levels[0];
  const integers = [
    ...level.nodes.flatMap((n) => [n.x, n.y]),
    ...level.walls.flatMap((w) => [w.thicknessMm, w.heightMm]),
    ...level.openings.flatMap((o) => [o.offsetMm, o.widthMm, o.heightMm, o.sillMm]),
    level.elevationMm,
  ];
  for (const value of integers) expect(Number.isInteger(value)).toBe(true);
});

test('every element is marked as hand-authored ground truth', () => {
  const level = sampleFlat().levels[0];
  const metas = [
    level.meta,
    ...level.nodes.map((n) => n.meta),
    ...level.walls.map((w) => w.meta),
    ...level.openings.map((o) => o.meta),
    ...level.rooms.map((r) => r.meta),
  ];
  for (const m of metas) expect(m).toEqual({ source: 'user', confidence: 1 });
});

test('furniture is left out on purpose', () => {
  expect(sampleFlat().levels[0].items).toEqual([]);
});
