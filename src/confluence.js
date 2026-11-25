/**
 * Read-only Confluence Cloud API client.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Woodgrove = root.Woodgrove || {};
    root.Woodgrove.confluence = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class ConfluenceError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  function createClient(options = {}) {
    const baseUrl = String(options.baseUrl || '').trim().replace(/\/+$/, '');
    const email = String(options.email || '').trim();
    const apiToken = String(options.apiToken || '');
    const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
    const hasAnyConfig = Boolean(baseUrl || email || apiToken);
    const hasAllConfig = Boolean(baseUrl && email && apiToken);

    function configurationState() {
      if (!hasAnyConfig) return 'unconfigured';
      return hasAllConfig ? 'configured' : 'incomplete';
    }

    function apiBaseUrl() {
      if (configurationState() === 'unconfigured') {
        throw new ConfluenceError(503, 'CONFLUENCE_NOT_CONFIGURED', 'Confluence is not configured on this server.');
      }
      if (configurationState() === 'incomplete') {
        throw new ConfluenceError(
          503,
          'CONFLUENCE_CONFIGURATION_INCOMPLETE',
          'Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN.'
        );
      }
      let url;
      try {
        url = new URL(baseUrl);
      } catch (error) {
        throw new ConfluenceError(500, 'CONFLUENCE_CONFIGURATION_INVALID', 'CONFLUENCE_BASE_URL must be a valid HTTPS URL.');
      }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new ConfluenceError(
          500,
          'CONFLUENCE_CONFIGURATION_INVALID',
          'CONFLUENCE_BASE_URL must be an HTTPS URL without credentials, query, or fragment.'
        );
      }
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    }

    async function request(path) {
      const base = apiBaseUrl();
      if (typeof fetchImpl !== 'function') {
        throw new ConfluenceError(503, 'CONFLUENCE_UNAVAILABLE', 'This Node.js runtime does not provide fetch.');
      }
      let response;
      try {
        response = await fetchImpl(`${base}/rest/api${path}`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
          },
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
        });
      } catch (error) {
        throw new ConfluenceError(502, 'CONFLUENCE_UNAVAILABLE', 'Could not reach Confluence.');
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new ConfluenceError(502, 'CONFLUENCE_AUTH_FAILED', 'Confluence rejected the configured credentials.');
        }
        throw new ConfluenceError(502, 'CONFLUENCE_REQUEST_FAILED', 'Confluence could not complete the request.');
      }
      let result;
      try {
        result = await response.json();
      } catch (error) {
        throw new ConfluenceError(502, 'CONFLUENCE_INVALID_RESPONSE', 'Confluence returned an unreadable response.');
      }
      return result;
    }

    async function getCurrentUser() {
      await request('/user/current');
    }

    async function searchPages(query, searchOptions = {}) {
      const type = ['page', 'blogpost', 'any'].includes(searchOptions.type) ? searchOptions.type : 'page';
      const limit = Number.isInteger(searchOptions.limit) ? Math.min(Math.max(searchOptions.limit, 1), 50) : 25;
      const escapedQuery = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const cql = type === 'any' ? `text ~ "${escapedQuery}"` : `type = ${type} AND text ~ "${escapedQuery}"`;
      const params = new URLSearchParams({ cql, limit: String(limit) });
      const result = await request(`/content/search?${params.toString()}`);
      return (Array.isArray(result.results) ? result.results : []).map((page) => ({
        id: String(page.id || ''),
        title: String(page.title || ''),
        type: String(page.type || 'page'),
        spaceKey: page.space && page.space.key ? String(page.space.key) : null,
      }));
    }

    async function getPage(id) {
      const result = await request(`/content/${encodeURIComponent(id)}?expand=body.storage,space`);
      return {
        id: String(result.id || ''),
        title: String(result.title || ''),
        type: String(result.type || 'page'),
        spaceKey: result.space && result.space.key ? String(result.space.key) : null,
        content: result.body && result.body.storage ? String(result.body.storage.value || '') : '',
      };
    }

    return Object.freeze({ configurationState, getCurrentUser, searchPages, getPage });
  }

  return Object.freeze({ ConfluenceError, createClient });
});
