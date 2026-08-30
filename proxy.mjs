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
//   MAX_HISTORY        default 10000            — max stored response ids (refs are tiny in the shared-chain model)
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
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '10000', 10);
const MAX_HISTORY_BYTES = parseInt(process.env.MAX_HISTORY_BYTES || String(256 * 1024 * 1024), 10);
const MERGE_MAX_BYTES = parseInt(process.env.MERGE_MAX_BYTES || String(4 * 1024 * 1024), 10);
const HISTORY_FILE = process.env.HISTORY_FILE || '/tmp/opencode-retry-proxy-history.json';
const MODEL_ALIAS = { 'muse-spark-1.2-retry': 'muse-spark-1.2-contributor' };

// Context-overflow self-heal. muse reports context-length overflow as a generic
// 400 "invalid_request_error: The request contains invalid parameters" (no
// "context length exceeded" wording), which is indistinguishable from a
// malformed body by message alone. For large requests we estimate input tokens;
// on such a 400 we compact the input (keep head task context + recent tail,
// drop the middle, preserve function_call/output pairing) and retry, then again
// at 70% budget. Set CTX_MAX_TOKENS=0 to disable.
const CTX_MAX_TOKENS = parseInt(process.env.CTX_MAX_TOKENS || '750000', 10);
const CTX_HEAD_TOKENS = parseInt(process.env.CTX_HEAD_TOKENS || '20000', 10);
const CTX_MIN_SUSPECT_TOKENS = parseInt(process.env.CTX_MIN_SUSPECT_TOKENS || '400000', 10);

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// Session chains: one shared, mutable input array per chain; response ids are
// tiny refs (respId -> chainId) into their chain. Memory is O(total context)
// per session, not O(turns x context) — a 1000-turn session costs ~one chain.
// Eviction order is global FIFO over resp ids; a chain is freed when its last
// id is evicted.
const chains = new Map();   // chainId -> { input: Array, headHash, bytes, refs }
const history = new Map();  // respId -> chainId (insertion order = eviction order)
let totalBytes = 0;
let chainCounter = 0;
const headIndex = new Map(); // headHash -> chainId (recent, capped) to rejoin chains on full resends

function headHash(input) {
  try {
    return crypto.createHash('sha1').update(JSON.stringify(input[0] ?? '')).digest('hex').slice(0, 12);
  } catch { return null; }
}

function newChainId() { return `c${++chainCounter}`; }

function chainBytes(input) {
  try { return JSON.stringify(input).length; } catch { return 0; }
}

function appendInto(arr, items) { for (const it of items) arr.push(it); }

function dropOldestEntry() {
  const oldestId = history.keys().next().value;
  const cid = history.get(oldestId);
  history.delete(oldestId);
  const ch = chains.get(cid);
  if (!ch) return;
  ch.refs -= 1;
  if (ch.refs <= 0) {
    totalBytes -= ch.bytes;
    chains.delete(cid);
  }
}

