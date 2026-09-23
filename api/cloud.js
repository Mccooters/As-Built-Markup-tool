/* AirMark — team cloud sync (Vercel serverless function).
 *
 * Phase 1 of multi-user AirMark: employee sign-in (name + PIN), a shared
 * project registry, and drawings/markups stored in the cloud so any signed-in
 * device can open any project. Storage is a Supabase project (Postgres via
 * PostgREST + Storage buckets) accessed with the SERVICE key, which lives
 * only in server env vars — the browser never talks to Supabase with a
 * credential. Big payloads (PDFs, markup JSON with photos) never pass
 * through this function: it mints short-lived signed upload/download URLs
 * and the browser moves the bytes directly, so Vercel's request-size limits
 * are never in the path.
 *
 * Environment variables:
 *   SUPABASE_URL          e.g. https://abcdefgh.supabase.co
 *   SUPABASE_SERVICE_KEY  the service_role key (Project Settings → API)
 *   AIRMARK_CREW          who may sign in: "Josh:1234,Jay:8888" (name:PIN,…)
 *
 * Optional — SharePoint site-drawings register (read-only Microsoft Graph):
 *   MS_TENANT_ID          Entra "Directory (tenant) ID" of the app registration
 *   MS_CLIENT_ID          its "Application (client) ID"
 *   MS_CLIENT_SECRET      a client secret VALUE (not the secret's ID)
 *   SP_DRAWINGS_URL       the SharePoint folder that holds the project drawings,
 *                         pasted straight from the browser address bar
 *   The registration needs the Microsoft Graph APPLICATION permission
 *   Sites.Read.All (or Sites.Selected granted on the one site) with admin
 *   consent. Drawing bytes go browser ← SharePoint via the pre-authenticated
 *   download URL Graph mints; the proxy stream below is only a fallback.
 *
 * One-time Supabase setup (SQL editor):
 *   create table am_projects (
 *     id uuid primary key default gen_random_uuid(),
 *     name text not null default '',
 *     aro_no text not null default '',
 *     fingerprint text not null default '',
 *     version int not null default 0,
 *     data_path text not null default '',
 *     pdf_path text not null default '',
 *     pdf_size bigint not null default 0,
 *     updated_by text not null default '',
 *     updated_at timestamptz not null default now(),
 *     status text not null default 'active',  -- active | dlp | done — groups the project list
 *     file_name text not null default ''      -- the drawing's file name (projects with several sheets)
 *   );
 *   -- existing installs (table created before statuses / file names existed) — two lines:
 *   alter table am_projects add column if not exists status text not null default 'active';
 *   alter table am_projects add column if not exists file_name text not null default '';
 *   alter table am_projects enable row level security;  -- no policies: only the service key reads it
 *   insert into storage.buckets (id, name, public) values ('airmark', 'airmark', false);
 */
'use strict';

