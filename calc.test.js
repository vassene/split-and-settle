#!/usr/bin/env node
/* Split & Settle — calculation proof.
   Extracts the live calc code straight out of index.html (between ===CALC-START===
   and ===CALC-END===) so the tested code is byte-identical to what ships.

   Proves:
   1. Billing order: service on food subtotal; VAT on (food + service), never food alone.
   2. ฿ (fixed) mode: totals use the exact printed amounts.
   3. Zero drift: every person's shares sum EXACTLY to the restaurant total,
      in both % and ฿ modes, across thousands of randomized bills.
   Run: node calc.test.js */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/\/\* ===CALC-START=== \*\/([\s\S]*?)\/\* ===CALC-END=== \*\//);
if (!m) { console.error('FAIL: calc block not found in index.html'); process.exit(1); }
const { toSatang, chargeSatang, allocateExact, computeRestaurant } =
  new Function(m[1] + '; return {toSatang, chargeSatang, allocateExact, computeRestaurant};')();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name, detail || ''); }
}

/* ---- 1. Known-value case: billing order ---- */
{
  // Food 1000.00, service 10% = 100.00, VAT 7% of 1100.00 = 77.00, total 1177.00
  const rest = {
    items: [{ name: 'Set', price: '1000', sharers: [0, 1] }],
    service: { on: true, mode: 'pct', value: 10 },
    vat: { on: true, mode: 'pct', value: 7 }
  };
  const c = computeRestaurant(rest, 2);
  check('food subtotal', c.foodSubtotal === 100000, c.foodSubtotal);
  check('service = 10% of food', c.serviceAmt === 10000, c.serviceAmt);
  check('VAT = 7% of (food+service), NOT food alone', c.vatAmt === 7700, c.vatAmt); // 7% of food alone would be 7000
  check('restaurant total 1177.00', c.total === 117700, c.total);
  check('two people split 1177 exactly', c.perPerson[0].total + c.perPerson[1].total === 117700);
}

/* ---- 2. ฿ fixed mode matches the printed receipt ---- */
{
  const rest = {
    items: [{ name: 'A', price: '333.33', sharers: [0] }, { name: 'B', price: '210', sharers: [0, 1, 2] }],
    service: { on: true, mode: 'amt', value: 54.35 },  // printed baht
    vat: { on: true, mode: 'amt', value: 41.79 }       // printed baht
  };
  const c = computeRestaurant(rest, 3);
  check('฿ service exact', c.serviceAmt === 5435, c.serviceAmt);
  check('฿ VAT exact', c.vatAmt === 4179, c.vatAmt);
  check('฿ total = food + printed charges', c.total === toSatang(333.33) + toSatang(210) + 5435 + 4179);
  const sum = c.perPerson.reduce((a, p) => a + p.total, 0);
  check('฿ mode shares sum exactly', sum === c.total, sum + ' vs ' + c.total);
}

/* ---- 3. Awkward split: ÷3 of 100.00 ---- */
{
  const rest = {
    items: [{ name: 'Shared', price: '100', sharers: [0, 1, 2] }],
    service: { on: false, mode: 'pct', value: 10 },
    vat: { on: false, mode: 'pct', value: 7 }
  };
  const c = computeRestaurant(rest, 3);
  const foods = c.perPerson.map(p => p.food).sort((a, b) => a - b);
  check('100/3 → 33.33+33.33+33.34', foods[0] === 3333 && foods[1] === 3333 && foods[2] === 3334, foods.join(','));
  check('100/3 sums exactly', c.perPerson.reduce((a, p) => a + p.total, 0) === 10000);
}

/* ---- 4. Randomized drift hunt: % and ฿ modes ---- */
{
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const price = () => (Math.floor(rnd() * 99900) + 100) / 100; // ฿1.00–999.00
  let worstNote = '';
  for (let trial = 0; trial < 5000; trial++) {
    const nPeople = 2 + Math.floor(rnd() * 7);           // 2–8 people
    const nItems = 1 + Math.floor(rnd() * 12);           // 1–12 items
    const items = [];
    for (let i = 0; i < nItems; i++) {
      const sharers = [];
      for (let p = 0; p < nPeople; p++) if (rnd() < 0.5) sharers.push(p);
      if (!sharers.length) sharers.push(Math.floor(rnd() * nPeople));
      items.push({ name: 'i' + i, price: String(price()), sharers });
    }
    const pctMode = trial % 2 === 0;
    const rest = {
      items,
      service: { on: rnd() < 0.85, mode: pctMode ? 'pct' : 'amt', value: pctMode ? [5, 10, 12.5][trial % 3] : price() },
      vat: { on: rnd() < 0.9, mode: pctMode ? 'pct' : 'amt', value: pctMode ? 7 : price() }
    };
    const c = computeRestaurant(rest, nPeople);
    const sumTotal = c.perPerson.reduce((a, p) => a + p.total, 0);
    const sumFood = c.perPerson.reduce((a, p) => a + p.food, 0);
    const sumSvc = c.perPerson.reduce((a, p) => a + p.service, 0);
    const sumVat = c.perPerson.reduce((a, p) => a + p.vat, 0);
    if (sumTotal !== c.total || sumFood !== c.foodSubtotal || sumSvc !== c.serviceAmt || sumVat !== c.vatAmt) {
      worstNote = `trial ${trial} (${pctMode ? '%' : '฿'} mode): people=${nPeople} total ${sumTotal} vs ${c.total}`;
      break;
    }
    if (c.total !== c.foodSubtotal + c.serviceAmt + c.vatAmt) { worstNote = 'component sum broke at trial ' + trial; break; }
  }
  check('5000 randomized bills: zero rounding drift in % and ฿ modes', worstNote === '', worstNote);
}

/* ---- 5. Proportionality sanity ---- */
{
  // Person 0 ordered 3x what person 1 did → their service & VAT ≈ 3x (within 1 satang)
  const rest = {
    items: [{ name: 'big', price: '300', sharers: [0] }, { name: 'small', price: '100', sharers: [1] }],
    service: { on: true, mode: 'pct', value: 10 },
    vat: { on: true, mode: 'amt', value: 29.47 }
  };
  const c = computeRestaurant(rest, 2);
  check('service proportional', Math.abs(c.perPerson[0].service - 3 * c.perPerson[1].service) <= 3);
  check('VAT proportional in ฿ mode', Math.abs(c.perPerson[0].vat - 3 * c.perPerson[1].vat) <= 3);
  check('still sums exactly', c.perPerson[0].total + c.perPerson[1].total === c.total);
}

console.log(failed === 0 ? `PASS — ${passed} checks, 0 failures` : `${failed} FAILURES (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