// Record a successful response id. Decides append vs reset vs fresh-chain:
//  - request carried previous_response_id and its chain is known: append the
//    incremental input (or reset on full resend / compaction, detected by
//    head-hash match against the chain head);
//  - request has no previous_response_id (merged retry body or client full
//    resend without chaining): the input already IS the full chain — replace;
//  - request carried an unknown/expired prev id: start fresh chain content.
function storeResponse(id, bodyObj, chain) {
  const cur = normalizeInput(bodyObj);
  if (!Array.isArray(cur)) {
    log(`resp ${id}: input=${describeInput(bodyObj.input)}, not storable`);
    return;
  }
  const hh = cur.length ? headHash(cur) : null;
  let ch = chains.get(chain.chainId);
  if (!bodyObj.previous_response_id) {
    if (!ch) { ch = { input: [], headHash: null, bytes: 0, refs: 0 }; chains.set(chain.chainId, ch); }
    const nb = chainBytes(cur);
    totalBytes += nb - ch.bytes;
    ch.input = cur.slice();
    ch.headHash = hh;
    ch.bytes = nb;
  } else if (ch) {
    if (hh && hh === ch.headHash) {
      log(`session ${chain.chainId}: full resend/compaction detected (${cur.length} items), chain reset`);
      const nb = chainBytes(cur);
      totalBytes += nb - ch.bytes;
      ch.input = cur.slice();
      ch.bytes = nb;
      ch.headHash = hh;
    } else {
      appendInto(ch.input, cur);
      totalBytes += chainBytes(cur);
      ch.bytes = chainBytes(ch.input);
    }
  } else {
    ch = { input: cur.slice(), headHash: hh, bytes: 0, refs: 0 };
    ch.bytes = chainBytes(ch.input);
    totalBytes += ch.bytes;
    chains.set(chain.chainId, ch);
  }
  history.set(id, chain.chainId);
  ch.refs += 1;
  if (hh) {
    headIndex.set(hh, chain.chainId);
    while (headIndex.size > 100) headIndex.delete(headIndex.keys().next().value);
  }
  log(`stored history ${id} session=${chain.chainId} items=${ch.input.length} bytes=${ch.bytes} (entries=${history.size}, chains=${chains.size}, totalBytes=${totalBytes})`);
  // evict oldest while over budget; never evict the only (just-inserted) entry
  while (history.size > 1 && (history.size > MAX_HISTORY || totalBytes > MAX_HISTORY_BYTES)) {
    dropOldestEntry();
  }
  scheduleSave();
}

// Disk persistence: survives proxy restarts (in-memory history is lost on every
// restart, which is exactly when previously-alive chains start expiring).
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = JSON.stringify({ v: 2, chainCounter, chains: [...chains], ids: [...history] });
    fs.writeFile(HISTORY_FILE, data, err => { if (err) log(`history save failed: ${err.message}`); });
  }, 3000);
  saveTimer.unref?.();
}

function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    if (chains.size) fs.writeFileSync(HISTORY_FILE, JSON.stringify({ v: 2, chainCounter, chains: [...chains], ids: [...history] }));
  } catch {}
}

function afterLoad() {
  chainCounter = Math.max(chainCounter, chains.size);
  totalBytes = 0;
  for (const ch of chains.values()) totalBytes += ch.bytes;
  while (history.size > 1 && (history.size > MAX_HISTORY || totalBytes > MAX_HISTORY_BYTES)) dropOldestEntry();
}

function loadHistory() {
  let data;
  try { data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return; }
  if (data && data.v === 2 && Array.isArray(data.chains)) {
    for (const [cid, ch] of data.chains) {
      if (ch && Array.isArray(ch.input)) {
        chains.set(cid, { input: ch.input, headHash: ch.headHash || null, bytes: chainBytes(ch.input), refs: 0 });
        if (ch.headHash) headIndex.set(ch.headHash, cid);
      }
    }
    for (const [id, cid] of data.ids || []) {
      if (chains.has(cid)) { history.set(id, cid); chains.get(cid).refs += 1; }
    }
    chainCounter = Number.isFinite(data.chainCounter) ? data.chainCounter : 0;
    afterLoad();
    log(`restored ${history.size} ids across ${chains.size} sessions from ${HISTORY_FILE} (totalBytes=${totalBytes})`);
    return;
  }
  if (data && Array.isArray(data.entries)) {
    // v1 migration: one full-input copy per id; the latest entry per chain is the chain content
    const latest = new Map();
    for (const [id, e] of data.entries) {
      if (e && Array.isArray(e.input) && e.chainId) latest.set(e.chainId, { id, e });
    }
    for (const [cid, { e }] of latest) {
      chains.set(cid, { input: e.input, headHash: e.headHash || null, bytes: chainBytes(e.input), refs: 0 });
      if (e.headHash) headIndex.set(e.headHash, cid);
    }
    for (const [id, e] of data.entries) {
      if (e && e.chainId && chains.has(e.chainId)) { history.set(id, e.chainId); chains.get(e.chainId).refs += 1; }
    }
    chainCounter = Number.isFinite(data.chainCounter) ? data.chainCounter : 0;
    afterLoad();
    log(`migrated v1 history: ${history.size} ids across ${chains.size} sessions (totalBytes=${totalBytes})`);
  }
}

