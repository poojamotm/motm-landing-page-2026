'use strict';
// Run: npm test  (no network: email, CRM and disk are faked)

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, CFG } = require('./lead-server');

const LEAD = {
  company_name: 'Acme Pumps', company_website: 'https://acme.com', industry: 'Industrial manufacturing',
  annual_revenue: '₹15–50 Cr', products_services: 'Industrial pumps\nValves', target_customers: 'OEMs, EPC companies',
  support_type: 'New customer acquisition', bottleneck: 'Low conversion', growth_goal: 'Grow exports',
  growth_challenges: 'Pipeline generation, Sales conversion', current_acquisition: 'Mixed', monthly_enquiries: '11–25',
  contact_name: 'Test User', business_email: 't@acme.com', phoneCountry: '+91', phone: '98765 43210',
  phone_full: '+919876543210', designation: 'Head of Sales', budget_free_text: '₹60,000/month',
  start_timeline: 'Within 30 days', utm_source: 'google', company_fax: '',
  industry_other: 'Packaging', growth_challenges_other: 'Pricing pressure',
  challenge_detail: 'Referrals dried up.\nTwo quarters now.\nPipeline down 40%.',
};

let saved, emails, crm, emailFail, crmFail, saveFail;
const servers = [];

function start(cfg = {}) {
  const app = createApp({ ...CFG, RATE_LIMIT: 1000, ...cfg }, {
    save: async (l) => { if (saveFail) throw new Error('disk'); saved.push(l); },
    sendEmail: async (l) => { if (emailFail) throw new Error('smtp down'); emails.push(l); },
    pushCrm: async (l) => { if (crmFail) throw new Error('crm down'); crm.push(l); },
    log: { error() {} },
  });
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`));
    servers.push(srv);
  });
}

async function post(base, data, type = 'application/json') {
  const res = await fetch(base + '/api/lead', {
    method: 'POST', headers: { 'Content-Type': type }, body: typeof data === 'string' ? data : JSON.stringify(data),
  });
  return [res.status, await res.json()];
}

let base;
beforeEach(async () => {
  saved = []; emails = []; crm = []; emailFail = crmFail = saveFail = false;
  base = base || await start();
});
after(() => servers.forEach((s) => s.close()));

test('valid lead is saved, emailed and pushed', async () => {
  assert.deepEqual(await post(base, LEAD), [200, { ok: true }]);
  assert.equal(saved[0].company_name, 'Acme Pumps');
  assert.equal(emails[0].annual_revenue, '₹15–50 Cr');
  assert.equal(crm[0].industry, 'Industrial manufacturing');
  assert.equal(saved[0].company_fax, undefined); // honeypot not stored
});

test('free text: optional fields, multi-line where allowed, length-limited', async () => {
  const minimal = { ...LEAD, company_website: '', current_acquisition: '', monthly_enquiries: '', budget_free_text: '', challenge_detail: '', designation: '' };
  assert.equal((await post(base, minimal))[0], 200);
  assert.equal((await post(base, LEAD))[0], 200);
  assert.equal(saved[1].challenge_detail, LEAD.challenge_detail);
  assert.equal(saved[1].products_services, LEAD.products_services);
  assert.equal((await post(base, { ...LEAD, challenge_detail: 'x'.repeat(2001) }))[0], 400);
  assert.equal((await post(base, { ...LEAD, growth_goal: 'A\nB' }))[0], 400); // still single-line
});

test('all eight challenges fit', async () => {
  const all = 'Pipeline generation, New-market expansion, Marketing-to-revenue conversion, Building a sales team, International business, Dealers/distributors, Sales conversion, Something else';
  assert.equal((await post(base, { ...LEAD, growth_challenges: all }))[0], 200);
  assert.equal(saved[0].growth_challenges, all);
});

test('missing field rejected and nothing stored', async () => {
  for (const k of ['company_name', 'industry', 'annual_revenue', 'products_services', 'target_customers', 'support_type',
    'bottleneck', 'growth_goal', 'growth_challenges', 'contact_name', 'start_timeline']) {
    const [c, r] = await post(base, { ...LEAD, [k]: '' });
    assert.equal(c, 400);
    assert.match(r.error, new RegExp(k));
  }
  assert.equal(saved.length, 0);
});

test('bad email, header injection, wrong types rejected', async () => {
  assert.equal((await post(base, { ...LEAD, business_email: 'nope' }))[0], 400);
  assert.equal((await post(base, { ...LEAD, contact_name: 'A\r\nBcc: x@y.z' }))[0], 400);
  assert.equal((await post(base, { ...LEAD, phone: ['1'] }))[0], 400);
  assert.equal((await post(base, [LEAD]))[0], 400);
});

test('bad JSON, wrong content type, oversized body', async () => {
  assert.equal((await post(base, '{nope'))[0], 400);
  assert.equal((await post(base, 'a=b', 'application/x-www-form-urlencoded'))[0], 415);
  assert.equal((await post(base, { ...LEAD, pad: 'x'.repeat(30_000) }))[0], 413);
});

test('honeypot pretends success and drops', async () => {
  assert.equal((await post(base, { ...LEAD, company_fax: 'spam' }))[0], 200);
  assert.equal(saved.length + emails.length + crm.length, 0);
});

test('meeting request needs a slot', async () => {
  assert.equal((await post(base, { ...LEAD, type: 'meeting_request' }))[0], 400);
  assert.equal((await post(base, { ...LEAD, type: 'meeting_request', requested_slot: 'Mon 10:00 IST' }))[0], 200);
  assert.equal(crm[0].type, 'meeting_request');
});

test('one channel down still succeeds', async () => {
  crmFail = true;
  assert.equal((await post(base, LEAD))[0], 200);
  assert.equal(emails.length, 1);
});

test('both channels down returns 502 but lead is kept', async () => {
  crmFail = emailFail = true;
  assert.equal((await post(base, LEAD))[0], 502);
  assert.equal(saved.length, 1);
});

test('disk failure returns 500 and skips delivery', async () => {
  saveFail = true;
  assert.equal((await post(base, LEAD))[0], 500);
  assert.equal(emails.length + crm.length, 0);
});

test('rate limit per IP', async () => {
  const limited = await start({ RATE_LIMIT: 2 });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await post(limited, LEAD))[0]);
  assert.deepEqual(codes, [200, 200, 429]);
});

test('unknown route 404, health ok', async () => {
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.deepEqual(await (await fetch(base + '/api/health')).json(), { ok: true });
});

test('CRM request: field mapping, auth header, non-2xx throws', async (t) => {
  const { makeCrm } = require('./lead-server');
  const calls = [];
  let status = 201;
  t.mock.method(globalThis, 'fetch', async (url, opts) => { calls.push([url, opts]); return { ok: status < 300, status }; });
  const push = makeCrm({ B2BOTIX_API_URL: 'https://crm.test/leads', B2BOTIX_API_KEY: 'k' });
  await push({ ...LEAD, type: 'lead', received_at: 'now' });
  const [url, opts] = calls[0];
  const body = JSON.parse(opts.body);
  assert.equal(url, 'https://crm.test/leads');
  assert.equal(opts.headers.Authorization, 'Bearer k');
  assert.deepEqual([body.company_name, body.phone, body.annual_revenue], ['Acme Pumps', '+919876543210', '₹15–50 Cr']);
  assert.deepEqual(body.attribution, { utm_source: 'google' });
  for (const k of ['company_website', 'industry', 'products_services', 'target_customers', 'support_type', 'bottleneck',
    'growth_goal', 'growth_challenges', 'current_acquisition', 'monthly_enquiries', 'contact_name', 'designation', 'business_email',
    'budget_free_text', 'start_timeline', 'challenge_detail', 'industry_other', 'growth_challenges_other']) assert.equal(body[k], LEAD[k], k);
  status = 401;
  await assert.rejects(push({ ...LEAD, type: 'lead' }), /401/);
  await assert.rejects(makeCrm({})(LEAD), /not configured/);
});

test('email: recipient, reply-to, subject and body', async (t) => {
  const nodemailer = require('nodemailer');
  const sent = [];
  t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (m) => sent.push(m) }));
  const { makeMailer } = require('./lead-server');
  await makeMailer({ ...CFG, SMTP_HOST: 'smtp.test', SMTP_USER: 'no-reply@motm.tech' })({ ...LEAD, type: 'meeting_request', requested_slot: 'Mon 10:00 IST', received_at: 'now' });
  const m = sent[0];
  assert.deepEqual([m.to, m.replyTo, m.from], ['hello@motm.tech', 't@acme.com', 'no-reply@motm.tech']);
  assert.equal(m.subject, 'Meeting request: Test User — Acme Pumps');
  assert.match(m.text, /Annual revenue: ₹15–50 Cr/);
  assert.match(m.text, /Growth challenges: Pipeline generation, Sales conversion\n/);
  assert.match(m.text, /Budget: ₹60,000\/month\nStart timeline: Within 30 days\nChallenge detail: Referrals dried up\.\nTwo quarters now\./);
  assert.match(m.text, /Requested meeting slot: Mon 10:00 IST/);
  await assert.rejects(makeMailer({ ...CFG, SMTP_HOST: '' })(LEAD), /not configured/);
});
