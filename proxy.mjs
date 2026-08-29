#!/usr/bin/env node
// opencode-retry-proxy — transparent retry for "referenced response not found or expired"
// Listens on 127.0.0.1:8765 -> forwards to https://opencode.ai/zen/go/v1
// On 400 expired previous_response_id: merges the stored full history for that id,
// sanitizes reasoning items (inject missing `summary`), strips the id, retries once.
// If no stored history exists for the expired id, the upstream 400 is passed through
// unchanged — the client (opencode) then resends full history, instead of getting a
// context-free 200 (silent amnesia).
// Sessions are detected per previous_response_id chain (session=c_N in logs). Full
// resends / compaction resets are detected per chain by head-hash match and replace
// the chain content instead of appending to it.
//
// Env overrides (all optional):
//   LISTEN_HOST        default 127.0.0.1  — MUST stay loopback, do NOT use 0.0.0.0 (open proxy risk)
//   LISTEN_PORT        default 8765
//   UPSTREAM           default https://opencode.ai/zen/go/v1
//   LOG_FILE           default /tmp/opencode-retry-proxy.log
//   MAX_HISTORY        default 300              — max stored response ids
//   MAX_HISTORY_BYTES  default 268435456 (256MB) — byte budget for stored inputs
//   MERGE_MAX_BYTES    default 4194304 (4MB)     — merged retry body cap; above it, pass the 400 through
//   HISTORY_FILE       default /tmp/opencode-retry-proxy-history.json — disk persistence, survives restarts
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '8765', 10);
const UPSTREAM = process.env.UPSTREAM || 'https://opencode.ai/zen/go/v1';
const LOG_FILE = process.env.LOG_FILE || '/tmp/opencode-retry-proxy.log';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '300', 10);
const MAX_HISTORY_BYTES = parseInt(process.env.MAX_HISTORY_BYTES || String(256 * 1024 * 1024), 10);
const MERGE_MAX_BYTES = parseInt(process.env.MERGE_MAX_BYTES || String(4 * 1024 * 1024), 10);
const HISTORY_FILE = process.env.HISTORY_FILE || '/tmp/opencode-retry-proxy-history.json';
const MODEL_ALIAS = { 'muse-spark-1.2-retry': 'muse-spark-1.2-contributor' };

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// respId -> { input: Array, bytes, chainId, headHash }
// A "session" is a previous_response_id chain; every stored response carries its chainId.
const history = new Map();
let historyBytes = 0;
let chainCounter = 0;
const headIndex = new Map(); // headHash -> chainId (recent, capped) to rejoin chains on full resends

function headHash(input) {
  try {
    return crypto.createHash('sha1').update(JSON.stringify(input[0] ?? '')).digest('hex').slice(0, 12);
  } catch { return null; }
}

function newChainId() { return `c${++chainCounter}`; }

function historySet(id, input, chainId) {
  if (!chainId) chainId = newChainId();
  let bytes = 0;
  try { bytes = JSON.stringify(input).length; } catch { return chainId; }
  const old = history.get(id);
  if (old) historyBytes -= old.bytes;
  const hh = headHash(input);
  history.set(id, { input, bytes, chainId, headHash: hh });
  historyBytes += bytes;
  if (hh) {
    headIndex.set(hh, chainId);
    while (headIndex.size > 100) headIndex.delete(headIndex.keys().next().value);
  }
  log(`stored history ${id} session=${chainId} items=${input.length} bytes=${bytes} (entries=${history.size}, totalBytes=${historyBytes})`);
  // evict oldest while over budget; never evict the only (just-inserted) entry
  while (history.size > 1 && (history.size > MAX_HISTORY || historyBytes > MAX_HISTORY_BYTES)) {
    const oldestKey = history.keys().next().value;
    const oldest = history.get(oldestKey);
    historyBytes -= oldest.bytes;
    history.delete(oldestKey);
  }
  scheduleSave();
  return chainId;
}

// Disk persistence: survives proxy restarts (in-memory history is lost on every
// restart, which is exactly when previously-alive chains start expiring).
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = JSON.stringify({ chainCounter, entries: [...history] });
    fs.writeFile(HISTORY_FILE, data, err => { if (err) log(`history save failed: ${err.message}`); });
  }, 3000);
  saveTimer.unref?.();
}

