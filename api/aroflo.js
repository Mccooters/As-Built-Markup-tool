/* AirMark — AroFlo API proxy (Vercel serverless function).
 *
 * AroFlo's API is signed with a secret HMAC key that must NEVER ship in
 * browser code, so the app talks to this tiny proxy instead. The proxy holds
 * the credentials in environment variables, signs each request the way
 * AroFlo expects (HMAC-SHA512 over METHOD+urlPath+accept+authorization+
 * timestamp+varString), forwards a locked-down set of read-only queries,
 * and returns slimmed JSON to the app.
 *
 * Environment variables (Vercel → Project → Settings → Environment Variables):
 *   AROFLO_SECRET       Secret key generated in AroFlo (Site Admin → Settings → AroFlo API)
 *   AROFLO_UENCODED     "uencoded" credential string from the same page
 *   AROFLO_PENCODED     "pencoded" credential string
 *   AROFLO_ORGENCODED   "orgEncoded" credential string
 *   AROFLO_PROXY_TOKEN  optional shared secret; when set, callers must send it
 *                       (X-Proxy-Token header) — strongly recommended
 *   AROFLO_HOST_IP      optional, only if your AroFlo API setup specifies a Host IP
 *   AROFLO_BASE_URL     optional override of https://api.aroflo.com/ (testing)
 *
 * Only GET (read) actions are exposed: ping, inventory, stocklevels, task,
 * taskmaterials. Nothing here can write to AroFlo.
 */
'use strict';

const crypto = require('node:crypto');

const ACCEPT = 'text/json';
const PAGE_SIZE = 250; // modest pages keep well under AroFlo's 3.5 MB response cap
const env = n => (process.env[n] || '').trim();

/* ---------------- AroFlo request signing ---------------- */

function authorizationHeader() {
  const enc = encodeURIComponent;
  return `uencoded=${enc(env('AROFLO_UENCODED'))}&pencoded=${enc(env('AROFLO_PENCODED'))}&orgEncoded=${enc(env('AROFLO_ORGENCODED'))}`;
}

function signPayload(method, varString, authorization, afDateTimeUtc) {
  const parts = [method];
  const hostIp = env('AROFLO_HOST_IP');
  if (hostIp) parts.push(hostIp);
  parts.push('');                       // urlPath (empty — API root)
  parts.push(ACCEPT, authorization, afDateTimeUtc, varString);
  return crypto.createHmac('sha512', env('AROFLO_SECRET')).update(parts.join('+')).digest('hex');
}

function buildVarString(zone, opts = {}) {
  const parts = [`zone=${encodeURIComponent(zone)}`];
  for (const w of opts.where || []) parts.push(`where=${encodeURIComponent(w)}`);
  for (const o of opts.order || []) parts.push(`order=${encodeURIComponent(o)}`);
  for (const j of opts.join || []) parts.push(`join=${encodeURIComponent(j)}`);
  if (opts.page != null) parts.push(`page=${encodeURIComponent(opts.page)}`);
  if (opts.pageSize != null) parts.push(`pageSize=${encodeURIComponent(opts.pageSize)}`);
  return parts.join('&');
}

async function aroGet(zone, opts) {
  const varString = buildVarString(zone, opts);
  const afDateTimeUtc = new Date().toISOString();
  const authorization = authorizationHeader();
  const signature = signPayload('GET', varString, authorization, afDateTimeUtc);

  const headers = {
    Authentication: `HMAC ${signature}`,
    Authorization: authorization,
    Accept: ACCEPT,
    afdatetimeutc: afDateTimeUtc,
  };
  const hostIp = env('AROFLO_HOST_IP');
  if (hostIp) headers.HostIP = hostIp;

  const url = new URL(env('AROFLO_BASE_URL') || 'https://api.aroflo.com/');
  url.search = varString;

  const resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) });
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* leave null */ }

  const rateLimits = {};
  resp.headers.forEach((v, k) => { if (/ratelimit/i.test(k)) rateLimits[k.toLowerCase()] = v; });

  const status = body && body.status != null ? Number(body.status) : null;
  return {
    ok: resp.status < 400 && (status === 0 || status === null),
    httpStatus: resp.status,
    status,
    statusmessage: body ? (body.statusmessage || '') : ('Non-JSON response: ' + text.slice(0, 200)),
    zoneresponse: body ? (body.zoneresponse || {}) : {},
    rateLimits,
    varString,
  };
}

/* ---------------- response slimming ---------------- */

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const str = v => (v == null ? '' : String(v));

function slimLevels(levels) {
  return (Array.isArray(levels) ? levels : []).map(l => ({
    to: str(l.assignedto),
    type: str(l.assignedtotype),
    qty: num(l.quantity),
    updated: str(l.lastupdated || l.lastupdatedutc),
  }));
}

function pageMeta(zr, pageSize) {
  const count = num(zr.currentpageresults);
  return { page: num(zr.pagenumber) || 1, count, last: count < pageSize };
}

function relay(r, extra) {
  return {
    ok: r.ok, httpStatus: r.httpStatus, status: r.status,
    statusmessage: r.statusmessage, rateLimits: r.rateLimits, varString: r.varString,
    ...extra,
  };
}

/* ---------------- actions (read-only allowlist) ---------------- */

