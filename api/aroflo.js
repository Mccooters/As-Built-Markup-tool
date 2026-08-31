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
 * Read actions: ping, diag, holders, inventory, stocklevels, task,
 * taskmaterials. The single write action — adjuststock, for stocktakes and
 * holder-to-holder transfers — only runs when AROFLO_PROXY_TOKEN is set and
 * presented, and only posts per-holder stock movequantity adjustments.
 */
'use strict';

const crypto = require('node:crypto');

const ACCEPT = 'text/json';
const PAGE_SIZE = 500; // AroFlo's own default page size

// Values copied from AroFlo's wrapping key boxes can pick up invisible
// formatting characters (zero-width spaces, bidi marks, BOM, soft hyphens) —
// especially when pasted on iOS. Real AroFlo values are plain base64, so
// strip the invisibles along with ordinary padding whitespace; one stray
// hidden character otherwise breaks the HMAC with "Signatures do not match".
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const env = n => (process.env[n] || '').replace(INVISIBLE, '').trim();

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

async function aroSend(method, varString) {
  const afDateTimeUtc = new Date().toISOString();
  const authorization = authorizationHeader();
  const signature = signPayload(method, varString, authorization, afDateTimeUtc);

  const headers = {
    Authentication: `HMAC ${signature}`,
    Authorization: authorization,
    Accept: ACCEPT,
    afdatetimeutc: afDateTimeUtc,
  };
  const hostIp = env('AROFLO_HOST_IP');
  if (hostIp) headers.HostIP = hostIp;

  const url = new URL(env('AROFLO_BASE_URL') || 'https://api.aroflo.com/');
  let reqBody;
  if (method === 'POST') {
    // AroFlo POSTs carry the varString (zone + postxml) as the form body;
    // the signature is computed over that same string.
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    reqBody = varString;
  } else {
    url.search = varString;
  }

  const resp = await fetch(url, { method, headers, body: reqBody, signal: AbortSignal.timeout(20000) });
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

const aroGet = (zone, opts) => aroSend('GET', buildVarString(zone, opts));
const aroPost = (zone, postxml) =>
  aroSend('POST', `zone=${encodeURIComponent(zone)}&postxml=${encodeURIComponent(postxml)}`);

/* ---------------- response slimming ---------------- */

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const str = v => (v == null ? '' : String(v));

function slimLevels(levels) {
  return (Array.isArray(levels) ? levels : []).map(l => ({
    to: str(l.assignedto),
    id: str(l.assignedtoid),
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

  // Setup diagnostics for auth failures: reports the SHAPE of each stored
  // credential (length, first/last two characters, stray-whitespace and
  // base64 sanity flags) — never the values — plus AroFlo's raw reply, so a
  // paste error or a stale key can be spotted from the app.
  async diag() {
    const shape = n => {
      const raw = process.env[n] || '';
      const v = env(n);
      if (!v) return { set: false };
      const badChars = [...new Set(v.match(/[^A-Za-z0-9+/=]/g) || [])].slice(0, 3)
        .map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
      const badAt = v.search(/[^A-Za-z0-9+/=]/);
      return {
        set: true,
        len: v.length,
        ends: v.slice(0, 2) + '…' + v.slice(-2),
        invisibles: (raw.match(INVISIBLE) || []).length,
        innerWhitespace: /\s/.test(v),
        badChars,
        badAt: badAt >= 0 ? badAt + 1 : 0,
      };
    };
    const r = await aroGet('businessunits', { page: 1, pageSize: 1 });
    return relay(r, {
      vars: {
        AROFLO_SECRET: shape('AROFLO_SECRET'),
        AROFLO_UENCODED: shape('AROFLO_UENCODED'),
        AROFLO_PENCODED: shape('AROFLO_PENCODED'),
        AROFLO_ORGENCODED: shape('AROFLO_ORGENCODED'),
      },
      hostIpConfigured: !!env('AROFLO_HOST_IP'),
      baseUrl: env('AROFLO_BASE_URL') || 'https://api.aroflo.com/',
    });
  },

  // Every stock-holding location, even ones with nothing assigned yet:
  // active custom holders (site containers, utes) plus business units.
  // Stock-level rows only exist once stock is moved onto a holder, so the
  // app needs this list to show brand-new holders in its location filter.
  async holders() {
    const r = await aroGet('customholders', {
      where: ['and|archived|=|false'],
      page: 1, pageSize: PAGE_SIZE,
    });
    const cholders = (r.zoneresponse.customholders || [])
      .map(h => ({ name: str(h.customholdername), id: str(h.customholderid), type: 'cholder' }))
      .filter(h => h.name);
    let bus = [];
    try {
      const r2 = await aroGet('businessunits', { page: 1, pageSize: 50 });
      bus = (r2.zoneresponse.businessunits || [])
        .map(b => ({ name: str(b.orgname), id: str(b.orgid), type: 'org' }))
        .filter(h => h.name);
    } catch (e) { /* best-effort — holder list still useful without BUs */ }
    return relay(r, {
      locations: [...cholders, ...bus],
      holders: cholders.map(h => h.name),          // kept for older cached clients
      businessUnits: bus.map(h => h.name),
    });
  },

  // Connection test: returns the business unit name(s).
  async ping() {
    const r = await aroGet('businessunits', { page: 1, pageSize: 10 });
    const bus = (r.zoneresponse.businessunits || []).map(b => str(b.orgname)).filter(Boolean);
    return relay(r, { businessUnits: bus });
  },

  // Inventory categories, for the app's sync-scope picker.
  async categories() {
    const r = await aroGet('inventorycategories', { page: 1, pageSize: PAGE_SIZE });
    const cats = (r.zoneresponse.inventorycategories || [])
      .map(c => ({ id: str(c.categoryid), name: str(c.categoryname), parent: c.parentcategory ? str(c.parentcategory.categoryname) : '' }))
      .filter(c => c.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    return relay(r, { categories: cats });
  },

  // Every stock-level row on the site (paged). Cheap — only items that have
  // ever held stock have rows — and used as a safety net so stock held on
  // items outside a category-scoped sync still shows up.
  async stockrows(q) {
    const page = Math.min(20, Math.max(1, parseInt(q.page, 10) || 1));
    const r = await aroGet('inventorystocklevels', {
      where: ['and|lastupdatedutc|>|2000-01-01 00:00:00'],
      page, pageSize: PAGE_SIZE,
    });
    const rows = (r.zoneresponse.inventorystocklevels || []).map(l => ({
      itemid: str(l.itemid),
      to: str(l.assignedto),
      id: str(l.assignedtoid),
      type: str(l.assignedtotype),
      qty: num(l.quantity),
    }));
    return relay(r, { rows, ...pageMeta(r.zoneresponse, PAGE_SIZE) });
  },

  // One page of the inventory list with stock levels joined.
  // With no category, the explicit item-side where-clause (always true)
  // overrides AroFlo's default "created in the last 30 days" filter so the
  // whole catalogue comes back, without any risk of filtering the joined
  // stock rows. With ?cat=Name, only that category is returned — the fast
  // path for sites that scope their sync to install categories.
  async inventory(q) {
    const page = Math.min(60, Math.max(1, parseInt(q.page, 10) || 1));
    const cat = str(q.cat).replace(/\|/g, '').trim();
    const itemid = str(q.itemid).trim();
    let where;
    if (itemid && /^[A-Za-z0-9+/=]{1,64}$/.test(itemid)) where = `and|itemid|=|${itemid}`;
    else if (cat) where = `and|category|=|${cat}`;
    else where = 'and|itemid|!=|0';
    const r = await aroGet('inventory', {
      join: ['stocklevels'],
      where: [where],
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

  // THE ONE WRITE ACTION — stock movequantity adjustments, used for on-site
  // stocktakes (delta = counted − recorded) and holder-to-holder transfers
  // (a matched −/+ pair). HTTP POST only, and refused outright unless
  // AROFLO_PROXY_TOKEN is configured. Every value is strictly validated
  // before it goes anywhere near the postxml.
  async adjuststock(q, bodyJson) {
    const moves = bodyJson && Array.isArray(bodyJson.moves) ? bodyJson.moves : null;
    if (!moves || !moves.length) return { ok: false, httpStatus: 400, statusmessage: 'moves[] required' };
    if (moves.length > 100) return { ok: false, httpStatus: 400, statusmessage: 'Too many moves in one call (max 100)' };

    const ID = /^[A-Za-z0-9+/=]{1,64}$/;
    const TYPES = { org: 1, user: 1, cholder: 1 };
    const perItem = new Map();
    for (const m of moves) {
      const itemid = str(m.itemid).trim();
      const toId = str(m.toId).trim();
      const toType = str(m.toType).trim();
      const delta = Math.round(Number(m.delta) * 10000) / 10000;
      if (!ID.test(itemid)) return { ok: false, httpStatus: 400, statusmessage: 'Bad itemid' };
      if (!ID.test(toId)) return { ok: false, httpStatus: 400, statusmessage: 'Bad holder id' };
      if (!TYPES[toType]) return { ok: false, httpStatus: 400, statusmessage: 'Bad holder type' };
      if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100000)
        return { ok: false, httpStatus: 400, statusmessage: 'Bad quantity delta' };
      if (!perItem.has(itemid)) perItem.set(itemid, []);
      perItem.get(itemid).push({ toId, toType, delta });
    }

    let xml = '<items>';
    for (const [itemid, levels] of perItem) {
      xml += `<item><itemid>${itemid}</itemid><stocklevels>`;
      for (const l of levels) {
        xml += `<stocklevel><assignedtoid>${l.toId}</assignedtoid><assignedtotype>${l.toType}</assignedtotype><movequantity>${l.delta}</movequantity></stocklevel>`;
      }
      xml += '</stocklevels></item>';
    }
    xml += '</items>';

    const r = await aroPost('inventory', xml);
    return relay(r, {
      updated: num(r.zoneresponse.updatetotal),
      movesSent: moves.length,
    });
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

const WRITE_ACTIONS = { adjuststock: 1 };

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Proxy-Token, Content-Type');
  res.end(body);
}

// JSON request body, whether the platform pre-parsed it (Vercel) or not.
async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'object' && req.body !== null) return req.body;
    try { return JSON.parse(String(req.body)); } catch (e) { return null; }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 262144) return null; // 256 KB is far beyond any legitimate call
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Proxy-Token, Content-Type');
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') { send(res, 405, { ok: false, statusmessage: 'GET or POST only' }); return; }

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

  const actionName = str(q.action || 'ping');
  const action = ACTIONS[actionName];
  if (!action) { send(res, 400, { ok: false, statusmessage: 'Unknown action' }); return; }

  let bodyJson = null;
  if (WRITE_ACTIONS[actionName]) {
    // Writes are held to a stricter bar than reads: they must be POSTs, and
    // they are refused entirely on a deployment with no proxy token — an
    // unauthenticated proxy may show stock, but it must never change it.
    if (req.method !== 'POST') { send(res, 405, { ok: false, statusmessage: 'This action requires POST' }); return; }
    if (!gate) { send(res, 403, { ok: false, statusmessage: 'Writes are disabled: set AROFLO_PROXY_TOKEN on the deployment (and enter it in the app) to enable stock adjustments.' }); return; }
    bodyJson = await readBody(req);
    if (!bodyJson) { send(res, 400, { ok: false, statusmessage: 'JSON body required' }); return; }
  } else if (req.method !== 'GET') {
    send(res, 405, { ok: false, statusmessage: 'This action requires GET' });
    return;
  }

  try {
    const out = await action(q, bodyJson);
    if (!str(q.debug)) delete out.varString;
    send(res, 200, out);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    send(res, 502, { ok: false, statusmessage: timeout ? 'AroFlo did not respond in time' : ('Proxy error: ' + (err && err.message || err)) });
  }
};