function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    if (history.size) fs.writeFileSync(HISTORY_FILE, JSON.stringify({ chainCounter, entries: [...history] }));
  } catch {}
}

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!data || !Array.isArray(data.entries)) return;
    for (const [id, e] of data.entries) {
      if (e && Array.isArray(e.input) && Number.isFinite(e.bytes) && e.chainId) {
        history.set(id, e);
        historyBytes += e.bytes;
        if (e.headHash) headIndex.set(e.headHash, e.chainId);
      }
    }
    chainCounter = Number.isFinite(data.chainCounter) ? data.chainCounter : history.size;
    log(`restored ${history.size} history entries from ${HISTORY_FILE} (totalBytes=${historyBytes})`);
  } catch { /* no file yet or corrupt — start fresh */ }
}

function isExpiredError(status, bodyText) {
  if (status !== 400) return false;
  if (!bodyText) return false;
  const t = bodyText.toLowerCase();
  return t.includes('referenced response not found') || (t.includes('referenced response') && t.includes('expired')) || (t.includes('previous_response_id') && t.includes('not found'));
}

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

// Reasoning items replayed from history must carry `summary`, otherwise the
// upstream rejects the whole request with `input[N] missing required field "summary"`.
function sanitizeReasoning(items) {
  return items.map(it => {
    if (it && typeof it === 'object' && it.type === 'reasoning' && !('summary' in it)) {
      return { ...it, summary: [] };
    }
    return it;
  });
}

// Some clients (reasonix) send `input` as a plain string with previous_response_id
// chaining. Normalize to a single user message item for storage/merging; the
// outgoing request is only rewritten when we actually merge on retry.
function normalizeInput(bodyObj) {
  if (typeof bodyObj.input === 'string') {
    return [{ type: 'message', role: 'user', content: bodyObj.input }];
  }
  return bodyObj.input;
}

// Resolve which session chain a request belongs to: via previous_response_id,
// or by matching the input's head hash against known chain heads (full resends).
function resolveChain(bodyObj) {
  const cur = normalizeInput(bodyObj);
  const hh = Array.isArray(cur) && cur.length ? headHash(cur) : null;
  const prevEntry = bodyObj.previous_response_id ? history.get(bodyObj.previous_response_id) : null;
  let chainId = null;
  if (prevEntry) chainId = prevEntry.chainId;
  else if (hh && headIndex.has(hh)) chainId = headIndex.get(hh);
  return { chainId: chainId || newChainId(), prevEntry, hh };
}

// Full chain for storage. On the retry path bodyObj is already the merged body
// (no previous_response_id), so its input is used as-is. If the client resent
// the full history (head hash equals the chain head — e.g. after compaction or
// client-side recovery), the chain content is replaced instead of appended.
function fullInputFor(bodyObj, chain) {
  const cur = normalizeInput(bodyObj);
  if (!Array.isArray(cur)) return null;
  const hh = cur.length ? headHash(cur) : null;
  if (bodyObj.previous_response_id && chain.prevEntry && Array.isArray(chain.prevEntry.input)) {
    if (hh && hh === chain.prevEntry.headHash) {
      log(`session ${chain.chainId}: full resend/compaction detected (${cur.length} items), chain reset`);
      return cur;
    }
    return [...chain.prevEntry.input, ...cur];
  }
  return cur;
}

// Build the retry body: strip previous_response_id, merge stored history into
// input (unless the request is itself a full resend), sanitize reasoning items.
// Returns null when we cannot reconstruct the full context or the merged body
// exceeds MERGE_MAX_BYTES (the upstream 400 is then passed through unchanged).
function buildRetryBody(bodyObj, chain) {
  const entry = chain.prevEntry;
  const cur = normalizeInput(bodyObj);
  if (!entry || !Array.isArray(entry.input) || !Array.isArray(cur)) return null;
  const hh = cur.length ? headHash(cur) : null;
  const resend = hh && hh === entry.headHash;
  if (resend) log(`session ${chain.chainId}: full resend/compaction detected on retry, using resend input as-is (${cur.length} items)`);
  const mergedInput = resend ? cur : [...entry.input, ...cur];
  const merged = { ...bodyObj, input: sanitizeReasoning(mergedInput) };
  delete merged.previous_response_id;
  let size = 0;
  try { size = JSON.stringify(merged).length; } catch { return null; }
  if (size > MERGE_MAX_BYTES) {
    log(`session ${chain.chainId}: merged retry body ${size} bytes > MERGE_MAX_BYTES ${MERGE_MAX_BYTES}, passing 400 through`);
    return null;
  }
  return merged;
}

