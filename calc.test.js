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
const mNight = html.match(/\/\* ===NIGHT-START=== \*\/([\s\S]*?)\/\* ===NIGHT-END=== \*\//);
if (!mNight) { console.error('FAIL: night block not found in index.html'); process.exit(1); }
const { toSatang, chargeSatang, allocateExact, computeRestaurant, computeNight } =
  new Function(m[1] + mNight[1] + '; return {toSatang, chargeSatang, allocateExact, computeRestaurant, computeNight};')();

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

/* ---- 6. Combined night slip: worked example (mixed % and ฿ modes) ---- */
{
  // 3 people (0=Aum, 1=Bee, 2=Cee), 2 restaurants.
  const restaurants = [
    { items: [
        { name: 'Larb', price: '180', sharers: [0, 1] },
        { name: 'Som Tam', price: '120', sharers: [0, 1, 2] },
        { name: 'Rice', price: '60', sharers: [2] }],
      service: { on: true, mode: 'pct', value: 10 },
      vat: { on: true, mode: 'pct', value: 7 } },
    { items: [{ name: 'Cocktails', price: '900', sharers: [0, 1, 2] }],
      service: { on: true, mode: 'amt', value: 85 },
      vat: { on: true, mode: 'amt', value: 68.95 } }
  ];
  const n = computeNight(restaurants, 3);
  check('night: restaurant A total 423.72', n.perRest[0].total === 42372, n.perRest[0].total);
  check('night: restaurant B total 1053.95', n.perRest[1].total === 105395, n.perRest[1].total);
  check('night: grand total 1477.67', n.grandTotal === 147767, n.grandTotal);
  // Engine-verified settle figures (largest-remainder satang ties go to the earlier person):
  check('night: Aum owes 504.34', n.people[0].total === 50434, n.people[0].total);
  check('night: Bee owes 504.32', n.people[1].total === 50432, n.people[1].total);
  check('night: Cee owes 469.01', n.people[2].total === 46901, n.people[2].total);
  const settleSum = n.people.reduce((a, p) => a + p.total, 0);
  check('night: settle block sums to grand total exactly', settleSum === n.grandTotal, settleSum + ' vs ' + n.grandTotal);
  check('night: each breakdown line sums to that person\'s total',
    n.people.every(p => p.byRest.reduce((a, b) => a + b, 0) === p.total));
}

/* ---- 7. Night settle block reconciles across randomized nights, % and ฿ modes ---- */
{
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const price = () => (Math.floor(rnd() * 99900) + 100) / 100;
  let bad = '';
  for (let trial = 0; trial < 500 && !bad; trial++) {
    const nPeople = 2 + Math.floor(rnd() * 7);
    const amtMode = trial % 2 === 1;
    const restaurants = [];
    const nRest = 1 + Math.floor(rnd() * 4);
    for (let rI = 0; rI < nRest; rI++) {
      const items = [];
      const nItems = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < nItems; i++) {
        const sharers = [];
        for (let p = 0; p < nPeople; p++) if (rnd() < 0.5) sharers.push(p);
        items.push({ name: 'i' + i, price: String(price()), sharers }); // empty sharers allowed → unassigned item
      }
      restaurants.push({
        items,
        service: { on: rnd() < 0.9, mode: amtMode ? 'amt' : 'pct', value: amtMode ? price() : 10 },
        vat: { on: rnd() < 0.9, mode: amtMode ? 'amt' : 'pct', value: amtMode ? price() : 7 }
      });
    }
    const night = computeNight(restaurants, nPeople);
    const settleSum = night.people.reduce((a, p) => a + p.total, 0);
    const restSum = night.perRest.reduce((a, c) => a + c.total, 0);
    if (settleSum !== restSum || night.grandTotal !== restSum)
      bad = `trial ${trial} (${amtMode ? '฿' : '%'} mode): settle ${settleSum} vs restaurants ${restSum}`;
    const groupSum = night.groups.reduce((a, g) => a + g.total * g.members.length, 0);
    const groupCnt = night.groups.reduce((a, g) => a + g.members.length, 0);
    if (groupSum !== restSum || groupCnt !== nPeople)
      bad = `trial ${trial}: groups sum ${groupSum} vs ${restSum}, cover ${groupCnt}/${nPeople}`;
  }
  check('500 randomized nights: settle block = sum of restaurant totals, % and ฿ modes', bad === '', bad);
}

