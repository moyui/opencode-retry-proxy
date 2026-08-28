#!/usr/bin/env node
// opencode-retry-proxy — transparent retry for "referenced response not found or expired"
// Listens on 127.0.0.1:8765 -> forwards to https://opencode.ai/zen/go/v1
// On 400 expired previous_response_id, strips it, merges history, retries once.
//
// Env overrides (all optional):
//   LISTEN_HOST  default 127.0.0.1  — MUST stay loopback, do NOT use 0.0.0.0 (open proxy risk)
//   LISTEN_PORT  default 8765
//   UPSTREAM     default https://opencode.ai/zen/go/v1
//   LOG_FILE     default /tmp/opencode-retry-proxy.log
//   MAX_HISTORY  default 300
import http from 'node:http';
import fs from 'node:fs';
import { URL } from 'node:url';

const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '8765', 10);
const UPSTREAM = process.env.UPSTREAM || 'https://opencode.ai/zen/go/v1';
const LOG_FILE = process.env.LOG_FILE || '/tmp/opencode-retry-proxy.log';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '300', 10);
const MODEL_ALIAS = { 'muse-spark-1.2-retry': 'muse-spark-1.2-contributor' };

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const history = new Map(); // respId -> full input array

function isExpiredError(status, bodyText) {
  if (status !== 400) return false;
  if (!bodyText) return false;
  const t = bodyText.toLowerCase();
  return t.includes('referenced response not found') || (t.includes('referenced response') && t.includes('expired')) || (t.includes('previous_response_id') && t.includes('not found'));
}

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

function getMergedBody(bodyObj) {
  if (!bodyObj || typeof bodyObj !== 'object' || !bodyObj.previous_response_id) return null;
  const prevId = bodyObj.previous_response_id;
  const curInput = bodyObj.input;
  const prevHistory = history.get(prevId);
  let mergedInput = curInput;
  if (prevHistory && Array.isArray(curInput) && Array.isArray(prevHistory)) {
    mergedInput = [...prevHistory, ...curInput];
    log(`merge history ${prevId}: ${prevHistory.length} + ${curInput.length} -> ${mergedInput.length}`);
  } else if (prevHistory) {
    log(`history found for ${prevId} but shape mismatch, keep original input`);
  } else {
    log(`no history for ${prevId}, retry with stripped id only`);
  }
  const { previous_response_id, ...rest } = bodyObj;
  return { ...rest, input: mergedInput };
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

    let upstreamResp;
    try {
      upstreamResp = await doFetch(targetUrl, req.method, fwdHeaders, effectiveRawBody.length ? effectiveRawBody : undefined);
    } catch (e) {
      log(`upstream fetch failed ${targetUrl}: ${e.message}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `proxy upstream fetch failed: ${e.message}`, type: 'proxy_error' }}));
      return;
    }

    if (bodyObj && bodyObj.previous_response_id) {
      let bodyTextForCheck = '';
      try { bodyTextForCheck = await upstreamResp.clone().text(); } catch {}
      if (isExpiredError(upstreamResp.status, bodyTextForCheck)) {
        const merged = getMergedBody(bodyObj);
        if (merged) {
          const retryText = JSON.stringify(merged);
          const retryBody = Buffer.from(retryText);
          const retryHeaders = { ...fwdHeaders, 'content-type': 'application/json' };
          log(`hit expired previous_response_id=${bodyObj.previous_response_id} -> retry without it (${effectiveRawText.length} -> ${retryText.length} bytes) bodyHint=${bodyTextForCheck.slice(0,200)}`);
          try {
            const retryResp = await doFetch(targetUrl, req.method, retryHeaders, retryBody);
            let retryTextCheck = '';
            try { retryTextCheck = await retryResp.clone().text(); } catch {}
            if (!isExpiredError(retryResp.status, retryTextCheck)) {
              log(`retry result: ${retryResp.status} ${retryResp.statusText}`);
              upstreamResp = retryResp;
              bodyObj = merged;
            } else {
              log(`retry still expired 400, giving up`);
              upstreamResp = retryResp;
            }
          } catch (e) {
            log(`retry fetch failed: ${e.message}`);
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
    if (respCT.includes('application/json')) {
      const text = await upstreamResp.text();
      res.end(text);
      const j = tryJson(text);
      if (j && j.id && bodyObj) {
        let fullInput = null;
        if (bodyObj.previous_response_id && history.has(bodyObj.previous_response_id) && Array.isArray(bodyObj.input)) {
          if (history.get(bodyObj.previous_response_id)) {
            const prevHist = history.get(bodyObj.previous_response_id);
            if (Array.isArray(prevHist) && Array.isArray(bodyObj.input) && !text.includes('referenced response')) {
              const isMerged = bodyObj._alreadyMerged;
              if (!isMerged) fullInput = [...prevHist, ...bodyObj.input];
              else fullInput = bodyObj.input;
            } else fullInput = bodyObj.input;
          } else fullInput = bodyObj.input;
        } else {
          fullInput = bodyObj.input ?? bodyObj.messages ?? null;
        }
        if (!fullInput && Array.isArray(bodyObj.input)) fullInput = bodyObj.input;
        if (Array.isArray(fullInput)) {
          history.set(j.id, fullInput);
          if (history.size > MAX_HISTORY) history.delete(history.keys().next().value);
          log(`stored json history ${j.id} len=${fullInput.length}`);
        }
      }
      if (upstreamResp.status >= 400) log(`upstream ${upstreamResp.status} ${text.slice(0,600)}`);
    } else if (respCT.includes('text/event-stream') || upstreamResp.body) {
      let buffer = '';
      let stored = false;
      try {
        for await (const chunk of upstreamResp.body) {
          res.write(chunk);
          if (!stored) {
            buffer += chunk.toString('utf8');
            if (buffer.length > 16384) buffer = buffer.slice(-16384);
            const m = buffer.match(/"id"\s*:\s*"(resp_[^"]+)"/);
            if (m && bodyObj) {
              const rid = m[1];
              let fullInput = bodyObj.input ?? null;
              if (bodyObj.previous_response_id && history.has(bodyObj.previous_response_id) && Array.isArray(fullInput)) {
                const prevHist = history.get(bodyObj.previous_response_id);
                if (Array.isArray(prevHist) && fullInput.length < prevHist.length + 5) {
                  fullInput = [...prevHist, ...fullInput];
                  log(`sse merge for ${rid}: ${prevHist.length} + ${bodyObj.input.length} -> ${fullInput.length}`);
                }
              }
              if (Array.isArray(fullInput)) {
                history.set(rid, fullInput);
                if (history.size > MAX_HISTORY) history.delete(history.keys().next().value);
                log(`stored sse history ${rid} len=${fullInput.length}`);
                stored = true;
              }
            }
          }
        }
        res.end();
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
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`opencode-retry-proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM}`);
  log(`log file: ${LOG_FILE}`);
});
server.on('error', e => { log(`server error: ${e.message}`); process.exit(1); });
process.on('SIGTERM', () => { log('SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { log('SIGINT'); server.close(() => process.exit(0)); });
