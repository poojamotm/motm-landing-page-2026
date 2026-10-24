'use strict';
/**
 * MOTM lead endpoint: POST /api/lead -> save to disk, email the team, push to B2Botix CRM.
 * Configured by environment variables (see .env.example). Run behind nginx, which
 * proxies /api/ to 127.0.0.1:$PORT.
 */

const fs = require('node:fs/promises');
const express = require('express');
const nodemailer = require('nodemailer');

const env = process.env;
const CFG = {
  HOST: env.HOST || '127.0.0.1',
  PORT: Number(env.PORT || 8787),
  // keep outside the web root: it holds personal data
  LEADS_FILE: env.LEADS_FILE || '/var/lib/motm-lead/leads.jsonl',
  MAIL_TO: env.MAIL_TO || 'hello@motm.tech',
  MAIL_FROM: env.MAIL_FROM || '',
  SMTP_HOST: env.SMTP_HOST || '',
  SMTP_PORT: Number(env.SMTP_PORT || 587),
  SMTP_USER: env.SMTP_USER || '',
  SMTP_PASS: env.SMTP_PASS || '',
  B2BOTIX_API_URL: env.B2BOTIX_API_URL || '',
  B2BOTIX_API_KEY: env.B2BOTIX_API_KEY || '',
  RATE_LIMIT: Number(env.RATE_LIMIT || 10), // requests per IP per 10 minutes
};

// field -> max length; these are the form's field names, which are also the CRM keys
const REQUIRED = {
  company_name: 200, industry: 100, annual_revenue: 100, products_services: 2000, target_customers: 300,
  support_type: 100, bottleneck: 100, growth_goal: 100,
  // growth_challenges: one or more ticked options, comma-separated
  growth_challenges: 400, contact_name: 150, business_email: 254, phone: 40, start_timeline: 50,
};
const OPTIONAL = {
  company_website: 300, current_acquisition: 100, monthly_enquiries: 50, budget_free_text: 200,
  challenge_detail: 2000, designation: 150,
  // "Please specify…" text for Other / Something else answers
  industry_other: 200, bottleneck_other: 200, growth_goal_other: 200, growth_challenges_other: 200,
  phoneCountry: 8, phone_full: 40, requested_slot: 120, type: 30,
  utm_source: 200, utm_medium: 200, utm_campaign: 200, utm_term: 200, utm_content: 200,
  gclid: 300, fbclid: 300, msclkid: 300, li_fat_id: 300,
  referrer: 1000, landing_page: 1000, growth_problem_card: 200,
};
// free-text fields where line breaks are allowed (never used in email headers)
const MULTILINE = new Set(['products_services', 'challenge_detail']);
const ATTRIBUTION = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid',
  'msclkid', 'li_fat_id', 'referrer', 'landing_page', 'growth_problem_card'];
// lead fields sent to the CRM under their own key
const CRM_KEYS = ['company_name', 'company_website', 'industry', 'annual_revenue', 'products_services',
  'target_customers', 'support_type', 'bottleneck', 'growth_goal', 'growth_challenges', 'current_acquisition',
  'monthly_enquiries', 'contact_name', 'designation', 'business_email', 'budget_free_text', 'start_timeline', 'challenge_detail',
  'industry_other', 'bottleneck_other', 'growth_goal_other', 'growth_challenges_other'];
const LABELS = [
  ['contact_name', 'Name'], ['designation', 'Designation'], ['company_name', 'Company'], ['company_website', 'Website'],
  ['business_email', 'Business email'], ['phone_full', 'Phone'],
  ['industry', 'Industry'], ['industry_other', 'Industry (other)'], ['annual_revenue', 'Annual revenue'], ['products_services', 'Products / services'],
  ['target_customers', 'Target customers'], ['support_type', 'Support wanted'],
  ['bottleneck', 'Losing opportunities at'], ['bottleneck_other', 'Losing opportunities at (other)'], ['growth_goal', '12-month growth goal'], ['growth_goal_other', 'Growth goal (other)'],
  ['growth_challenges', 'Growth challenges'], ['growth_challenges_other', 'Growth challenges (other)'], ['current_acquisition', 'Current acquisition'],
  ['monthly_enquiries', 'Qualified enquiries / month'], ['budget_free_text', 'Budget'],
  ['start_timeline', 'Start timeline'], ['challenge_detail', 'Challenge detail'],
  ['requested_slot', 'Requested meeting slot'], ['growth_problem_card', 'Growth problem card'],
  ['utm_source', 'UTM source'], ['utm_medium', 'UTM medium'], ['utm_campaign', 'UTM campaign'],
  ['utm_term', 'UTM term'], ['utm_content', 'UTM content'], ['gclid', 'gclid'], ['fbclid', 'fbclid'],
  ['msclkid', 'msclkid'], ['li_fat_id', 'li_fat_id'], ['referrer', 'Referrer'], ['landing_page', 'Landing page'],
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HONEYPOT = 'company_fax';

class BadRequest extends Error {}

/** Validate and normalise a submitted lead. Throws BadRequest. */
function clean(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequest('Invalid payload');
  const lead = {};
  for (const [key, limit] of Object.entries({ ...REQUIRED, ...OPTIONAL })) {
    let val = raw[key] ?? '';
    if (typeof val !== 'string') throw new BadRequest(`Invalid ${key}`);
    val = val.trim();
    if (val.length > limit || (!MULTILINE.has(key) && /[\r\n]/.test(val))) throw new BadRequest(`Invalid ${key}`);
    if (val) lead[key] = val;
  }
  const missing = Object.keys(REQUIRED).filter((k) => !(k in lead));
  if (missing.length) throw new BadRequest('Missing: ' + missing.join(', '));
  if (!EMAIL_RE.test(lead.business_email)) throw new BadRequest('Invalid business_email');
  if (lead.phone.replace(/\D/g, '').length < 7) throw new BadRequest('Invalid phone');
  lead.type = lead.type === 'meeting_request' ? 'meeting_request' : 'lead';
  if (lead.type === 'meeting_request' && !lead.requested_slot) throw new BadRequest('Missing: requested_slot');
  if (!lead.phone_full) lead.phone_full = (lead.phoneCountry || '') + lead.phone.replace(/\D/g, '');
  return lead;
}

function rateLimiter(cfg) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 600_000);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 10_000) { // keep memory bounded
      for (const [k, v] of hits) if (now - v[v.length - 1] > 600_000) hits.delete(k);
    }
    return recent.length > cfg.RATE_LIMIT;
  };
}

