describe('server (WGB-103)', () => {
  // The HTTP API only exists in Node. In the browser runner these tests are skipped.
  if (typeof window !== 'undefined' || typeof require !== 'function') {
    test('server tests run in Node only (node tests/run.js)', () => {});
    return;
  }

  const http = require('node:http');
  const confluenceEnv = {
    CONFLUENCE_BASE_URL: process.env.CONFLUENCE_BASE_URL,
    CONFLUENCE_EMAIL: process.env.CONFLUENCE_EMAIL,
    CONFLUENCE_API_TOKEN: process.env.CONFLUENCE_API_TOKEN,
    CONFLUENCE_PROXY_API_KEY: process.env.CONFLUENCE_PROXY_API_KEY,
  };
  Object.assign(process.env, {
    CONFLUENCE_BASE_URL: 'https://example.atlassian.net/wiki',
    CONFLUENCE_EMAIL: 'operator@example.test',
    CONFLUENCE_API_TOKEN: 'test-confluence-token',
    CONFLUENCE_PROXY_API_KEY: 'test-proxy-key',
  });
  const server = require('../server');
  const transfers = require('../src/transfer');
  for (const [name, value] of Object.entries(confluenceEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  async function call(method, path, body, headers = {}) {
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      return await new Promise((resolve, reject) => {
        const req = http.request({ port: server.address().port, method, path, headers }, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end(body);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const confluenceHeaders = { Authorization: 'Bearer test-proxy-key' };

  test('a 500 response does not reveal the stack trace', async () => {
    const original = transfers.createTransfer;
    const originalError = console.error;
    transfers.createTransfer = () => {
      throw new Error('database password is hunter2');
    };
    console.error = () => {};
    try {
      const response = await call('POST', '/transfers', '{}');
      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('hunter2');
      expect(response.body.error.stack).toBeUndefined();
    } finally {
      transfers.createTransfer = original;
      console.error = originalError;
    }
  });

  test('rejects request bodies larger than 100 KB', async () => {
    const response = await call('POST', '/transfers', JSON.stringify({ description: 'x'.repeat(200 * 1024) }));
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('a badly encoded IBAN in the URL is a 400, not a crash', async () => {
    const response = await call('GET', '/ibans/%E0%A4%A');
    expect(response.status).toBe(400);
  });

  test('the screening API key is not hardcoded', () => {
    expect(Woodgrove.config.screening.apiKey).not.toMatch(/^wgb_live_/);
  });

  test('Confluence endpoints require the separate proxy key', async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const response = await call('GET', '/confluence/status');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Confluence status verifies credentials without returning account details', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ displayName: 'Private Operator' }) };
    };
    try {
      const response = await call('GET', '/confluence/status', undefined, confluenceHeaders);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ configured: true, connected: true });
      expect(request.url).toBe('https://example.atlassian.net/wiki/rest/api/user/current');
      expect(request.options.headers.Authorization).toBe(
        `Basic ${Buffer.from('operator@example.test:test-confluence-token').toString('base64')}`
      );
      expect(JSON.stringify(response.body)).not.toContain('Private Operator');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Confluence search escapes the query and returns read-only page metadata', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl;
    globalThis.fetch = async (url) => {
      requestUrl = new URL(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ id: '123', title: 'Transfer guide', type: 'page', space: { key: 'OPS' } }],
        }),
      };
    };
    try {
      const response = await call(
        'GET',
        '/confluence/search?query=' + encodeURIComponent('guide"\\'),
        undefined,
        confluenceHeaders
      );
      expect(response.status).toBe(200);
      expect(response.body.results).toEqual([
        { id: '123', title: 'Transfer guide', type: 'page', spaceKey: 'OPS' },
      ]);
      expect(requestUrl.pathname).toBe('/wiki/rest/api/content/search');
      expect(requestUrl.searchParams.get('cql')).toBe('type = page AND text ~ "guide\\"\\\\"');
      expect(requestUrl.searchParams.get('limit')).toBe('25');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Confluence search accepts type and limit options', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl;
    globalThis.fetch = async (url) => {
      requestUrl = new URL(url);
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    };
    try {
      const response = await call(
        'GET',
        '/confluence/search?query=guide&type=any&limit=5',
        undefined,
        confluenceHeaders
      );
      expect(response.status).toBe(200);
      expect(requestUrl.searchParams.get('cql')).toBe('text ~ "guide"');
      expect(requestUrl.searchParams.get('limit')).toBe('5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Confluence search rejects an invalid type or limit', async () => {
    const badType = await call('GET', '/confluence/search?query=guide&type=comment', undefined, confluenceHeaders);
    expect(badType.status).toBe(400);
    expect(badType.body.error.code).toBe('INVALID_REQUEST');

    const badLimit = await call('GET', '/confluence/search?query=guide&limit=0', undefined, confluenceHeaders);
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.error.code).toBe('INVALID_REQUEST');

    const tooHighLimit = await call('GET', '/confluence/search?query=guide&limit=51', undefined, confluenceHeaders);
    expect(tooHighLimit.status).toBe(400);
    expect(tooHighLimit.body.error.code).toBe('INVALID_REQUEST');
  });

  test('Confluence page reads reject malformed IDs and return page content', async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: '123',
          title: 'Transfer guide',
          type: 'page',
          space: { key: 'OPS' },
          body: { storage: { value: '<p>Read-only guide</p>' } },
        }),
      };
    };
    try {
      const invalid = await call('GET', '/confluence/pages/not-an-id', undefined, confluenceHeaders);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('INVALID_REQUEST');
      expect(fetched).toBe(false);

      const response = await call('GET', '/confluence/pages/123', undefined, confluenceHeaders);
      expect(response.status).toBe(200);
      expect(response.body.content).toBe('<p>Read-only guide</p>');
      expect(response.body.spaceKey).toBe('OPS');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Confluence authentication failures do not expose upstream details', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'test-confluence-token was rejected',
    });
    try {
      const response = await call('GET', '/confluence/status', undefined, confluenceHeaders);
      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('CONFLUENCE_AUTH_FAILED');
      expect(JSON.stringify(response.body)).not.toContain('test-confluence-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
