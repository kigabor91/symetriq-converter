import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { CanonicalPropertyStore } from '../dist-server/publish/canonicalPropertyStore.js';

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) {
  throw new Error('Usage: node tools/benchmarkPropertyStore.mjs <v2-db-path> <v3-db-path>');
}
const store = new CanonicalPropertyStore();
const paths = { v2: oldPath, v3: newPath };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const time = (fn, runs) => {
  const samples = [];
  let result;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    result = fn();
    samples.push(+(performance.now() - started).toFixed(3));
  }
  const warm = samples.slice(1);
  return { result, firstMs: samples[0], warmMedianMs: +median(warm).toFixed(3), warmRangeMs: [Math.min(...warm), Math.max(...warm)] };
};

const oldDb = new DatabaseSync(oldPath, { readOnly: true });
const newDb = new DatabaseSync(newPath, { readOnly: true });
const tableNames = ['property_definitions', 'property_values', 'property_sets', 'property_set_values', 'types', 'elements', 'render_objects'];
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const counts = Object.fromEntries(tableNames.map((table) => [table, { v2: count(oldDb, table), v3: count(newDb, table) }]));
for (const [table, pair] of Object.entries(counts)) assert.equal(pair.v3, pair.v2, `Semantic cardinality changed: ${table}`);
const orderBy = {
  property_definitions: 'definition_key', string_dictionary: 'string_id', property_values: 'property_value_id',
  property_sets: 'property_set_id', property_set_values: 'property_set_id,property_value_id', types: 'type_id',
  elements: 'logical_element_id', levels: 'level_id', render_objects: 'render_object_id',
};
const semanticTableHashes = {};
for (const [table, order] of Object.entries(orderBy)) {
  const columns = oldDb.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  const sql = `SELECT ${columns.join(',')} FROM ${table} ORDER BY ${order}`;
  const tableHash = (db) => {
    const digest = createHash('sha256');
    for (const row of db.prepare(sql).iterate()) digest.update(JSON.stringify(Object.values(row))).update('\n');
    return digest.digest('hex');
  };
  const v2 = tableHash(oldDb), v3 = tableHash(newDb);
  assert.equal(v3, v2, `Stored semantic rows changed: ${table}`);
  semanticTableHashes[table] = v2;
}
const renderObjectId = oldDb.prepare('SELECT render_object_id FROM render_objects ORDER BY render_object_id LIMIT 1').get().render_object_id;
const system = oldDb.prepare("SELECT parameter_id FROM property_definitions WHERE name = 'System Name' ORDER BY parameter_id LIMIT 1").get();
const systemId = system ? `canonical:instance:${system.parameter_id}` : null;
const sqlite = oldDb.prepare('SELECT sqlite_version() AS version').get().version;
oldDb.close(); newDb.close();

const workloads = [
  ['definitions', (p) => store.getPropertyDefinitions(p), 9],
  ['element', (p) => store.getElementPropertiesForRenderObject(p, renderObjectId), 5],
];
for (const id of ['canonical:facet:category', 'canonical:facet:family', 'canonical:facet:type', systemId].filter(Boolean)) {
  const values = store.getPropertyValues(oldPath, id);
  const chosen = values.find((value) => value.displayValue.length > 0) ?? values[0];
  workloads.push([`values:${id}`, (p) => store.getPropertyValues(p, id), 5]);
  if (chosen) workloads.push([`matches:${id}`, (p) => store.getMatchingViewerObjectIds(p, id, [chosen.valueId]).sort(), 5]);
}

const results = [];
for (const [name, fn, runs] of workloads) {
  const oldResult = fn(oldPath);
  const newResult = fn(newPath);
  assert.deepEqual(newResult, oldResult, `Public result changed: ${name}`);
  const v2 = time(() => fn(oldPath), runs);
  const v3 = time(() => fn(newPath), runs);
  assert.deepEqual(v3.result, v2.result, `Measured public result changed: ${name}`);
  results.push({ name, count: Array.isArray(oldResult) ? oldResult.length : null, sha256: hash(oldResult),
    v2: { firstMs: v2.firstMs, warmMedianMs: v2.warmMedianMs, warmRangeMs: v2.warmRangeMs },
    v3: { firstMs: v3.firstMs, warmMedianMs: v3.warmMedianMs, warmRangeMs: v3.warmRangeMs } });
}
console.log(JSON.stringify({ node: process.version, sqlite, sizes: { v2: fs.statSync(oldPath).size, v3: fs.statSync(newPath).size }, counts, semanticTableHashes, results }, null, 2));