function makeMailer(cfg) {
  const transport = cfg.SMTP_HOST && nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_PORT === 465,
    requireTLS: cfg.SMTP_PORT !== 465,
    auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
    connectionTimeout: 15_000,
    socketTimeout: 15_000,
  });
  return async (lead) => {
    if (!transport) throw new Error('SMTP_HOST not configured');
    const kind = lead.type === 'meeting_request' ? 'Meeting request' : 'New lead';
    const lines = [`${kind} from the MOTM landing page`, `Received: ${lead.received_at}`, '',
      ...LABELS.filter(([k]) => lead[k]).map(([k, label]) => `${label}: ${lead[k]}`)];
    await transport.sendMail({
      from: cfg.MAIL_FROM || cfg.SMTP_USER,
      to: cfg.MAIL_TO,
      replyTo: lead.business_email,
      subject: `${kind}: ${lead.contact_name} — ${lead.company_name}`,
      text: lines.join('\n'),
    });
  };
}

function makeCrm(cfg) {
  return async (lead) => {
    if (!cfg.B2BOTIX_API_URL) throw new Error('B2BOTIX_API_URL not configured');
    // shortcut: generic JSON + Bearer auth; adjust field names/auth here to match the B2Botix API spec
    const body = {
      ...Object.fromEntries(CRM_KEYS.map((k) => [k, lead[k] || ''])),
      phone: lead.phone_full,
      requested_slot: lead.requested_slot || '',
      type: lead.type,
      source: 'MOTM landing page',
      attribution: Object.fromEntries(ATTRIBUTION.filter((k) => lead[k]).map((k) => [k, lead[k]])),
      received_at: lead.received_at,
    };
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (cfg.B2BOTIX_API_KEY) headers.Authorization = 'Bearer ' + cfg.B2BOTIX_API_KEY;
    const res = await fetch(cfg.B2BOTIX_API_URL, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`B2Botix returned ${res.status}`);
  };
}

/** Build the app. `deps` lets tests swap email/CRM/save for fakes. */
function createApp(cfg = CFG, deps = {}) {
  const sendEmail = deps.sendEmail || makeMailer(cfg);
  const pushCrm = deps.pushCrm || makeCrm(cfg);
  const save = deps.save || ((lead) => fs.appendFile(cfg.LEADS_FILE, JSON.stringify(lead) + '\n', 'utf8'));
  const log = deps.log || console;
  const limited = rateLimiter(cfg);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // nginx on the same host sets X-Forwarded-For
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.post('/api/lead',
    (req, res, next) => (req.is('application/json')
      ? next() : res.status(415).json({ ok: false, error: 'Expected JSON' })),
    (req, res, next) => (limited(req.ip)
      ? res.status(429).json({ ok: false, error: 'Too many requests' }) : next()),
    express.json({ limit: '20kb', strict: true }),
    async (req, res) => {
      if (req.body && req.body[HONEYPOT]) return res.json({ ok: true }); // bot: pretend success, store nothing
      let lead;
      try {
        lead = clean(req.body);
      } catch (e) {
        if (e instanceof BadRequest) return res.status(400).json({ ok: false, error: e.message });
        throw e;
      }
      lead.received_at = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
      lead.ip = req.ip;
      lead.user_agent = (req.get('user-agent') || '').slice(0, 300);

      // disk first, so a lead is never lost even if email and CRM both fail
      try {
        await save(lead);
      } catch (e) {
        log.error('could not save lead', e);
        return res.status(500).json({ ok: false, error: 'Server error' });
      }

      const results = await Promise.allSettled([sendEmail(lead), pushCrm(lead)]);
      results.forEach((r, i) => {
        if (r.status === 'rejected') log.error(`${i ? 'crm' : 'email'} delivery failed for ${lead.business_email}:`, r.reason);
      });
      if (results.every((r) => r.status === 'rejected')) {
        return res.status(502).json({ ok: false, error: 'Delivery failed' });
      }
      res.json({ ok: true });
    });

  app.use((req, res) => res.status(404).json({ ok: false }));

  // body-parser errors (bad JSON, too large) and anything unexpected
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'Invalid body size' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    log.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  });

  return app;
}

if (require.main === module) {
  createApp().listen(CFG.PORT, CFG.HOST, () => console.log(`listening on ${CFG.HOST}:${CFG.PORT}`));
}

module.exports = { createApp, clean, makeMailer, makeCrm, CFG };
