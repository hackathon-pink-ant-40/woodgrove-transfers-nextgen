/**
 * Confluence search console: a small UI on top of the server's read-only /confluence/ routes.
 * Runs in the browser without a build step. Renders all Confluence content with textContent only,
 * never innerHTML, since page content comes from an external source (WGB-103 style precaution).
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'woodgrove.confluenceProxyKey';

  const connectToggle = $('connection-toggle');
  const connectCard = $('connect-card');
  const connectForm = $('connect-form');
  const searchForm = $('search-form');
  const proxyKeyField = $('proxyKey');
  const rememberField = $('rememberKey');
  const connectStatus = $('connect-status');
  const connectionDot = $('connection-dot');
  const connectionLabel = $('connection-label');
  const limitInput = $('limit');
  const limitValue = $('limit-value');
  const overlay = $('overlay');
  const pageView = $('page-view');

  // Restore a remembered key for this tab only (sessionStorage), never persisted to disk.
  const remembered = sessionStorage.getItem(STORAGE_KEY);
  if (remembered) {
    proxyKeyField.value = remembered;
    rememberField.checked = true;
  }

  function proxyKey() {
    return proxyKeyField.value.trim();
  }

  function authHeaders() {
    return { Authorization: `Bearer ${proxyKey()}` };
  }

  async function callConfluence(path) {
    const response = await fetch(path, { headers: authHeaders() });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error ? body.error.message : 'Request failed.');
      error.code = body.error ? body.error.code : 'UNKNOWN_ERROR';
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  /** A quick, safe plain-text preview of Confluence storage format: strip tags, decode common entities. */
  function toPlainText(storageValue) {
    return String(storageValue || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function setConnectionState(state, message) {
    connectionDot.className = `connection-dot ${state}`;
    connectionLabel.textContent = message;
  }

  // --- Connection panel toggle ---
  connectToggle.addEventListener('click', () => {
    const open = connectCard.hidden;
    connectCard.hidden = !open;
    connectToggle.setAttribute('aria-expanded', String(open));
    if (open) proxyKeyField.focus();
  });

  // --- Show/hide proxy key ---
  const toggleVisibility = $('toggle-key-visibility');
  toggleVisibility.addEventListener('click', () => {
    const showing = proxyKeyField.type === 'text';
    proxyKeyField.type = showing ? 'password' : 'text';
    toggleVisibility.setAttribute('aria-pressed', String(!showing));
    toggleVisibility.setAttribute('aria-label', showing ? 'Show key' : 'Hide key');
    toggleVisibility.textContent = showing ? '👁' : '🙈';
  });

  // --- Max results slider ---
  limitInput.addEventListener('input', () => {
    limitValue.textContent = limitInput.value;
  });

  connectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (rememberField.checked) sessionStorage.setItem(STORAGE_KEY, proxyKey());
    else sessionStorage.removeItem(STORAGE_KEY);

    connectStatus.className = 'hint';
    connectStatus.textContent = '';
    setConnectionState('checking', 'Checking…');
    try {
      const status = await callConfluence('/confluence/status');
      if (status.connected) {
        setConnectionState('ok', 'Connected');
        connectStatus.className = 'hint ok';
        connectStatus.textContent = '✓ Connected to Confluence';
        connectCard.hidden = true;
        connectToggle.setAttribute('aria-expanded', 'false');
      } else {
        setConnectionState('warn', 'Not configured');
        connectStatus.className = 'hint warn';
        connectStatus.textContent = 'Confluence is not configured on the server.';
      }
    } catch (error) {
      setConnectionState('bad', 'Connection failed');
      connectStatus.className = 'hint warn';
      connectStatus.textContent = `${error.code}: ${error.message}`;
    }
  });

  searchForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = $('query').value.trim();
    const type = searchForm.querySelector('input[name="type"]:checked').value;
    const limit = limitInput.value;

    $('result-empty').hidden = true;
    $('result-body').hidden = false;
    const list = $('search-results');
    $('result-meta').textContent = '';
    list.replaceChildren(resultMessage('Searching…', 'spinner'));

    if (!query) {
      list.replaceChildren(resultMessage('Enter a search query.'));
      return;
    }

    const params = new URLSearchParams({ query, type, limit });
    try {
      const { results } = await callConfluence(`/confluence/search?${params.toString()}`);
      $('result-meta').textContent = `${results.length} result${results.length === 1 ? '' : 's'} for “${query}”`;
      if (results.length === 0) {
        list.replaceChildren(resultMessage('No results found. Try a different query or content type.'));
        return;
      }
      list.replaceChildren(...results.map(buildResultCard));
    } catch (error) {
      $('result-meta').textContent = '';
      list.replaceChildren(resultMessage(`${error.code}: ${error.message}`, 'error'));
    }
  });

  function resultMessage(text, className) {
    const item = el('li', undefined, `result-message${className ? ` ${className}` : ''}`);
    if (className === 'spinner') item.append(el('span', undefined, 'spin'));
    item.append(el('span', text));
    return item;
  }

  function buildResultCard(page) {
    const item = el('li', undefined, 'result-item');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');

    const head = el('div', undefined, 'result-item-head');
    head.append(el('strong', page.title || '(untitled)'), el('span', page.type, `badge badge-${page.type}`));

    const meta = el('div', page.spaceKey ? `Space ${page.spaceKey} · ID ${page.id}` : `ID ${page.id}`, 'muted');

    item.append(head, meta);
    const open = () => openPage(page.id);
    item.addEventListener('click', open);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    return item;
  }

  async function openPage(id) {
    overlay.hidden = false;
    pageView.hidden = false;
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      pageView.classList.add('visible');
    });

    $('page-title').textContent = 'Loading…';
    $('page-summary').replaceChildren();
    $('page-preview').textContent = '';
    $('page-raw').textContent = '';

    try {
      const page = await callConfluence(`/confluence/pages/${encodeURIComponent(id)}`);
      $('page-title').textContent = page.title || '(untitled)';

      const summary = $('page-summary');
      const addRow = (label, value) => summary.append(el('dt', label), el('dd', value || '–'));
      addRow('Type', page.type);
      addRow('Space', page.spaceKey);
      addRow('ID', page.id);

      $('page-preview').textContent = toPlainText(page.content) || '(no text content)';
      $('page-raw').textContent = page.content || '';
    } catch (error) {
      $('page-title').textContent = 'Could not load page';
      $('page-summary').replaceChildren(el('dt', 'Error'), el('dd', `${error.code}: ${error.message}`));
    }
  }

  function closePage() {
    overlay.classList.remove('visible');
    pageView.classList.remove('visible');
    setTimeout(() => {
      overlay.hidden = true;
      pageView.hidden = true;
    }, 180);
  }

  $('page-close').addEventListener('click', closePage);
  overlay.addEventListener('click', closePage);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !pageView.hidden) closePage();
  });

  // --- Preview / raw storage format tabs ---
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((other) => {
        other.classList.toggle('active', other === tab);
        other.setAttribute('aria-selected', String(other === tab));
      });
      $('page-preview').hidden = tab.dataset.tab !== 'preview';
      $('page-raw').hidden = tab.dataset.tab !== 'raw';
    });
  });
})();