function isExpiredError(status, bodyText) {
  if (status !== 400) return false;
  if (!bodyText) return false;
  const t = bodyText.toLowerCase();
  return t.includes('referenced response not found') || (t.includes('referenced response') && t.includes('expired')) || (t.includes('previous_response_id') && t.includes('not found'));
}

// Rough token estimate: CJK ≈ 1 token/char, other chars ≈ 0.3. Calibrated so
// the observed muse limit (~870k est tokens) sits well below the 1M configured
// context_window; the budget is in the same units so the margin holds even if
// the absolute accuracy is poor.
function estTokens(s) {
  if (typeof s !== 'string' || !s.length) return 0;
  const cjk = (s.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g) || []).length;
  return cjk + (s.length - cjk) * 0.3;
}

function itemTokens(it) {
  if (!it || typeof it !== 'object') return 0;
  let n = 0;
  if (typeof it.arguments === 'string') n += estTokens(it.arguments);
  if (typeof it.output === 'string') n += estTokens(it.output);
  if (typeof it.content === 'string') n += estTokens(it.content);
  if (Array.isArray(it.content)) for (const p of it.content) if (p && typeof p.text === 'string') n += estTokens(p.text);
  return n + 4; // per-item JSON overhead
}

function estimateInputTokens(input) {
  return Array.isArray(input) ? input.reduce((a, it) => a + itemTokens(it), 0) : 0;
}

// Keep the head (task/system context) and the recent tail, drop the middle, so
// the model keeps both the original task and the latest state. function_call /
// function_call_output pairs are kept atomic (a kept output needs its call and
// vice versa) to avoid muse's call_id mismatch errors. Returns the original
// array when it cannot meaningfully shrink.
function compactForBudget(input, budget) {
  const toks = input.map(itemTokens);
  const total = toks.reduce((a, b) => a + b, 0);
  if (total <= budget) return input;

  let h = 0, headSum = 0;
  while (h < input.length && headSum + toks[h] <= CTX_HEAD_TOKENS) { headSum += toks[h]; h++; }
  if (h >= input.length) return input;

  let K = input.length, tailSum = 0;
  const tailBudget = Math.max(0, budget - headSum);
  while (K > h && tailSum + toks[K - 1] <= tailBudget) { tailSum += toks[K - 1]; K--; }
  if (K <= h) return input;

  const fcIndex = new Map();
  const fcoIndex = new Map();
  input.forEach((it, i) => {
    if (it && it.type === 'function_call' && it.call_id) fcIndex.set(it.call_id, i);
    if (it && it.type === 'function_call_output' && it.call_id && !fcoIndex.has(it.call_id)) fcoIndex.set(it.call_id, i);
  });
  let changed = true, guard = 0;
  while (changed && guard++ < 5000) {
    changed = false;
    for (let i = 0; i < h; i++) {
      const it = input[i];
      if (it && it.type === 'function_call' && it.call_id) {
        const oi = fcoIndex.get(it.call_id);
        if (oi !== undefined && oi >= h) { h = Math.min(input.length, oi + 1); changed = true; }
      }
    }
    for (let j = K; j < input.length; j++) {
      const it = input[j];
      if (it && it.type === 'function_call_output' && it.call_id) {
        const fi = fcIndex.get(it.call_id);
        if (fi !== undefined && fi < K) { K = fi; changed = true; }
      }
    }
    if (h >= K) return input;
  }
  if (K - h < 1) return input;
  return [...input.slice(0, h), ...input.slice(K)];
}

function isOverflowSuspect(status, bodyText, input) {
  if (status !== 400 || !Array.isArray(input) || !input.length) return false;
  if (isExpiredError(status, bodyText)) return false;
  const t = (bodyText || '').toLowerCase();
  if (!(t.includes('invalid_request_error') || t.includes('invalid parameters'))) return false;
  return estimateInputTokens(input) > CTX_MIN_SUSPECT_TOKENS;
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
  const prevChainId = bodyObj.previous_response_id ? history.get(bodyObj.previous_response_id) : null;
  const prevChain = prevChainId ? chains.get(prevChainId) : null;
  const chainId = prevChainId || (hh ? headIndex.get(hh) : null) || newChainId();
  return { chainId, prevChain, hh };
}

