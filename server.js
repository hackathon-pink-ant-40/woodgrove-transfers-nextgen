/**
 * Woodgrove Transfers HTTP API (optional). No dependencies: node server.js
 *
 *   GET  /health          → { status: 'ok' }
 *   GET  /ibans/:iban     → validation details for one IBAN
 *   POST /transfers       → create a transfer from a JSON transfer request
 *   GET  /                → the transfer console (console/index.html)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const iban = require('./src/iban');
const transfers = require('./src/transfer');
const confluenceModule = require('./src/confluence');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const MAX_BODY_BYTES = 100 * 1024;
const CONFLUENCE_PROXY_API_KEY = process.env.CONFLUENCE_PROXY_API_KEY || '';
const confluence = confluenceModule.createClient({
  baseUrl: process.env.CONFLUENCE_BASE_URL,
  email: process.env.CONFLUENCE_EMAIL,
  apiToken: process.env.CONFLUENCE_API_TOKEN,
});

// Static files: the console, plus the data/ and src/ files it loads with <script> tags.
const STATIC_DIRS = { '/': 'console', '/data/': 'data', '/src/': 'src' };
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Read the request body, but stop at MAX_BODY_BYTES (WGB-103). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.off('data', onData);
        req.resume(); // discard the rest of the body
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is larger than 100 KB.'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const prefix = pathname.startsWith('/data/') ? '/data/' : pathname.startsWith('/src/') ? '/src/' : '/';
  const dir = path.join(ROOT, STATIC_DIRS[prefix]);
  const name = pathname === '/' ? 'index.html' : pathname.slice(prefix.length);
  const file = path.resolve(dir, name);
  const type = CONTENT_TYPES[path.extname(file)];

  if (!file.startsWith(dir + path.sep) || !type || !fs.existsSync(file)) {
    return sendError(res, 404, 'NOT_FOUND', `Nothing found at ${pathname}`);
  }
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', service: 'woodgrove-transfers', time: new Date().toISOString() });
  }

  if (req.method === 'GET' && pathname.startsWith('/ibans/')) {
    let value;
    try {
      value = decodeURIComponent(pathname.slice('/ibans/'.length));
    } catch (error) {
      return sendError(res, 400, 'INVALID_REQUEST', 'The IBAN in the URL is not encoded correctly.');
    }
    const country = iban.countryOf(value);
    return sendJson(res, 200, {
      iban: iban.normalizeIban(value),
      formatted: iban.formatIban(value),
      valid: iban.isValidIban(value),
      country,
      sepa: iban.isSepaCountry(country),
    });
  }

  if (pathname.startsWith('/confluence/')) {
    if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET to read Confluence data.');
    if (!CONFLUENCE_PROXY_API_KEY) {
      return sendError(res, 503, 'CONFLUENCE_PROXY_NOT_CONFIGURED', 'Set CONFLUENCE_PROXY_API_KEY to enable Confluence routes.');
    }
    const suppliedKey = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length)
      : '';
    const expected = Buffer.from(CONFLUENCE_PROXY_API_KEY);
    const supplied = Buffer.from(suppliedKey);
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      return sendError(res, 401, 'UNAUTHORIZED', 'A valid bearer token is required.');
    }

    try {
      if (pathname === '/confluence/status') {
        if (confluence.configurationState() === 'unconfigured') {
          return sendJson(res, 200, { configured: false, connected: false });
        }
        await confluence.getCurrentUser();
        return sendJson(res, 200, { configured: true, connected: true });
      }

      if (pathname === '/confluence/search') {
        const query = (url.searchParams.get('query') || '').trim();
        if (!query || query.length > 200) {
          return sendError(res, 400, 'INVALID_REQUEST', 'Provide a search query of 1 to 200 characters.');
        }

        const type = url.searchParams.get('type') || 'page';
        if (!['page', 'blogpost', 'any'].includes(type)) {
          return sendError(res, 400, 'INVALID_REQUEST', 'type must be page, blogpost, or any.');
        }

        let limit = 25;
        const rawLimit = url.searchParams.get('limit');
        if (rawLimit !== null) {
          limit = Number(rawLimit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
            return sendError(res, 400, 'INVALID_REQUEST', 'limit must be an integer between 1 and 50.');
          }
        }

        return sendJson(res, 200, { results: await confluence.searchPages(query, { type, limit }) });
      }

      const pageMatch = pathname.match(/^\/confluence\/pages\/([^/]+)$/);
      if (pageMatch) {
        if (!/^\d+$/.test(pageMatch[1])) {
          return sendError(res, 400, 'INVALID_REQUEST', 'The Confluence page ID must contain only digits.');
        }
        return sendJson(res, 200, await confluence.getPage(pageMatch[1]));
      }
    } catch (error) {
      if (error instanceof confluenceModule.ConfluenceError) {
        return sendError(res, error.status, error.code, error.message);
      }
      throw error;
    }
    return sendError(res, 404, 'NOT_FOUND', `No route for ${req.method} ${pathname}`);
  }

  if (pathname === '/transfers') {
    if (req.method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST to create a transfer.');

    let request;
    const body = await readBody(req);
    try {
      request = JSON.parse(body);
    } catch (error) {
      return sendError(res, 400, 'INVALID_JSON', 'The request body must be a JSON transfer request.');
    }

    const transfer = transfers.createTransfer(request);
    return sendJson(res, transfer.status === 'ACCEPTED' ? 201 : 422, transfer);
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);

  return sendError(res, 404, 'NOT_FOUND', `No route for ${req.method} ${pathname}`);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof HttpError) {
      res.setHeader('Connection', 'close');
      return sendError(res, err.status, err.code, err.message);
    }
    // Log the details for the team, but never send stack traces to clients (WGB-103).
    console.error(err);
    sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong on our side. Please try again later.');
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Woodgrove Transfers is running at http://localhost:${PORT}`);
  });
}

module.exports = server;