const ACTIONS = {

  // Connection test: returns the business unit name(s).
  async ping() {
    const r = await aroGet('businessunits', { page: 1, pageSize: 10 });
    const bus = (r.zoneresponse.businessunits || []).map(b => str(b.orgname)).filter(Boolean);
    return relay(r, { businessUnits: bus });
  },

  // One page of the inventory list with stock levels joined.
  // The explicit createdutc where-clause overrides AroFlo's default
  // "created in the last 30 days" filter so the whole catalogue comes back.
  async inventory(q) {
    const page = Math.min(60, Math.max(1, parseInt(q.page, 10) || 1));
    const r = await aroGet('inventory', {
      join: ['stocklevels'],
      where: ['and|createdutc|>|2000-01-01'],
      order: ['description|asc'],
      page, pageSize: PAGE_SIZE,
    });
    const items = (r.zoneresponse.items || []).map(it => ({
      id: str(it.itemid),
      desc: str(it.description),
      pn: str(it.partnumber),
      cat: it.category ? str(it.category.categoryname) : '',
      levels: slimLevels(it.stocklevels),
    }));
    return relay(r, { items, ...pageMeta(r.zoneresponse, PAGE_SIZE) });
  },

  // Current stock levels for one item (fresh read, bypasses the 30-day default).
  async stocklevels(q) {
    const itemid = str(q.itemid).trim();
    if (!itemid) return { ok: false, httpStatus: 400, statusmessage: 'itemid required' };
    const r = await aroGet('inventorystocklevels', {
      where: [`and|itemid|=|${itemid}`, 'and|lastupdatedutc|>|2000-01-01 00:00:00'],
      page: 1, pageSize: PAGE_SIZE,
    });
    return relay(r, { levels: slimLevels(r.zoneresponse.inventorystocklevels) });
  },

  // Find task(s) by job number (or a specific taskid) so materials can be listed.
  async task(q) {
    const where = ['and|daterequested|>|2000-01-01'];
    const taskid = str(q.taskid).trim();
    const jobnumber = str(q.jobnumber).replace(/\D+/g, '');
    if (taskid) where.push(`and|taskid|=|${taskid}`);
    else if (jobnumber) where.push(`and|jobnumber|=|${jobnumber}`);
    else return { ok: false, httpStatus: 400, statusmessage: 'jobnumber or taskid required' };
    const r = await aroGet('tasks', { where, page: 1, pageSize: 25 });
    const tasks = (r.zoneresponse.tasks || []).map(t => ({
      taskid: str(t.taskid),
      name: str(t.taskname),
      job: str(t.jobnumber),
      type: str(t.tasktype),
      status: str(t.status),
      client: t.client ? str(t.client.clientname) : '',
    }));
    return relay(r, { tasks });
  },

  // Materials recorded against a task (what the job has used).
  async taskmaterials(q) {
    const taskid = str(q.taskid).trim();
    if (!taskid) return { ok: false, httpStatus: 400, statusmessage: 'taskid required' };
    const r = await aroGet('taskmaterials', {
      where: [`and|taskid|=|${taskid}`, 'and|dateused|>|2000-01-01'],
      order: ['dateused|desc'],
      page: 1, pageSize: PAGE_SIZE,
    });
    const materials = (r.zoneresponse.materials || [])
      .filter(m => str(m.deleted) !== 'true')
      .map(m => ({
        item: str(m.item),
        pn: str(m.partnumber),
        qty: num(m.quantity),
        date: str(m.dateused),
        itemid: str(m.itemid),
      }));
    return relay(r, { materials });
  },
};

/* ---------------- HTTP handler ---------------- */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Proxy-Token, Content-Type');
  res.end(body);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Proxy-Token, Content-Type');
    res.end();
    return;
  }
  if (req.method !== 'GET') { send(res, 405, { ok: false, statusmessage: 'GET only' }); return; }

  // query params (works under Vercel and plain node:http alike)
  const u = new URL(req.url, 'http://local');
  const q = Object.fromEntries(u.searchParams.entries());

  const gate = env('AROFLO_PROXY_TOKEN');
  if (gate) {
    const given = str(req.headers['x-proxy-token'] || q.token);
    const a = Buffer.from(given), b = Buffer.from(gate);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      send(res, 401, { ok: false, statusmessage: 'Bad or missing proxy token' });
      return;
    }
  }

  if (!env('AROFLO_SECRET') || !env('AROFLO_UENCODED') || !env('AROFLO_PENCODED') || !env('AROFLO_ORGENCODED')) {
    send(res, 200, {
      ok: false, notConfigured: true,
      statusmessage: 'AroFlo credentials are not configured on the server. Set AROFLO_SECRET, AROFLO_UENCODED, AROFLO_PENCODED and AROFLO_ORGENCODED in the deployment environment.',
    });
    return;
  }

  const action = ACTIONS[str(q.action || 'ping')];
  if (!action) { send(res, 400, { ok: false, statusmessage: 'Unknown action' }); return; }

  try {
    const out = await action(q);
    if (!str(q.debug)) delete out.varString;
    send(res, 200, out);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    send(res, 502, { ok: false, statusmessage: timeout ? 'AroFlo did not respond in time' : ('Proxy error: ' + (err && err.message || err)) });
  }
};