// Build the retry body: strip previous_response_id, merge the chain's full
// history into input (unless the request is itself a full resend), sanitize
// reasoning items. Returns null when we cannot reconstruct the full context or
// the merged body exceeds MERGE_MAX_BYTES (the 400 is then passed through).
function buildRetryBody(bodyObj, chain) {
  const prevChain = chain.prevChain;
  const cur = normalizeInput(bodyObj);
  if (!prevChain || !Array.isArray(prevChain.input) || !Array.isArray(cur)) return null;
  const hh = cur.length ? headHash(cur) : null;
  const resend = hh && hh === prevChain.headHash;
  if (resend) log(`session ${chain.chainId}: full resend/compaction detected on retry, using resend input as-is (${cur.length} items)`);
  const mergedInput = resend ? cur : [...prevChain.input, ...cur];
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

// Retry transient network failures (Node fetch throws "fetch failed" on
// connection resets / stale keep-alive). HTTP error statuses return normally
// and are NOT retried here. A retry carrying the same previous_response_id may
// hit "referenced response not found or expired" if the first attempt consumed
// the chain — the merge path then reconstructs the full context.
async function fetchWithRetry(targetUrl, method, headers, bodyBuf, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await doFetch(targetUrl, method, headers, bodyBuf);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
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
      upstreamResp = await fetchWithRetry(targetUrl, req.method, fwdHeaders, effectiveRawBody.length ? effectiveRawBody : undefined);
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
        const reconstructable = chain.prevChain && Array.isArray(chain.prevChain.input) && Array.isArray(normalizeInput(bodyObj));
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
            const retryResp = await fetchWithRetry(targetUrl, req.method, retryHeaders, retryBody);
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

    // Self-heal context overflow: muse reports context-length overflow as a
    // generic invalid_request_error. For large inputs, compact (keep head task
    // context + recent tail, drop the middle, preserve call/output pairing)
    // and retry at CTX_MAX_TOKENS, then at 70% of it. On success the turn keeps
    // running with reduced (older) context instead of dying on a 400.
    if (bodyObj && Array.isArray(bodyObj.input) && CTX_MAX_TOKENS > 0) {
      let bodyTextForOverflow = '';
      try { bodyTextForOverflow = await upstreamResp.clone().text(); } catch {}
      if (isOverflowSuspect(upstreamResp.status, bodyTextForOverflow, bodyObj.input)) {
        const origEst = Math.round(estimateInputTokens(bodyObj.input));
        for (const budget of [CTX_MAX_TOKENS, Math.round(CTX_MAX_TOKENS * 0.7)]) {
          const compacted = compactForBudget(bodyObj.input, budget);
          if (!compacted || compacted.length >= bodyObj.input.length) break;
          const retryBodyObj = { ...bodyObj, input: compacted };
          const retryText = JSON.stringify(retryBodyObj);
          const retryBody = Buffer.from(retryText);
          const retryHeaders = { ...fwdHeaders, 'content-type': 'application/json' };
          log(`session ${chain.chainId}: context overflow suspected (est=${origEst} tokens), compacting ${bodyObj.input.length} -> ${compacted.length} items (est=${Math.round(estimateInputTokens(compacted))}), retry budget ${budget}`);
          try {
            const retryResp = await fetchWithRetry(targetUrl, req.method, retryHeaders, retryBody);
            let retryCheck = '';
            try { retryCheck = await retryResp.clone().text(); } catch {}
            if (retryResp.status === 400) {
              log(`compaction retry still 400 (budget ${budget}), ${retryCheck.slice(0, 200)}`);
              upstreamResp = retryResp;
              continue;
            }
            log(`compaction retry result: ${retryResp.status} ${retryResp.statusText}`);
            upstreamResp = retryResp;
            bodyObj = retryBodyObj;
            break;
          } catch (e) {
            log(`compaction retry fetch failed: ${e.message}`);
            break;
          }
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
        storeResponse(j.id, bodyObj, chain);
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
              storeResponse(m[1], bodyObj, chain);
              stored = true;
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