const crypto = require('node:crypto');

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const env = n => (process.env[n] || '').replace(INVISIBLE, '').trim();
const str = v => (v == null ? '' : String(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BUCKET = 'airmark';
const TOKEN_DAYS = 60;
const UUID = /^[0-9a-fA-F-]{36}$/;
const FP = /^[A-Za-z0-9_-]{4,80}$/;

const configured = () => !!(env('SUPABASE_URL') && env('SUPABASE_SERVICE_KEY') && env('AIRMARK_CREW'));

/* ---------------- Supabase REST helpers (service key, server-side only) ---------------- */

// Tolerate the ways a URL gets pasted: trailing slash, missing scheme, and
// the dashboard's per-service endpoints (…/rest/v1, …/storage/v1) — if one
// of those was copied, walk back to the project root. A base that keeps a
// /rest/v1 suffix makes PostgREST see nested paths and answer 404 "Invalid
// path specified in request URL" on every call.
function sbBase() {
  let base = env('SUPABASE_URL').replace(/\/+$/, '');
  base = base.replace(/\/(rest|storage|auth|realtime|functions)\/v1$/i, '').replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base;
}

async function sb(method, path, body, extraHeaders) {
  const key = env('SUPABASE_SERVICE_KEY');
  const base = sbBase();
  // the most common setup mistake: pasting the app's own URL or the
  // Supabase dashboard address instead of the project's API URL
  if (/vercel\.app/i.test(base))
    throw new Error('SUPABASE_URL is set to the app’s own Vercel address — it must be the Supabase Project URL (looks like https://xxxx.supabase.co, from Supabase → Project Settings → API). Fix the env var and redeploy.');
  if (/supabase\.com/i.test(base))
    throw new Error('SUPABASE_URL is set to the Supabase dashboard address — it must be the Project URL (looks like https://xxxx.supabase.co, note .co, from Supabase → Project Settings → API). Fix the env var and redeploy.');
  const resp = await fetch(base + path, {
    method,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* leave null */ }
  if (!resp.ok) {
    let msg = json && (json.message || json.error || json.msg);
    if (!msg) {
      // an HTML body means we reached a website, not the Supabase API —
      // don't dump the page, say what's actually wrong
      msg = /^\s*</.test(text)
        ? 'got a web page instead of data — SUPABASE_URL is probably not the Supabase Project URL (it must look like https://xxxx.supabase.co, from Supabase → Project Settings → API)'
        : text.slice(0, 200);
    }
    // name the exact call so a failure is diagnosable from the chip message
    throw new Error('Storage service error (HTTP ' + resp.status + ') on ' + method + ' ' + path.split('?')[0] + ': ' + msg);
  }
  return json;
}

const rowsPath = q => '/rest/v1/am_projects' + q;

function slimRow(r) {
  return {
    id: str(r.id), name: str(r.name), aroNo: str(r.aro_no),
    fingerprint: str(r.fingerprint), version: Number(r.version) || 0,
    updatedBy: str(r.updated_by), updatedAt: str(r.updated_at),
    pdfSize: Number(r.pdf_size) || 0, hasPdf: !!str(r.pdf_path),
    status: normStatus(r.status),
    fileName: str(r.file_name),
  };
}

// Project status — In progress (active) / DLP (defects liability period) /
// Completed (done). It has its own column so the list groups without
// opening every project. An install that hasn't run the one-line migration
// keeps working: statuses then stay on each device and the client is told.
const STATUSES = ['active', 'dlp', 'done'];
const normStatus = s => (STATUSES.includes(str(s)) ? str(s) : 'active');
// column → {ok, at}: a present column is remembered for the life of the warm
// instance; a missing one is re-checked every couple of minutes, so running
// the migration takes effect without waiting for a redeploy
const colKnown = {};
const MISSING_RECHECK_MS = 2 * 60 * 1000;
async function hasCol(col, force) {
  const k = colKnown[col];
  if (!force && k && (k.ok || Date.now() - k.at < MISSING_RECHECK_MS)) return k.ok;
  try {
    await sb('GET', rowsPath('?select=' + col + '&limit=1'));
    colKnown[col] = { ok: true, at: Date.now(), err: '' };
  } catch (e) {
    if (!new RegExp(col, 'i').test(str(e && e.message))) throw e;   // unrelated failure — no verdict cached
    // keep Supabase's own words for the client's hint ("column … does not exist" vs a stale schema cache)
    const err = str(e && e.message).replace(/^Storage service error \(HTTP \d+\) on GET [^:]+: /, '').slice(0, 200);
    colKnown[col] = { ok: false, at: Date.now(), err };
  }
  return colKnown[col].ok;
}
const colError = col => (colKnown[col] && colKnown[col].err) || '';
const hasStatusCol = () => hasCol('status');

async function signedUpload(path) {
  const r = await sb('POST', `/storage/v1/object/upload/sign/${BUCKET}/${path}`, {});
  return sbBase() + '/storage/v1' + r.url;
}

async function signedDownload(path, expiresIn) {
  const r = await sb('POST', `/storage/v1/object/sign/${BUCKET}/${path}`, { expiresIn: expiresIn || 600 });
  return sbBase() + '/storage/v1' + (r.signedURL || r.signedUrl);
}

/* ---------------- Microsoft Graph (SharePoint drawings, read-only) ---------------- */

const spConfigured = () =>
  !!(env('MS_TENANT_ID') && env('MS_CLIENT_ID') && env('MS_CLIENT_SECRET') && env('SP_DRAWINGS_URL'));

// Overridable bases so the whole flow is testable against a local mock.
const msLoginBase = () => env('MS_LOGIN_BASE') || 'https://login.microsoftonline.com';
const graphBase = () => env('MS_GRAPH_BASE') || 'https://graph.microsoft.com/v1.0';

const SP_ITEM_ID = /^[A-Za-z0-9!_-]{3,160}$/;
let graphTok = { token: '', exp: 0, roles: null };   // client-credentials token, cached per warm instance
let spRootCache = null;                              // resolved {driveId, id, name, via}

// The permissions the token actually carries (its "roles" claim) — read for
// diagnostics only, never trusted for anything. null when the token is not a
// readable JWT; [] when Microsoft issued a token with no application
// permission in it (the classic "consent never granted" state).
function tokenRoles(tok) {
  const parts = str(tok).split('.');
  if (parts.length !== 3) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Array.isArray(c.roles) ? c.roles.map(str) : [];
  } catch (e) { return null; }
}
const SP_READ_ROLE = /^(Sites\.(Read|ReadWrite|Manage|FullControl)\.All|Files\.(Read|ReadWrite)\.All)$/;

async function graphToken() {
  if (graphTok.token && Date.now() < graphTok.exp - 60000) return graphTok.token;
  const resp = await fetch(`${msLoginBase()}/${encodeURIComponent(env('MS_TENANT_ID'))}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env('MS_CLIENT_ID'),
      client_secret: env('MS_CLIENT_SECRET'),
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const j = await resp.json().catch(() => null);
  if (!resp.ok || !j || !j.access_token) {
    const code = j && (j.error || j.error_description) || ('HTTP ' + resp.status);
    if (/invalid_client|7000215|700016/i.test(str(code)))
      throw new Error('Microsoft sign-in refused the app credentials — check MS_CLIENT_ID and MS_CLIENT_SECRET (use the secret VALUE, not its ID) and that the secret has not expired.');
    if (/90002|invalid_tenant|not found/i.test(str(code)))
      throw new Error('Microsoft sign-in does not recognise MS_TENANT_ID — copy the Directory (tenant) ID from the app registration overview.');
    throw new Error('Microsoft sign-in failed: ' + str(j && j.error_description || code).split(/[\r\n]/)[0].slice(0, 200));
  }
  graphTok = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3599) * 1000, roles: tokenRoles(j.access_token) };
  return graphTok.token;
}

// What a refusal from SharePoint means, judged by the permissions the app's
// own token carries. Microsoft's wording for every one of these cases is the
// same unhelpful "HTTP 401 General exception while processing".
function permissionHint(status, code, msg) {
  const roles = graphTok.roles;
  const said = ` (Graph said: HTTP ${status}${code ? ' ' + code : ''}${msg ? ' — ' + msg : ''})`;
  let host = '';
  try { host = new URL(env('SP_DRAWINGS_URL')).host; } catch (e) { /* not a URL */ }
  if (!roles) {
    return 'Microsoft 365 refused access — the app registration needs the Microsoft Graph APPLICATION permission Sites.Read.All with admin consent granted, and SP_DRAWINGS_URL must be a folder on this organisation’s own SharePoint.' + said;
  }
  if (!roles.length) {
    return 'SharePoint refused the app: Microsoft 365 issued it a sign-in token that carries no permissions. In Entra (entra.microsoft.com) → App registrations → the AirMark app → API permissions, the Microsoft Graph permission must be an Application permission (Sites.Read.All), not a Delegated one, and an admin must click “Grant admin consent” so its Status shows a green tick. Then tap Sync again.' + said;
  }
  const read = roles.find(r => SP_READ_ROLE.test(r));
  if (!read && roles.includes('Sites.Selected')) {
    return 'SharePoint refused the app: it only has the Sites.Selected permission, which works once an admin also grants the app access to the drawings site itself (Graph: POST /sites/{site-id}/permissions with the app’s id and the “read” role). Adding the Application permission Sites.Read.All with admin consent is the simple fix.' + said;
  }
  if (!read) {
    return `SharePoint refused the app: its permissions (${roles.join(', ')}) include nothing that reads SharePoint. Add the Microsoft Graph Application permission Sites.Read.All in Entra → App registrations → API permissions and click “Grant admin consent”.` + said;
  }
  return `SharePoint refused the app even though its ${read} permission is granted — the folder is probably on a SharePoint that the app’s Microsoft 365 tenant cannot see (a builder’s or client’s site${host ? ': ' + host : ''}), or SP_DRAWINGS_URL is not a folder inside a document library. Point it at a drawings folder on this organisation’s own SharePoint.` + said;
}

async function graph(pathOrUrl) {
  const tok = await graphToken();
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : graphBase() + pathOrUrl;
  const resp = await fetch(url, {
    headers: { Authorization: 'Bearer ' + tok },
    signal: AbortSignal.timeout(20000),
  });
  const j = await resp.json().catch(() => null);
  if (!resp.ok) {
    const code = str(j && j.error && j.error.code);
    const msg = str(j && j.error && j.error.message || '').split(/[\r\n]/)[0].slice(0, 160);
    if (resp.status === 401 || resp.status === 403 || /accessDenied|generalException|unauthenticated|InvalidAuthenticationToken/i.test(code)) {
      // Drop the cached token: consent granted a minute ago only shows up in a
      // fresh one, so the next Sync must not keep re-using the refused token.
      const err = new Error(permissionHint(resp.status, code, msg));
      err.authFail = true;
      graphTok = { token: '', exp: 0, roles: null };
      throw err;
    }
    if (resp.status === 404 || /itemNotFound/i.test(code)) {
      const err = new Error('SharePoint cannot find the drawings folder — SP_DRAWINGS_URL should be the folder’s address as the browser shows it (a …/Forms/AllItems.aspx?id=… address or a “Copy link” sharing link works too), on a site the app has access to.' + ` (Graph said: HTTP ${resp.status}${code ? ' ' + code : ''})`);
      err.notFound = true;
      throw err;
    }
    throw new Error('SharePoint error (HTTP ' + resp.status + (code ? ' ' + code : '') + '): ' + (msg || 'unknown'));
  }
  return j;
}

// The pasted folder address, in whichever form the browser gave it:
//   https://x.sharepoint.com/sites/Site/Shared Documents/Drawings          (plain folder path)
//   https://x.sharepoint.com/sites/Site/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FSite%2F…&viewid=…
//   https://x.sharepoint.com/:f:/r/sites/Site/Shared%20Documents/Drawings?csf=1&web=1   ("Copy link", path style)
//   https://x.sharepoint.com/:f:/s/Site/Eabc123…?e=xyz                               ("Copy link", token style)
// → { host, sitePath, folderPath (server-relative, decoded), canonical, shareOnly }
function parseSpUrl(raw) {
  let u;
  try { u = new URL(str(raw).trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.host) return null;
  const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  let folderPath = '';
  let shareOnly = false;
  const share = u.pathname.match(/^\/:[a-z]:\/([a-z])\/(.*)$/i);
  if (share) {
    if (share[1].toLowerCase() === 'r') folderPath = '/' + dec(share[2]);   // path-style link carries the real path
    else shareOnly = true;                                                  // token-style link: only the shares API can resolve it
  } else if (/\.aspx$/i.test(u.pathname) && u.searchParams.get('id')) {
    folderPath = dec(u.searchParams.get('id'));                             // library view page: the folder is the id parameter
  } else {
    folderPath = dec(u.pathname);
  }
  folderPath = folderPath.replace(/\/+$/, '').replace(/\/{2,}/g, '/')
    .replace(/\/Forms\/[^/]*\.aspx$/i, '');   // a library's own view page → the library itself
  if (!shareOnly && !folderPath.startsWith('/')) folderPath = '/' + folderPath;
  const site = folderPath.match(/^\/(sites|teams|personal)\/[^/]+/i);
  return {
    host: u.host,
    sitePath: site ? site[0] : '',
    folderPath,
    canonical: shareOnly ? u.origin + u.pathname : u.origin + encodeURI(folderPath),
    shareOnly,
  };
}

// Resolve the folder through the site → document library → path route. It
// is the route that works with the tighter Sites.Selected permission, and it
// copes with the library view-page address the browser usually shows.
async function spResolveByPath(p) {
  const site = await graph(`/sites/${encodeURIComponent(p.host)}${p.sitePath ? ':' + p.sitePath.split('/').map(encodeURIComponent).join('/') : ''}?$select=id,webUrl`);
  if (!site || !site.id) throw new Error('SharePoint returned no site for ' + p.host + p.sitePath);
  const drives = await graph(`/sites/${encodeURIComponent(str(site.id))}/drives?$select=id,name,webUrl`);
  const want = p.folderPath.toLowerCase();
  let best = null;
  for (const d of (drives && drives.value || [])) {
    let dp = '';
    try { dp = decodeURIComponent(new URL(str(d.webUrl)).pathname).replace(/\/+$/, '').toLowerCase(); } catch (e) { continue; }
    if (dp && (want === dp || want.startsWith(dp + '/')) && (!best || dp.length > best.path.length)) best = { id: str(d.id), name: str(d.name), path: dp };
  }
  if (!best) throw new Error('No document library on ' + p.host + p.sitePath + ' holds ' + p.folderPath);
  const rel = p.folderPath.slice(best.path.length).replace(/^\//, '');
  const it = rel
    ? await graph(`/drives/${encodeURIComponent(best.id)}/root:/${rel.split('/').map(encodeURIComponent).join('/')}`)
    : await graph(`/drives/${encodeURIComponent(best.id)}/root`);
  if (!it || !it.id) throw new Error('SharePoint returned no item for ' + p.folderPath);
  return { driveId: str(it.parentReference && it.parentReference.driveId) || best.id, id: str(it.id), name: str(it.name) || best.name, folder: !!it.folder, via: 'site path' };
}

// Resolve the pasted folder URL to a drive item once per warm instance: the
// site-path route first, then Graph's shares API (which takes any SharePoint
// URL as a base64url "share token") for sharing links and anything the path
// route could not place.
async function spRoot() {
  if (spRootCache) return spRootCache;
  const p = parseSpUrl(env('SP_DRAWINGS_URL'));
  if (!p) throw new Error('SP_DRAWINGS_URL is not a web address — paste the drawings folder’s address from the browser.');
  let got = null, pathErr = null;
  if (!p.shareOnly) {
    try { got = await spResolveByPath(p); }
    catch (e) { if (e.authFail) throw e; pathErr = e; }
  }
  if (!got) {
    const shareTok = 'u!' + Buffer.from(p.canonical, 'utf8').toString('base64url');
    let it;
    try { it = await graph(`/shares/${shareTok}/driveItem?$select=id,name,folder,parentReference`); }
    catch (e) {
      if (pathErr && pathErr.notFound && !e.authFail) throw pathErr;   // the path route's explanation names what was not found
      throw e;
    }
    const driveId = str(it && it.parentReference && it.parentReference.driveId);
    if (!it || !it.id || !driveId) throw new Error('SharePoint resolved the folder URL but returned no drive item — is SP_DRAWINGS_URL a folder inside a document library?');
    got = { driveId, id: str(it.id), name: str(it.name), folder: !!it.folder, via: 'sharing link' };
  }
  if (!got.folder) throw new Error('SP_DRAWINGS_URL points at a file, not a folder — paste the address of the folder that holds the drawings.');
  spRootCache = got;
  return spRootCache;
}

// Walk the folder tree (a few levels is plenty for a drawings register) and
// group the PDFs by their sub-folder path — those become the register's
// sections, exactly how the drawings are already organised on SharePoint.
async function spWalk() {
  const root = await spRoot();
  const sections = {};
  const queue = [{ id: root.id, path: '', depth: 0 }];
  let seen = 0;
  while (queue.length && seen < 500) {
    const cur = queue.shift();
    let next = `/drives/${encodeURIComponent(root.driveId)}/items/${encodeURIComponent(cur.id)}/children?$top=200&$select=id,name,size,folder,file,eTag,lastModifiedDateTime`;
    while (next && seen < 500) {
      const j = await graph(next);
      for (const it of (j && j.value || [])) {
        seen++;
        if (it.folder) {
          if (cur.depth < 3) queue.push({ id: str(it.id), path: cur.path ? cur.path + ' / ' + str(it.name) : str(it.name), depth: cur.depth + 1 });
        } else if (/\.pdf$/i.test(str(it.name))) {
          (sections[cur.path] = sections[cur.path] || []).push({
            id: str(it.id),
            name: str(it.name),
            size: Number(it.size) || 0,
            etag: str(it.eTag),
            modified: str(it.lastModifiedDateTime),
          });
        }
      }
      next = j && j['@odata.nextLink'] || null;
    }
  }
  return {
    root: root.name,
    sections: Object.keys(sections).sort((a, b) => a.localeCompare(b))
      .map(path => ({ path, files: sections[path].sort((a, b) => a.name.localeCompare(b.name)) })),
  };
}

// Fallback for browsers that can't fetch the pre-authenticated download URL
// directly: pull the bytes server-side and stream them through.
async function spProxyStream(res, id) {
  const root = await spRoot();
  const it = await graph(`/drives/${encodeURIComponent(root.driveId)}/items/${encodeURIComponent(id)}`);
  const dl = it && it['@microsoft.graph.downloadUrl'];
  if (!dl) throw new Error('SharePoint returned no download link for that drawing.');
  const resp = await fetch(dl, { headers: { 'User-Agent': 'AirMark-drawings-proxy' }, signal: AbortSignal.timeout(120000) });
  if (!resp.ok || !resp.body) throw new Error('SharePoint download failed (HTTP ' + resp.status + ')');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  for await (const chunk of resp.body) res.write(Buffer.from(chunk));
  res.end();
}

/* ---------------- crew + session tokens ---------------- */

function crew() {
  return env('AIRMARK_CREW').split(',')
    .map(s => s.trim()).filter(Boolean)
    .map(s => {
      const i = s.indexOf(':');
      return i > 0 ? { name: s.slice(0, i).trim(), pin: s.slice(i + 1).trim() } : null;
    })
    .filter(c => c && c.name && c.pin);
}

const b64u = s => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = s => { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch (e) { return ''; } };
const sign = payload => crypto.createHmac('sha256', env('SUPABASE_SERVICE_KEY')).update(payload).digest('hex');

function makeToken(name) {
  const payload = name + '|' + (Date.now() + TOKEN_DAYS * 86400000);
  return b64u(payload) + '.' + sign(payload);
}

function verifyToken(token) {
  const [p, sig] = str(token).split('.');
  if (!p || !sig) return null;
  const payload = unb64u(p);
  const want = sign(payload);
  const a = Buffer.from(str(sig)), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const bar = payload.lastIndexOf('|');
  const name = payload.slice(0, bar);
  const exp = Number(payload.slice(bar + 1));
  if (!name || !Number.isFinite(exp) || Date.now() > exp) return null;
  return name;
}

/* ---------------- actions ---------------- */

const ACTIONS = {

  // Probe for the client: is team cloud configured on this deployment?
  async status() {
    return { ok: true, enabled: configured(), sp: spConfigured() };
  },

  // Sign in with a crew name + PIN → a signed session token the app stores.
  async login(q, body) {
    const name = str(body && body.name).trim();
    const pin = str(body && body.pin).trim();
    if (!name || !pin) return { ok: false, httpStatus: 400, statusmessage: 'Name and PIN required' };
    await sleep(250); // slow brute-force attempts
    const hit = crew().find(c => c.name.toLowerCase() === name.toLowerCase());
    if (hit) {
      const a = Buffer.from(pin), b = Buffer.from(hit.pin);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { ok: true, token: makeToken(hit.name), name: hit.name };
      }
    }
    return { ok: false, httpStatus: 401, statusmessage: 'Wrong name or PIN' };
  },

  // Token check on boot.
  async who(q, body, auth) {
    return { ok: true, name: auth };
  },

  // Signed-in devices configure themselves: the AroFlo proxy token comes
  // from the server env (a tech never types it), and the team's sync scope
  // is a tiny JSON in the storage bucket that anyone signed in can read.
  async teamcfg() {
    let cats = [];
    try {
      const j = await sb('GET', `/storage/v1/object/${BUCKET}/settings/aroflo.json`);
      if (j && Array.isArray(j.cats)) cats = j.cats.filter(c => typeof c === 'string').slice(0, 200);
    } catch (e) { /* not set yet */ }
    return { ok: true, proxyToken: env('AROFLO_PROXY_TOKEN'), cats };
  },

  // Publish the current device's category scope as the team default.
  async teamscope(q, body, auth) {
    const cats = (Array.isArray(body && body.cats) ? body.cats : [])
      .filter(c => typeof c === 'string' && c.trim())
      .map(c => c.trim().slice(0, 120))
      .slice(0, 200);
    await sb('POST', `/storage/v1/object/${BUCKET}/settings/aroflo.json`, { cats, updatedBy: auth, updatedAt: new Date().toISOString() }, { 'x-upsert': 'true' });
    return { ok: true, cats };
  },

  // The shared project list, newest first.
  // `recheck=1` re-probes the optional columns right now (Home's "Check again"
  // after the migration has been run) instead of waiting out the cache.
  async list(q) {
    const rows = await sb('GET', rowsPath('?select=*&order=updated_at.desc&limit=100'));
    const force = !!(q && q.recheck);
    let statusColumn = null, fileNameColumn = null;
    try { statusColumn = await hasCol('status', force); } catch (e) { /* unknown — say nothing */ }
    try { fileNameColumn = await hasCol('file_name', force); } catch (e) { /* unknown */ }
    const columnError = statusColumn === false ? colError('status') : fileNameColumn === false ? colError('file_name') : '';
    return { ok: true, projects: (rows || []).map(slimRow), statusColumn, fileNameColumn, columnError };
  },

  // Start a save: find/create the registry row for this drawing, check the
  // caller isn't about to stomp a newer version, and mint signed upload URLs
  // for the markup JSON (versioned path) and — first time only — the PDF.
  async prepare(q, body, auth) {
    const fingerprint = str(body && body.fingerprint).trim();
    if (!FP.test(fingerprint)) return { ok: false, httpStatus: 400, statusmessage: 'Bad drawing fingerprint' };
    const name = str(body && body.name).trim().slice(0, 160) || 'Untitled drawing';
    const aroNo = str(body && body.aroNo).trim().slice(0, 40);
    const baseVersion = Number(body && body.version);
    const force = !!(body && body.force);
    const status = body && body.status != null ? normStatus(body.status) : null;
    const fileName = str(body && body.fileName).trim().slice(0, 200);
    const knownId = str(body && body.id).trim();                        // the row this device last synced with
    const prevFingerprint = str(body && body.prevFingerprint).trim();   // set when a new revision replaced the PDF

    let row = (await sb('GET', rowsPath('?fingerprint=eq.' + encodeURIComponent(fingerprint) + '&limit=1')))[0];
    let rekeyed = false;
    if (!row && UUID.test(knownId)) {
      // the device knows a row, but the drawing's fingerprint has changed
      const byId = (await sb('GET', rowsPath('?id=eq.' + knownId + '&limit=1')))[0];
      if (!byId) {
        // deleted from the team cloud since this device last synced — never bring it back quietly
        if (!force) return { ok: true, gone: true };
      } else {
        if (prevFingerprint && str(byId.fingerprint) === prevFingerprint) {
          // a new revision of the drawing: the project keeps its row, the row follows the new PDF
          const patched = await sb('PATCH', rowsPath('?id=eq.' + knownId), { fingerprint, pdf_path: '', pdf_size: 0 }, { Prefer: 'return=representation' });
          row = (Array.isArray(patched) && patched[0]) || null;
          rekeyed = !!row;
        } else if (!force) {
          // someone else moved the project onto a newer revision — this copy is the old sheet
          return { ok: true, conflict: true, superseded: true, project: slimRow(byId) };
        }
      }
    }
    if (!row) {
      const fields = { name, aro_no: aroNo, fingerprint, updated_by: auth };
      if (status && await hasStatusCol()) fields.status = status;
      if (fileName && await hasCol('file_name')) fields.file_name = fileName;
      const ins = await sb('POST', rowsPath(''), fields, { Prefer: 'return=representation' });
      row = Array.isArray(ins) ? ins[0] : ins;
    }
    if (!row || !UUID.test(str(row.id))) return { ok: false, httpStatus: 500, statusmessage: 'Registry row not created' };

    if (!force && Number.isFinite(baseVersion) && baseVersion < (Number(row.version) || 0)) {
      return { ok: true, conflict: true, project: slimRow(row) };
    }
    const nextVersion = (Number(row.version) || 0) + 1;
    const dataPath = `projects/${row.id}/data-v${nextVersion}.json`;
    const needPdf = !str(row.pdf_path);
    // a revision's PDF gets its own object — a signed upload can't overwrite the first one
    const pdfPath = needPdf ? `projects/${row.id}/drawing${rekeyed ? '-' + fingerprint : ''}.pdf` : '';
    // earlier revisions this device holds and the cloud doesn't yet: one signed upload each
    const uploadRevs = {};
    const revFps = Array.isArray(body && body.revFingerprints) ? body.revFingerprints.map(f => str(f)).filter(f => FP.test(f)).slice(0, 12) : [];
    for (const rf of revFps) uploadRevs[rf] = await signedUpload(`projects/${row.id}/rev-${rf}.pdf`);
    return {
      ok: true,
      id: str(row.id),
      nextVersion,
      needPdf,
      pdfPath,
      uploadData: await signedUpload(dataPath),
      uploadPdf: needPdf ? await signedUpload(pdfPath) : null,
      uploadRevs,
    };
  },

  // Finish a save: the bytes are up, point the registry at them. The
  // version filter makes the bump monotonic — a concurrent save that got
  // there first leaves this PATCH matching nothing, reported as a conflict.
  async commit(q, body, auth) {
    const id = str(body && body.id).trim();
    const version = Number(body && body.version);
    if (!UUID.test(id) || !Number.isFinite(version) || version < 1 || version > 1e9)
      return { ok: false, httpStatus: 400, statusmessage: 'Bad commit' };
    const patch = {
      version,
      data_path: `projects/${id}/data-v${version}.json`,
      updated_by: auth,
      updated_at: new Date().toISOString(),
    };
    const name = str(body && body.name).trim().slice(0, 160);
    const aroNo = str(body && body.aroNo).trim().slice(0, 40);
    if (name) patch.name = name;
    if (aroNo) patch.aro_no = aroNo;
    // the client sends status only when that device changed it, so a stale
    // copy never undoes a list change made elsewhere
    if (body && body.status != null && await hasStatusCol()) patch.status = normStatus(body.status);
    const fileName = str(body && body.fileName).trim().slice(0, 200);
    if (fileName && await hasCol('file_name')) patch.file_name = fileName;
    if (body && body.pdfUploaded) {
      const pp = str(body.pdfPath);
      patch.pdf_path = new RegExp('^projects/' + id + '/drawing(-[A-Za-z0-9_-]{4,80})?\\.pdf$').test(pp) ? pp : `projects/${id}/drawing.pdf`;
      const sz = Number(body.pdfSize);
      if (Number.isFinite(sz) && sz > 0) patch.pdf_size = Math.round(sz);
    }
    const rows = await sb('PATCH', rowsPath('?id=eq.' + id + '&version=lt.' + version), patch, { Prefer: 'return=representation' });
    if (!Array.isArray(rows) || !rows.length) {
      const cur = (await sb('GET', rowsPath('?id=eq.' + id + '&limit=1')))[0];
      return { ok: true, conflict: true, project: cur ? slimRow(cur) : null };
    }
    return { ok: true, project: slimRow(rows[0]) };
  },

  // Delete a project for the whole team: the registry row and every object
  // under projects/<id>/ (markup versions, the drawing, earlier revisions).
  async delete(q, body) {
    const id = str(body && body.id).trim();
    if (!UUID.test(id)) return { ok: false, httpStatus: 400, statusmessage: 'Bad project id' };
    const row = (await sb('GET', rowsPath('?id=eq.' + id + '&limit=1')))[0];
    if (!row) return { ok: false, httpStatus: 404, statusmessage: 'Project not found — already deleted?' };
    let removed = 0;
    try {
      const objs = await sb('POST', `/storage/v1/object/list/${BUCKET}`, { prefix: `projects/${id}`, limit: 1000, offset: 0 });
      const names = (Array.isArray(objs) ? objs : []).map(o => `projects/${id}/${str(o.name)}`).filter(n => !n.endsWith('/'));
      if (names.length) { await sb('DELETE', `/storage/v1/object/${BUCKET}`, { prefixes: names }); removed = names.length; }
    } catch (e) { /* the row goes regardless — an orphaned object is harmless */ }
    await sb('DELETE', rowsPath('?id=eq.' + id), undefined, { Prefer: 'return=minimal' });
    return { ok: true, removed, project: slimRow(row) };
  },

  // A signed download for one earlier revision of a project's drawing.
  async revurl(q, body) {
    const id = str(body && body.id).trim();
    const fp = str(body && body.fp).trim();
    if (!UUID.test(id) || !FP.test(fp)) return { ok: false, httpStatus: 400, statusmessage: 'Bad revision reference' };
    return { ok: true, url: await signedDownload(`projects/${id}/rev-${fp}.pdf`, 600) };
  },

  // Move a project between In progress / DLP / Completed from the list —
  // status only, no version bump, so nobody's next save is flagged as a
  // conflict over a list change.
  async setstatus(q, body) {
    const id = str(body && body.id).trim();
    if (!UUID.test(id)) return { ok: false, httpStatus: 400, statusmessage: 'Bad project id' };
    const status = normStatus(body && body.status);
    if (!(await hasStatusCol())) {
      return { ok: false, statusColumn: false, statusmessage: 'Project statuses need the status column on am_projects — run the one-line SQL from the README in Supabase.' };
    }
    const rows = await sb('PATCH', rowsPath('?id=eq.' + id), { status }, { Prefer: 'return=representation' });
    if (!Array.isArray(rows) || !rows.length) return { ok: false, httpStatus: 404, statusmessage: 'Project not found' };
    return { ok: true, project: slimRow(rows[0]) };
  },

  // The SharePoint drawings register: sections mirror the folder tree.
  async drawings() {
    if (!spConfigured())
      return { ok: false, spNotConfigured: true, statusmessage: 'SharePoint drawings are not configured on this deployment (set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and SP_DRAWINGS_URL).' };
    const w = await spWalk();
    return { ok: true, root: w.root, sections: w.sections, fetchedAt: new Date().toISOString() };
  },

  // Step-by-step check of the SharePoint setup, for the "Check setup" button
  // under a register error: which step fails and what to do about it, judged
  // from a FRESH token so consent granted a minute ago counts. Reports names,
  // hosts and paths only — never a credential.
  async spcheck() {
    const steps = [];
    const step = (name, ok, detail) => { steps.push({ name, ok: !!ok, detail: str(detail).slice(0, 600) }); return !!ok; };
    const done = () => ({ ok: true, steps, passed: steps.every(s => s.ok) });
    const missing = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'SP_DRAWINGS_URL'].filter(n => !env(n));
    if (!step('Deployment settings', !missing.length, missing.length
      ? 'Not set on this deployment: ' + missing.join(', ') + ' (Vercel → Settings → Environment Variables, then redeploy).'
      : 'MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and SP_DRAWINGS_URL are all set.')) return done();
    const p = parseSpUrl(env('SP_DRAWINGS_URL'));
    if (!step('Drawings folder address', !!p, p
      ? (p.shareOnly ? 'A sharing link on ' + p.host : p.host + ' · ' + p.folderPath)
      : 'SP_DRAWINGS_URL is not a web address — paste the folder’s address from the browser.')) return done();
    graphTok = { token: '', exp: 0, roles: null };
    try { await graphToken(); } catch (e) { step('Microsoft sign-in', false, e.message); return done(); }
    const roles = graphTok.roles;
    const read = roles && roles.find(r => SP_READ_ROLE.test(r));
    if (!step('Microsoft sign-in', !roles || roles.length, !roles
      ? 'Signed in as the app (its token’s permissions could not be read).'
      : !roles.length
        ? 'Signed in, but the token carries NO permissions: the Microsoft Graph permission on the app registration must be an Application permission (Sites.Read.All), not Delegated, and admin consent must be granted (green tick in the Status column).'
        : 'Signed in as the app with: ' + roles.join(', ') + (read ? '' : roles.includes('Sites.Selected')
          ? ' — Sites.Selected also needs the app granted access to the drawings site itself.'
          : ' — none of these reads SharePoint; add the Application permission Sites.Read.All.'))) {
      graphTok = { token: '', exp: 0, roles: null };   // never keep a token known to be useless: the next Sync signs in afresh
      return done();
    }
    spRootCache = null;
    let root;
    try { root = await spRoot(); } catch (e) { step('Drawings folder', false, e.message); return done(); }
    step('Drawings folder', true, `“${root.name}” found (via ${root.via}).`);
    try {
      const w = await spWalk();
      const n = w.sections.reduce((a, s) => a + s.files.length, 0);
      step('Drawing PDFs', n > 0, n
        ? `${n} PDF${n === 1 ? '' : 's'} in ${w.sections.length} section${w.sections.length === 1 ? '' : 's'}.`
        : 'The folder and its sub-folders (three levels down) hold no PDFs yet.');
    } catch (e) { step('Drawing PDFs', false, e.message); }
    return done();
  },

  // A fresh pre-authenticated download URL for one drawing (they expire, so
  // one is minted per download, never stored).
  async spfile(q, body) {
    if (!spConfigured())
      return { ok: false, spNotConfigured: true, statusmessage: 'SharePoint drawings are not configured on this deployment.' };
    const id = str(body && body.id).trim();
    if (!SP_ITEM_ID.test(id)) return { ok: false, httpStatus: 400, statusmessage: 'Bad drawing id' };
    const root = await spRoot();
    const it = await graph(`/drives/${encodeURIComponent(root.driveId)}/items/${encodeURIComponent(id)}`);
    const url = it && it['@microsoft.graph.downloadUrl'];
    if (!url) return { ok: false, httpStatus: 502, statusmessage: 'SharePoint returned no download link for that drawing.' };
    return { ok: true, url, name: str(it.name), size: Number(it.size) || 0, etag: str(it.eTag) };
  },

  // Open a project: the registry row plus signed download URLs for its
  // latest markup JSON and the drawing PDF.
  async open(q, body) {
    const id = str(body && body.id).trim();
    if (!UUID.test(id)) return { ok: false, httpStatus: 400, statusmessage: 'Bad project id' };
    const row = (await sb('GET', rowsPath('?id=eq.' + id + '&limit=1')))[0];
    if (!row) return { ok: false, httpStatus: 404, statusmessage: 'Project not found' };
    if (!str(row.data_path)) return { ok: false, httpStatus: 409, statusmessage: 'Project has no saved data yet' };
    return {
      ok: true,
      project: slimRow(row),
      dataUrl: await signedDownload(row.data_path, 600),
      pdfUrl: str(row.pdf_path) ? await signedDownload(row.pdf_path, 600) : null,
    };
  },
};

const AUTH_ACTIONS = { who: 1, list: 1, prepare: 1, commit: 1, setstatus: 1, revurl: 1, delete: 1, open: 1, teamcfg: 1, teamscope: 1, drawings: 1, spcheck: 1, spfile: 1, spproxy: 1 };
const POST_ACTIONS = { login: 1, prepare: 1, commit: 1, setstatus: 1, revurl: 1, delete: 1, open: 1, teamscope: 1, spfile: 1 };

/* ---------------- HTTP plumbing ---------------- */

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-AirMark-Auth, Content-Type');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'object' && req.body !== null) return req.body;
    try { return JSON.parse(String(req.body)); } catch (e) { return null; }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 262144) return null;
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-AirMark-Auth, Content-Type');
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') { send(res, 405, { ok: false, statusmessage: 'GET or POST only' }); return; }

  const u = new URL(req.url, 'http://local');
  const q = Object.fromEntries(u.searchParams.entries());
  const actionName = str(q.action || 'status');
  const action = ACTIONS[actionName];
  if (!action && actionName !== 'spproxy') { send(res, 400, { ok: false, statusmessage: 'Unknown action' }); return; }

  if (actionName !== 'status' && !configured()) {
    send(res, 200, { ok: false, notConfigured: true, statusmessage: 'Team cloud is not configured on this deployment (set SUPABASE_URL, SUPABASE_SERVICE_KEY and AIRMARK_CREW).' });
    return;
  }

  let auth = null;
  if (AUTH_ACTIONS[actionName]) {
    auth = verifyToken(req.headers['x-airmark-auth'] || q.auth);
    if (!auth) { send(res, 401, { ok: false, badAuth: true, statusmessage: 'Sign in again — the session is missing or expired.' }); return; }
  }
  // spproxy streams PDF bytes, not JSON — it bypasses the normal dispatch
  if (actionName === 'spproxy') {
    const id = str(q.id).trim();
    if (!spConfigured()) { send(res, 400, { ok: false, statusmessage: 'SharePoint drawings are not configured on this deployment.' }); return; }
    if (!SP_ITEM_ID.test(id)) { send(res, 400, { ok: false, statusmessage: 'Bad drawing id' }); return; }
    try {
      await spProxyStream(res, id);
    } catch (err) {
      if (!res.headersSent) send(res, 502, { ok: false, statusmessage: 'Drawing download failed: ' + (err && err.message || err) });
      else res.end();
    }
    return;
  }

  let body = null;
  if (POST_ACTIONS[actionName]) {
    if (req.method !== 'POST') { send(res, 405, { ok: false, statusmessage: 'This action requires POST' }); return; }
    body = await readBody(req);
    if (!body) { send(res, 400, { ok: false, statusmessage: 'JSON body required' }); return; }
  }

  try {
    const out = await action(q, body, auth);
    send(res, 200, out);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const sp = /^(drawings|sp)/.test(actionName);   // SharePoint messages already say who refused what
    send(res, 502, { ok: false, statusmessage: timeout
      ? (sp ? 'SharePoint did not respond in time' : 'The storage service did not respond in time')
      : ((sp ? '' : 'Cloud error: ') + (err && err.message || err)) });
  }
};

// Lets Vercel stream the spproxy fallback instead of buffering it (drawing
// PDFs can be bigger than the buffered-response limit).
module.exports.config = { supportsResponseStreaming: true };