function describeInput(input) {
  if (Array.isArray(input)) return `array[${input.length}]`;
  if (typeof input === 'string') return `string[${input.length}]`;
  return input === undefined ? 'none' : typeof input;
}

async function doFetch(targetUrl, method, headers, bodyBuf) {
  const h = { ...headers };
  delete h['host'];
  delete h['connection'];
  delete h['content-length'];
  h['host'] = new URL(UPSTREAM).host;
  const opts = {
    method,
    headers: h,
    duplex: 'half',
  };
  if (method !== 'GET' && method !== 'HEAD' && bodyBuf && bodyBuf.length) {
    opts.body = bodyBuf;
  }
  return fetch(targetUrl, opts);
}

const SSE_ID_RE = /"(?:id|response_id)"\s*:\s*"(resp_[^"]+)"/;
const SSE_SNIFF_WINDOW = 64 * 1024;

async function handle(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('error', e => { log(`req error ${e.message}`); res.writeHead(400); res.end(); });
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);
    const rawText = rawBody.toString('utf8');
    const ct = req.headers['content-type'] || '';
    let bodyObj = null;
    if (rawText && ct.includes('application/json')) bodyObj = tryJson(rawText);
    if (!bodyObj && rawText && rawText.trim().startsWith('{')) bodyObj = tryJson(rawText);
    if (bodyObj && bodyObj.model && MODEL_ALIAS[bodyObj.model]) {
      log(`alias map ${bodyObj.model} -> ${MODEL_ALIAS[bodyObj.model]}`);
      bodyObj.model = MODEL_ALIAS[bodyObj.model];
    }

    let effectiveRawBody = rawBody;
    let effectiveRawText = rawText;
    if (bodyObj && rawText.includes('muse-spark-1.2-retry')) {
      effectiveRawText = JSON.stringify(bodyObj);
      effectiveRawBody = Buffer.from(effectiveRawText);
      log(`regenerated body after alias map len ${rawText.length} -> ${effectiveRawText.length}`);
    }
    let urlPath = req.url;
    if (UPSTREAM.endsWith("/v1") && urlPath.startsWith("/v1")) urlPath = urlPath.slice(3);
    const targetUrl = UPSTREAM + urlPath;
    const fwdHeaders = { ...req.headers };

    let chain = null;
    if (bodyObj) {
      chain = resolveChain(bodyObj);
      log(`req ${req.method} ${urlPath} session=${chain.chainId} model=${bodyObj.model ?? '-'} input=${describeInput(bodyObj.input)} prev=${bodyObj.previous_response_id ?? '-'} stream=${!!bodyObj.stream}`);
    }

    let upstreamResp;
    try {
      upstreamResp = await doFetch(targetUrl, req.method, fwdHeaders, effectiveRawBody.length ? effectiveRawBody : undefined);
    } catch (e) {
      log(`upstream fetch failed ${targetUrl}: ${e.message}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `proxy upstream fetch failed: ${e.message}`, type: 'proxy_error' } }));
      return;
    }

    // If error 400 with expired reference:
    //  - with stored history -> merge and retry once (full context preserved)
    //  - without stored history (chain predates proxy start/restart) -> last resort:
    //    strip the id and retry anyway. The client cannot recover from the 400 by
    //    itself, so keeping the session alive beats surfacing the error; the turn
    //    may lack older context (logged as DEGRADED).
    if (bodyObj && bodyObj.previous_response_id) {
      let bodyTextForCheck = '';
      try { bodyTextForCheck = await upstreamResp.clone().text(); } catch {}
      if (isExpiredError(upstreamResp.status, bodyTextForCheck)) {
        const merged = buildRetryBody(bodyObj, chain);
        const reconstructable = chain.prevEntry && Array.isArray(chain.prevEntry.input) && Array.isArray(normalizeInput(bodyObj));
        if (merged || !reconstructable) {
          const retryBodyObj = merged || (() => { const { previous_response_id, ...rest } = bodyObj; return rest; })();
          const retryText = JSON.stringify(retryBodyObj);
          const retryBody = Buffer.from(retryText);
          const retryHeaders = { ...fwdHeaders, 'content-type': 'application/json' };
          if (merged) {
            log(`hit expired previous_response_id=${bodyObj.previous_response_id} session=${chain.chainId} -> merge retry (${effectiveRawText.length} -> ${retryText.length} bytes)`);
          } else {
            log(`hit expired previous_response_id=${bodyObj.previous_response_id} session=${chain.chainId} but no stored history -> DEGRADED retry without context (input=${describeInput(bodyObj.input)})`);
          }
          try {
            const retryResp = await doFetch(targetUrl, req.method, retryHeaders, retryBody);
            let retryTextCheck = '';
            try { retryTextCheck = await retryResp.clone().text(); } catch {}
            if (!isExpiredError(retryResp.status, retryTextCheck)) {
              log(`retry result: ${retryResp.status} ${retryResp.statusText}`);
              upstreamResp = retryResp;
              bodyObj = retryBodyObj; // merged bodies are already merged; degraded keeps original input
            } else {
              log(`retry still expired 400, giving up`);
              upstreamResp = retryResp;
            }
          } catch (e) {
            log(`retry fetch failed: ${e.message}`);
          }
        } else {
          log(`hit expired previous_response_id=${bodyObj.previous_response_id} session=${chain.chainId}: merged body too large or unstorable -> passing upstream ${upstreamResp.status} through`);
        }
      }
    }

    const respHeaders = {};
    upstreamResp.headers.forEach((v, k) => { respHeaders[k] = v; });
    delete respHeaders['content-length'];
    delete respHeaders['content-encoding'];
    res.writeHead(upstreamResp.status, upstreamResp.statusText, respHeaders);

    const respCT = upstreamResp.headers.get('content-type') || '';
    log(`resp ${upstreamResp.status} ct=${respCT || '-'} body=${upstreamResp.body ? 'yes' : 'no'}`);
    if (respCT.includes('application/json')) {
      const text = await upstreamResp.text();
      res.end(text);
      const j = tryJson(text);
      if (j && j.id && bodyObj) {
        const fi = fullInputFor(bodyObj, chain);
        if (fi) historySet(j.id, fi, chain.chainId);
        else log(`json resp ${j.id}: input=${describeInput(bodyObj.input)}, not storable`);
      } else if (!(j && j.id)) {
        log(`json resp has no id, hint=${text.slice(0, 200)}`);
      }
      if (upstreamResp.status >= 400) log(`upstream ${upstreamResp.status} ${text.slice(0, 600)}`);
    } else if (respCT.includes('text/event-stream') || upstreamResp.body) {
      // NB: fetch body chunks are Uint8Array, not Buffer — String() on them yields
      // comma-separated byte numbers, which is exactly why the old sniffing never matched.
      const decoder = new TextDecoder();
      let buffer = '';
      let stored = false;
      try {
        for await (const chunk of upstreamResp.body) {
          res.write(chunk);
          if (!stored) {
            buffer += decoder.decode(chunk, { stream: true });
            if (buffer.length > SSE_SNIFF_WINDOW) buffer = buffer.slice(-SSE_SNIFF_WINDOW);
            const m = buffer.match(SSE_ID_RE);
            if (m && bodyObj) {
              const fi = fullInputFor(bodyObj, chain);
              if (fi) {
                historySet(m[1], fi, chain.chainId);
                stored = true;
              } else {
                log(`sse resp ${m[1]}: input=${describeInput(bodyObj.input)}, not storable`);
                stored = true;
              }
            }
          }
        }
        res.end();
        if (!stored) {
          log(`sse resp ended without id sniffed, buffer hint=${buffer.slice(0, 300)}`);
        }
      } catch (e) {
        log(`stream pipe error: ${e.message}`);
        try { res.end(); } catch {}
      }
    } else {
      const buf = Buffer.from(await upstreamResp.arrayBuffer());
      res.end(buf);
    }
  });
}

const server = http.createServer(handle);
loadHistory();
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`opencode-retry-proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM}`);
  log(`log file: ${LOG_FILE}`);
});
server.on('error', e => { log(`server error: ${e.message}`); process.exit(1); });
process.on('SIGTERM', () => { log('SIGTERM'); flushSave(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { log('SIGINT'); flushSave(); server.close(() => process.exit(0)); });
