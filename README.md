# Woodgrove Transfers

**Woodgrove Transfers** is the payment transfer service of Woodgrove Bank. It checks IBANs, validates SEPA transfers and turns them into transfers that the bank can send. It is small on purpose, so you can explore it, change it and ship it in a 30-minute hands-on lab with GitHub Copilot in VS Code.

> [!NOTE]
> Woodgrove Bank is a fictional bank. All people, accounts, IBANs and keys in this repository are made up for training purposes.

👉 **Workshop guide:** https://natethebuilder.github.io/rabobank-copilot-workshop/#/lab

## Get started

You need **VS Code**, **Git** and a **GitHub Copilot** sign-in. The project has no dependencies and no build step.

1. **Install Node.js (includes npm).** In a terminal, run `node -v`. Version 18 or later is fine. If you don't have it, install the LTS version from https://nodejs.org/en/download (or from your company's software portal). Then quit and reopen VS Code, so its terminal finds Node. Can't install software? Skip this step: the tests also run in a browser.
2. **Make your own copy.** At the top of this page, select **Use this template** → **Create a new repository**. Choose yourself (or your team's sandbox organisation) as owner, select **Private**, then **Create repository**.
3. **Clone it into VS Code.** Open the Command Palette (<kbd>Ctrl+Shift+P</kbd> / <kbd>⇧⌘P</kbd>) → **Git: Clone** → **Clone from GitHub** (sign in if VS Code asks) → pick your copy. You can also paste the HTTPS URL from the green **Code** button on your copy. Choose a folder and select **Open**. If VS Code asks whether you trust the folder, select **Manage** → **Trust**.
   First time using Git on this laptop? Set your name and email once:
   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```
4. **Install and run the tests.** Open the terminal (<kbd>Ctrl+&#96;</kbd> / <kbd>⌃&#96;</kbd>, or **Terminal** → **New Terminal**) and run:
   ```bash
   npm install
   npm test
   ```
   You should see **✓ 30 passed**. Windows says running scripts is disabled? Run `node tests/run.js` (or `npm.cmd test`) instead. No Node.js? Open `tests/index.html` in a browser.

No VS Code on your machine? Open your copy on github.com and select **Code** → **Codespaces** → **Create codespace**.

## Run the tests

Choose whichever works on your machine. Both run the same tests.

| With Node.js (18 or later) | Without Node.js |
|---|---|
| `npm test` in the terminal (or `node tests/run.js`) | Open `tests/index.html` in a browser, or in the VS Code integrated browser |

The browser tab title shows the result, for example `✓ 30 passed` or `✗ 1 failed`.

## Try the transfer console

Open `console/index.html` in a browser to send a (pretend) transfer and see the result and the JSON that the service returns.

With Node.js you can also start the API, which serves the same console at http://localhost:3000:

```bash
node server.js
curl http://localhost:3000/health
curl http://localhost:3000/ibans/NL91ABNA0417164300
```

Set `PORT` to use another port.

### Connect read-only Confluence Cloud

The server can proxy page searches and page reads to Confluence Cloud. Configure the site URL (including `/wiki`), the Atlassian account email, and an API token in the server environment. A separate proxy key is required to protect the app's Confluence routes:

```bash
export CONFLUENCE_BASE_URL="https://dhanunjayarao8899.atlassian.net/wiki"
export CONFLUENCE_EMAIL="dhanunjayarao.8899@gmail.com"
export CONFLUENCE_API_TOKEN="ATATT3xFfGF0Bjigo4V1rwkybdRuSXIpRzbOQLcjd_dxpSJKP7KXa946d8bYICMR_8L41HkqbyXE68HJI4TJ49fx-IahuI-eahHH8jYasSlHGxIIK58l7j7KmnBjH-CouNwcELLCO1M3Bk5YQPzlM_GZzmMW0WK3MqNquy3p1AXrmi3wLcD-e1U=C362859E"
export CONFLUENCE_PROXY_API_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
node server.js
```

Keep both tokens private and out of source control. The Confluence API token is only used by the server; clients must send `Authorization: Bearer $CONFLUENCE_PROXY_API_KEY` to the `/confluence/` endpoints. See [docs/api.md](docs/api.md#confluence-cloud-read-only-endpoints) for endpoint examples.

## Project map

```text
src/
  iban.js          normalizeIban, isValidIban, formatIban, countryOf, isSepaCountry
  money.js         parseAmount ("1.234,56" → 123456 cents) and formatAmount (123456 → "€ 1.234,56")
  transfer.js      validateTransfer and createTransfer
  config.js        transfer limits and service configuration
data/
  accounts.js      Woodgrove's own accounts: IBAN → account holder
console/           the transfer console (index.html, console.js, console.css)
server.js          optional HTTP API, including protected read-only Confluence routes
src/confluence.js  server-side read-only Confluence Cloud API client
tests/
  *.test.js        the tests
  harness.js       a tiny test framework (describe, test, expect)
  run.js           Node runner
  index.html       browser runner
docs/tickets/      the team's backlog: WGB-101 … WGB-106
```

## How the code is put together

- **Money is integer cents.** `12500` means € 125,00.
- **No build step.** Every file in `src/` and `data/` uses a small wrapper, so it works with `require()` in Node and with a plain `<script>` tag in the browser (as `Woodgrove.iban`, `Woodgrove.transfer` and so on).
- **Two test runners, one set of tests.** When you add a file to `src/`, `data/` or `tests/`, also add a `<script>` tag for it to `tests/index.html`. `node tests/run.js` tells you which line to add if you forget.

A transfer request looks like this:

```json
{
  "fromIban": "NL20WGBK0123456789",
  "toIban": "FR7630006000011234567890189",
  "beneficiaryName": "Claire Dubois",
  "amountCents": 12500,
  "description": "Invoice 2026-114",
  "instant": false
}
```
