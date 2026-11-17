import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSegment, applySeen, buildReport, isConfigToOrder, segmentKey, type WatchSegment } from './new-products.ts';
import type { SupplierProduct } from '../types.ts';

const seg: WatchSegment = { manufacturer: 'Apple', class: 'COMPORT', subclass: 'NOTEBOOKS', label: 'Apple bærbare' };

function prod(mpn: string, extra: Partial<SupplierProduct> = {}): SupplierProduct {
  return { mpn, supplier: 'tdsynnex', manufacturer: 'APPLE', name: `MacBook ${mpn}`, price_ex_vat: 20000, available_qty: 5, updated_at: '', ...extra };
}

test('isConfigToOrder fanger CTO-suffiks og Apple Z-koder, men ikke vanlige /A-MPN-er', () => {
  assert.equal(isConfigToOrder({ mpn: 'MHWT4H/A_CTO', manufacturer: 'APPLE' }), true);
  assert.equal(isConfigToOrder({ mpn: 'Z1UL', manufacturer: 'APPLE' }), true);
  assert.equal(isConfigToOrder({ mpn: 'Z1UL0001ND', manufacturer: 'Apple' }), true);
  assert.equal(isConfigToOrder({ mpn: 'MHWT4H/A', manufacturer: 'APPLE' }), false);
  assert.equal(isConfigToOrder({ mpn: 'Z2ABCD', manufacturer: 'HP' }), false);
});

test('første kjøring er baseline: registrerer alt, oppretter ingenting', () => {
  const plan = planSegment(seg, [prod('A1'), prod('A2', { available_qty: 0 })], undefined, new Set());
  assert.equal(plan.baseline, true);
  assert.equal(plan.toCreate.length, 0);
  assert.deepEqual(plan.markSeen.sort(), ['A1', 'A2']);
});

test('nye siden forrige kjøring opprettes; kjente, sette og CTO hoppes over', () => {
  const plan = planSegment(
    seg,
    [prod('OLD'), prod('KNOWN'), prod('NEW1'), prod('NEW1'), prod('Z1UL'), prod('NOPRICE', { price_ex_vat: null })],
    { OLD: '2026-11-01' },
    new Set(['KNOWN'])
  );
  assert.deepEqual(plan.toCreate.map(p => p.mpn), ['NEW1']);
  assert.deepEqual(plan.markSeen.sort(), ['KNOWN', 'NEW1']);
});

test('nye uten lager venter og registreres ikke som sett; innkommende leveranse teller som lager', () => {
  const plan = planSegment(
    seg,
    [prod('EMPTY', { available_qty: 0 }), prod('INCOMING', { available_qty: 0, next_delivery_date: '2026-12-01' })],
    {},
    new Set()
  );
  assert.deepEqual(plan.waitingForStock.map(p => p.mpn), ['EMPTY']);
  assert.deepEqual(plan.toCreate.map(p => p.mpn), ['INCOMING']);
  assert.deepEqual(plan.markSeen, ['INCOMING']);
});

test('nameFilter avgrenser segmentet og inngår i nøkkelen', () => {
  const s = { ...seg, nameFilter: 'iMac' };
  const plan = planSegment(s, [prod('X', { name: 'iMac 24' }), prod('Y', { name: 'Mac mini' })], {}, new Set());
  assert.deepEqual(plan.toCreate.map(p => p.mpn), ['X']);
  assert.notEqual(segmentKey(s), segmentKey(seg));
});

test('applySeen beholder første dato', () => {
  const seen = { k: { A: '2026-01-01' } };
  applySeen(seen, 'k', ['A', 'B'], '2026-11-17');
  assert.deepEqual(seen.k, { A: '2026-01-01', B: '2026-11-17' });
});

test('buildReport: null uten nyheter, varsel over taket', () => {
  const empty = planSegment(seg, [], {}, new Set());
  assert.equal(buildReport({ plans: [empty], created: 0, capExceeded: false, maxNewPerRun: 30, errors: [] }), null);
  const plan = planSegment(seg, [prod('N1'), prod('N2')], {}, new Set());
  const ok = buildReport({ plans: [plan], created: 2, capExceeded: false, maxNewPerRun: 30, errors: [] })!;
  assert.match(ok, /2 nye produkter er lagt inn skjult/);
  assert.match(ok, /`N1`/);
  const over = buildReport({ plans: [plan], created: 0, capExceeded: true, maxNewPerRun: 1, errors: [] })!;
  assert.match(over, /Ingenting er opprettet/);
});