/* ---- 8. Edge cases the combined slip must survive ---- */
{
  // Person 2 ordered nothing: still listed, at exactly 0.
  const night = computeNight([{
    items: [{ name: 'Pad Thai', price: '95', sharers: [0, 1] }],
    service: { on: true, mode: 'pct', value: 10 },
    vat: { on: true, mode: 'pct', value: 7 }
  }], 3);
  check('zero-assigned person present at exactly 0 satang',
    night.people.length === 3 && night.people[2].total === 0, JSON.stringify(night.people[2]));
  // Restaurant with an unassigned item: excluded from totals, still balances exactly.
  const c = computeRestaurant({
    items: [{ name: 'counted', price: '200', sharers: [0, 1] }, { name: 'orphan', price: '999', sharers: [] }],
    service: { on: true, mode: 'amt', value: 22.10 },
    vat: { on: true, mode: 'pct', value: 7 }
  }, 2);
  check('unassigned item excluded from food subtotal', c.foodSubtotal === 20000, c.foodSubtotal);
  check('unassigned-item restaurant still balances exactly',
    c.perPerson.reduce((a, p) => a + p.total, 0) === c.total);
}

/* ---- 9. Settle-up grouping: identical bills group; satang-different bills must not ---- */
{
  // Two people share everything evenly with even satang → identical bills → one group.
  const nEq = computeNight([{
    items: [{ name: 'Set', price: '500', sharers: [0, 1] }],
    service: { on: true, mode: 'pct', value: 10 },
    vat: { on: true, mode: 'pct', value: 7 }
  }], 2);
  check('identical bills collapse into one group', nEq.groups.length === 1 && nEq.groups[0].members.length === 2, JSON.stringify(nEq.groups));
  check('grouped amount × members = restaurant total', nEq.groups[0].total * 2 === nEq.perRest[0].total);
  // Worked example: Aum and Bee differ by 2 satang (largest-remainder ties) → separate lines,
  // because the printed amount is the exact transfer amount.
  const rests = [
    { items: [
        { name: 'Larb', price: '180', sharers: [0, 1] },
        { name: 'Som Tam', price: '120', sharers: [0, 1, 2] },
        { name: 'Rice', price: '60', sharers: [2] }],
      service: { on: true, mode: 'pct', value: 10 },
      vat: { on: true, mode: 'pct', value: 7 } },
    { items: [{ name: 'Cocktails', price: '900', sharers: [0, 1, 2] }],
      service: { on: true, mode: 'amt', value: 85 },
      vat: { on: true, mode: 'amt', value: 68.95 } }
  ];
  const n = computeNight(rests, 3);
  check('satang-different totals stay separate groups', n.groups.length === 3, JSON.stringify(n.groups.map(g => g.total)));
  check('groups sorted largest first', n.groups[0].total === 50434 && n.groups[1].total === 50432 && n.groups[2].total === 46901);
  const covered = n.groups.flatMap(g => g.members).sort().join(',');
  check('groups partition every person exactly once', covered === '0,1,2', covered);
  const groupSum = n.groups.reduce((a, g) => a + g.total * g.members.length, 0);
  check('sum of group amount × member count = grand total', groupSum === n.grandTotal, groupSum + ' vs ' + n.grandTotal);
}

console.log(failed === 0 ? `PASS — ${passed} checks, 0 failures` : `${failed} FAILURES (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
