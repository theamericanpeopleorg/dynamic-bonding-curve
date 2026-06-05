/// <reference types="node" />

import http, { IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { URL } from "url";
import {
  getPriceFromSqrtPrice,
  TokenDecimal,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  buy,
  createConfig,
  createPool,
  poolInfo,
  withdrawLeftover,
  withdrawPartnerMigrationFee,
} from "./dbc_tool/commands";
import {
  DEFAULT_RPC_URL,
  MAINNET_USDC_MINT,
  buildClient,
  getActiveCurve,
  getQuoteDecimals,
  getRpcUrl,
  toBN,
  toNumber,
  unwrapVirtualPoolAccount,
} from "./dbc_tool/shared";
import { runKeeper } from "./migration_keeper/keeper";

type Options = {
  host: string;
  port: number;
  rpcUrl: string;
};

type RequestBody = Record<string, unknown>;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5173;
const BODY_LIMIT_BYTES = 1_000_000;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = http.createServer((req, res) => {
    void route(req, res, options).catch((error) => {
      sendError(res, error);
    });
  });

  server.listen(options.port, options.host, () => {
    const address = server.address() as AddressInfo;
    console.log(
      `DBC UI listening at http://${address.address}:${address.port}/`
    );
    console.log(`RPC URL: ${options.rpcUrl}`);
  });
}

function usage() {
  console.log(`Usage:
  bun scripts/dbc_ui.ts [--host <HOST>] [--port <PORT>] [--rpc-url <URL>]

Options:
  --host <HOST>       Host to bind. Default: ${DEFAULT_HOST}
  --port <PORT>       Port to bind. Default: ${DEFAULT_PORT}
  --rpc-url <URL>     Surfpool/localnet RPC. Default: ${DEFAULT_RPC_URL}
  -h, --help          Show this help
`);
}

function parseArgs(argv: string[]): Options {
  const options = {
    host: process.env.HOST ?? DEFAULT_HOST,
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    rpcUrl: getRpcUrl(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    if (arg === "--host") {
      options.host = readValue(argv, ++i, "--host requires a value");
      continue;
    }

    if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
      continue;
    }

    if (arg === "--port") {
      options.port = parsePort(readValue(argv, ++i, "--port requires a value"));
      continue;
    }

    if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
      continue;
    }

    if (arg === "--rpc-url") {
      options.rpcUrl = readValue(argv, ++i, "--rpc-url requires a URL");
      continue;
    }

    if (arg.startsWith("--rpc-url=")) {
      options.rpcUrl = arg.slice("--rpc-url=".length);
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive number");
  }

  return options;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return port;
}

function readValue(argv: string[], index: number, message: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(message);
  }
  return value;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: Options
) {
  const method = req.method ?? "GET";
  const requestUrl = new URL(req.url ?? "/", `http://${options.host}`);

  if (method === "GET" && requestUrl.pathname === "/") {
    sendHtml(res, renderHtml(options));
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/health") {
    await handleHealth(res, options);
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/pool-info") {
    const pool = readQueryValue(requestUrl, "pool");
    const dammConfig = readOptionalPublicKey(
      readQueryValue(requestUrl, "dammConfig"),
      "dammConfig"
    );
    if (!pool) {
      throw new HttpError(400, "pool is required");
    }
    const result = await readPoolDashboard(pool, options.rpcUrl, dammConfig);
    sendJson(res, result);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/create-config") {
    const body = await readJsonBody(req);
    const quoteMint = readOptionalPublicKey(body.quoteMint, "quoteMint");
    const migrationFeePercentage = readOptionalPercentage(
      body.migrationFeePercentage,
      "migrationFeePercentage"
    );
    const migrationQuoteAmountCap = readOptionalString(
      body.migrationQuoteAmountCap
    );
    const creatorMigrationFeePercentage = readOptionalPercentage(
      body.creatorMigrationFeePercentage,
      "creatorMigrationFeePercentage"
    );
    const result = await createConfig({
      rpcUrl: options.rpcUrl,
      quoteMint: quoteMint ?? MAINNET_USDC_MINT,
      migrationQuoteAmountCap,
      migrationFeePercentage,
      creatorMigrationFeePercentage,
    });
    sendJson(res, publicKeyResultToBase58(result));
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/create-pool") {
    const body = await readJsonBody(req);
    const config = readRequiredString(body.config, "config");
    const deadlineTimestamp = readOptionalTimestamp(
      body.deadlineTimestamp,
      "deadlineTimestamp"
    );
    const result = await createPool(config, {
      rpcUrl: options.rpcUrl,
      deadlineTimestamp,
    });
    sendJson(res, publicKeyResultToBase58(result));
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/buy") {
    const body = await readJsonBody(req);
    const pool = readRequiredString(body.pool, "pool");
    const amount = readRequiredString(body.amount, "amount");
    const mode = readRequiredString(body.mode ?? "base", "mode");
    if (mode !== "base" && mode !== "quote") {
      throw new HttpError(400, "mode must be base or quote");
    }
    const minimumBaseAmountOut = readOptionalString(body.minimumBaseAmountOut);
    const result = await buy(pool, amount, {
      rpcUrl: options.rpcUrl,
      partialFill: mode === "quote",
      minimumBaseAmountOut,
    });
    sendJson(res, publicKeyResultToBase58(result));
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/migrate") {
    const body = await readJsonBody(req);
    const pool = readRequiredPublicKey(body.pool, "pool");
    const dammConfig = readRequiredPublicKey(body.dammConfig, "dammConfig");
    await assertPoolCanMigrate(pool, options.rpcUrl);
    const result = await runKeeper({
      pool,
      dammConfig,
      rpcUrl: options.rpcUrl,
      statusIntervalMs: 1_000,
    });
    sendJson(res, publicKeyResultToBase58(result as any));
    return;
  }

  if (
    method === "POST" &&
    requestUrl.pathname === "/api/withdraw-partner-migration-fee"
  ) {
    const body = await readJsonBody(req);
    const pool = readRequiredString(body.pool, "pool");
    const result = await withdrawPartnerMigrationFee(pool, {
      rpcUrl: options.rpcUrl,
    });
    sendJson(res, publicKeyResultToBase58(result));
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/withdraw-leftover") {
    const body = await readJsonBody(req);
    const pool = readRequiredString(body.pool, "pool");
    const result = await withdrawLeftover(pool, {
      rpcUrl: options.rpcUrl,
    });
    sendJson(res, publicKeyResultToBase58(result));
    return;
  }

  throw new HttpError(404, "not found");
}

async function handleHealth(res: ServerResponse, options: Options) {
  try {
    const connection = new Connection(options.rpcUrl, "confirmed");
    const slot = await connection.getSlot("confirmed");
    sendJson(res, {
      ok: true,
      status: "connected",
      rpcUrl: options.rpcUrl,
      slot,
      quoteMintDefault: MAINNET_USDC_MINT.toBase58(),
    });
  } catch (error) {
    sendJson(res, {
      ok: false,
      status: "surfpool_not_found",
      rpcUrl: options.rpcUrl,
      message: errorMessage(error),
      quoteMintDefault: MAINNET_USDC_MINT.toBase58(),
    });
  }
}

async function readPoolDashboard(
  pool: string,
  rpcUrl: string,
  dammConfig?: PublicKey
) {
  const info = await poolInfo(pool, { rpcUrl, dammConfig });
  const curve = await readCurveState(pool, rpcUrl);
  return { info, curve };
}

async function readCurveState(pool: string, rpcUrl: string) {
  const { connection, program } = await buildClient(rpcUrl);
  const poolPublicKey = new PublicKey(pool);
  const poolState = unwrapVirtualPoolAccount(
    await (program.account as any).virtualPool.fetch(poolPublicKey)
  );
  const configPublicKey = new PublicKey(poolState.config);
  const config = (await (program.account as any).poolConfig.fetch(
    configPublicKey
  )) as any;
  const quoteMint = new PublicKey(config.quoteMint);
  const baseDecimals = toNumber(config.tokenDecimal) as TokenDecimal;
  const quoteDecimals = (await getQuoteDecimals(
    connection,
    quoteMint
  )) as TokenDecimal;
  const activeCurve = getActiveCurve(config);

  return {
    currentPrice: getPriceFromSqrtPrice(
      toBN(poolState.sqrtPrice),
      baseDecimals,
      quoteDecimals
    ).toString(),
    startPrice: getPriceFromSqrtPrice(
      toBN(config.sqrtStartPrice),
      baseDecimals,
      quoteDecimals
    ).toString(),
    migrationPrice: getPriceFromSqrtPrice(
      toBN(config.migrationSqrtPrice),
      baseDecimals,
      quoteDecimals
    ).toString(),
    sqrtPrice: toBN(poolState.sqrtPrice).toString(),
    sqrtStartPrice: toBN(config.sqrtStartPrice).toString(),
    migrationSqrtPrice: toBN(config.migrationSqrtPrice).toString(),
    points: activeCurve.map((point, index) => ({
      index,
      sqrtPrice: point.sqrtPrice.toString(),
      liquidity: point.liquidity.toString(),
      price: getPriceFromSqrtPrice(
        point.sqrtPrice,
        baseDecimals,
        quoteDecimals
      ).toString(),
    })),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<RequestBody> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > BODY_LIMIT_BYTES) {
      throw new HttpError(413, "request body too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("JSON body must be an object");
    }
    return value as RequestBody;
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
}

function readQueryValue(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value && value.trim() ? value.trim() : null;
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${name} is required`);
  }
  return value.trim();
}

function readRequiredPublicKey(value: unknown, name: string): PublicKey {
  const stringValue = readRequiredString(value, name);
  try {
    return new PublicKey(stringValue);
  } catch {
    throw new HttpError(400, `${name} must be a valid public key`);
  }
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

function readOptionalPercentage(
  value: unknown,
  name: string
): number | undefined {
  const stringValue = readOptionalString(value);
  if (stringValue == null) {
    return undefined;
  }

  const parsed = Number(stringValue);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new HttpError(400, `${name} must be an integer from 0 to 100`);
  }

  return parsed;
}

async function assertPoolCanMigrate(pool: PublicKey, rpcUrl: string) {
  const dashboard = await readPoolDashboard(pool.toBase58(), rpcUrl);
  const migration = (dashboard.info as any).migration;
  if (migration.migrationProgress === 3) {
    return;
  }
  if (migration.migrationProgress === 2) {
    return;
  }
  if (
    migration.migrationProgress === 0 &&
    migration.completionMode === "deadline" &&
    !migration.hasLockedVesting
  ) {
    return;
  }
  if (migration.migrationProgress === 1 || migration.hasLockedVesting) {
    throw new HttpError(400, "pool needs locker creation before migration");
  }
  throw new HttpError(400, "pool is not migration-ready");
}

function readOptionalTimestamp(
  value: unknown,
  name: string
): string | undefined {
  const stringValue = readOptionalString(value);
  if (!stringValue) {
    return undefined;
  }
  if (!/^\d+$/.test(stringValue)) {
    throw new HttpError(400, `${name} must be a Unix timestamp`);
  }
  return stringValue;
}

function readOptionalPublicKey(
  value: unknown,
  name: string
): PublicKey | undefined {
  const stringValue = readOptionalString(value);
  if (!stringValue) {
    return undefined;
  }
  try {
    return new PublicKey(stringValue);
  } catch {
    throw new HttpError(400, `${name} must be a valid public key`);
  }
}

function publicKeyResultToBase58<T extends Record<string, unknown>>(
  result: T
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [
      key,
      isPublicKeyLike(value) ? value.toBase58() : value,
    ])
  );
}

function isPublicKeyLike(value: unknown): value is { toBase58(): string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  );
}

function sendHtml(res: ServerResponse, html: string) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function sendJson(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value, null, 2));
}

function sendError(res: ServerResponse, error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  sendJson(
    res,
    {
      ok: false,
      error: errorMessage(error),
    },
    status
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function renderHtml(options: Options): string {
  const rpcUrl = JSON.stringify(options.rpcUrl);
  const defaultQuoteMint = JSON.stringify(MAINNET_USDC_MINT.toBase58());

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meteora DBC Pool Watcher</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-soft: #eef3f0;
      --ink: #17201d;
      --muted: #60706a;
      --line: #d8dfdb;
      --accent: #157f62;
      --accent-strong: #0f5d48;
      --warn: #af5b12;
      --bad: #b83131;
      --good: #0f7c56;
      --quote: #3a5f91;
      --base: #8b3d73;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-size: 14px;
    }

    button, input, select {
      font: inherit;
    }

    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #ffffff;
      min-height: 36px;
      border-radius: 6px;
      padding: 0 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    button.secondary {
      background: #ffffff;
      color: var(--accent-strong);
      border-color: var(--line);
    }

    button:disabled {
      opacity: 0.58;
      cursor: progress;
    }

    input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      min-height: 36px;
      padding: 7px 9px;
      background: #ffffff;
      color: var(--ink);
    }

    label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 5px;
    }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
    }

    .sidebar {
      background: #ffffff;
      border-right: 1px solid var(--line);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .main {
      padding: 18px 20px 28px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .topbar {
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 14px;
    }

    .title {
      margin: 0;
      font-size: 22px;
      line-height: 1.1;
      letter-spacing: 0;
    }

    .rpc {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
      text-align: right;
    }

    .section {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .section-title {
      margin: 0;
      font-size: 13px;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0;
    }

    .row {
      display: flex;
      gap: 8px;
      align-items: end;
    }

    .row > * {
      min-width: 0;
    }

    .grow {
      flex: 1;
    }

    .status {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      border-radius: 999px;
      padding: 0 10px;
      font-size: 12px;
      border: 1px solid var(--line);
      background: #ffffff;
      color: var(--muted);
      white-space: nowrap;
    }

    .status.good {
      color: var(--good);
      border-color: #b6dbc9;
      background: #edf8f2;
    }

    .status.bad {
      color: var(--bad);
      border-color: #ecc2c2;
      background: #fff0ef;
    }

    .status.warn {
      color: var(--warn);
      border-color: #ead0a9;
      background: #fff7e8;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }

    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      min-height: 86px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 8px;
    }

    .metric .label {
      color: var(--muted);
      font-size: 12px;
    }

    .metric .value {
      font-size: 20px;
      line-height: 1.1;
      overflow-wrap: anywhere;
      letter-spacing: 0;
    }

    .metric .sub {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }

    .kv {
      display: grid;
      grid-template-columns: minmax(120px, 0.34fr) minmax(0, 1fr);
      gap: 8px 12px;
      align-items: start;
      font-size: 13px;
    }

    .kv dt {
      color: var(--muted);
    }

    .kv dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }

    .chart-wrap {
      min-height: 306px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    svg {
      display: block;
      width: 100%;
      min-height: 220px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfc;
    }

    .legend {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
    }

    .swatch {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .swatch::before {
      content: "";
      width: 10px;
      height: 10px;
      border-radius: 2px;
      background: var(--accent);
    }

    .swatch.base::before {
      background: var(--base);
    }

    .swatch.quote::before {
      background: var(--quote);
    }

    .log {
      min-height: 74px;
      max-height: 220px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--muted);
      background: #fbfcfc;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
    }

    .empty {
      color: var(--muted);
      padding: 18px 0;
    }

    @media (max-width: 980px) {
      .shell {
        grid-template-columns: 1fr;
      }

      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      .metrics, .grid {
        grid-template-columns: 1fr 1fr;
      }
    }

    @media (max-width: 640px) {
      .main, .sidebar {
        padding: 14px;
      }

      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }

      .rpc {
        text-align: left;
      }

      .row {
        align-items: stretch;
        flex-direction: column;
      }

      .metrics, .grid {
        grid-template-columns: 1fr;
      }

      .kv {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="section">
        <h1 class="title">Meteora DBC</h1>
        <div id="status" class="status warn">connecting</div>
      </div>

      <div class="section">
        <h2 class="section-title">Pool</h2>
        <div>
          <label for="poolInput">Pool address</label>
          <input id="poolInput" autocomplete="off" spellcheck="false" placeholder="Pool pubkey">
        </div>
        <button id="watchButton" type="button">Watch</button>
      </div>

      <div class="section">
        <h2 class="section-title">Create</h2>
        <div>
          <label for="quoteMintInput">Quote mint</label>
          <input id="quoteMintInput" autocomplete="off" spellcheck="false">
        </div>
        <div>
          <label for="migrationQuoteAmountCapInput">Migration quote cap raw</label>
          <input id="migrationQuoteAmountCapInput" inputmode="numeric" autocomplete="off" placeholder="0">
        </div>
        <div>
          <label for="migrationFeeInput">Migration fee pct</label>
          <input id="migrationFeeInput" inputmode="numeric" autocomplete="off" placeholder="0">
        </div>
        <div>
          <label for="creatorMigrationFeeInput">Creator fee split pct</label>
          <input id="creatorMigrationFeeInput" inputmode="numeric" autocomplete="off" placeholder="0">
        </div>
        <button id="createConfigButton" type="button">Create Config</button>
        <div>
          <label for="configInput">Config address</label>
          <input id="configInput" autocomplete="off" spellcheck="false" placeholder="Config pubkey">
        </div>
        <div>
          <label for="deadlineInput">Deadline timestamp</label>
          <input id="deadlineInput" inputmode="numeric" autocomplete="off" placeholder="0">
        </div>
        <button id="createPoolButton" type="button">Create Pool</button>
      </div>

      <div class="section">
        <h2 class="section-title">Buy</h2>
        <div>
          <label for="buyModeInput">Mode</label>
          <select id="buyModeInput">
            <option value="base">Buy base amount</option>
            <option value="quote">Spend quote amount</option>
          </select>
        </div>
        <div>
          <label for="buyAmountInput">Amount</label>
          <input id="buyAmountInput" inputmode="decimal" autocomplete="off" placeholder="0">
        </div>
        <div id="minBaseRow">
          <label for="minBaseInput">Minimum base out</label>
          <input id="minBaseInput" inputmode="decimal" autocomplete="off" placeholder="0">
        </div>
        <button id="buyButton" type="button">Buy</button>
      </div>

      <div class="section">
        <h2 class="section-title">Migrate</h2>
        <div>
          <label for="dammConfigInput">DAMM v2 config</label>
          <input id="dammConfigInput" autocomplete="off" spellcheck="false" placeholder="Config pubkey">
        </div>
        <button id="migrateButton" type="button">Migrate Curve</button>
        <button id="withdrawPartnerMigrationFeeButton" class="secondary" type="button">Withdraw Partner Quote Fee</button>
        <button id="withdrawLeftoverButton" class="secondary" type="button">Withdraw Leftover Base</button>
      </div>
    </aside>

    <main class="main">
      <div class="topbar">
        <div>
          <h1 class="title">Pool Watcher</h1>
        </div>
        <div class="rpc" id="rpcLabel"></div>
      </div>

      <section class="metrics" id="metrics"></section>

      <section class="grid">
        <div class="panel chart-wrap">
          <h2 class="section-title">Curve</h2>
          <svg id="curveSvg" viewBox="0 0 760 220" role="img" aria-label="Bonding curve"></svg>
          <div class="legend">
            <span class="swatch">Curve</span>
            <span class="swatch base">Current</span>
            <span class="swatch quote">Migration</span>
          </div>
        </div>

        <div class="panel">
          <h2 class="section-title">Sale</h2>
          <dl class="kv" id="saleDetails"></dl>
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <h2 class="section-title">Addresses</h2>
          <dl class="kv" id="addressDetails"></dl>
        </div>
        <div class="panel">
          <h2 class="section-title">Migration & Fees</h2>
          <dl class="kv" id="migrationDetails"></dl>
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <h2 class="section-title">Fee Balances</h2>
          <dl class="kv" id="feeBalanceDetails"></dl>
        </div>
        <div class="panel">
          <h2 class="section-title">Migration Fee Estimate</h2>
          <dl class="kv" id="feeEstimateDetails"></dl>
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <h2 class="section-title">Migration Result</h2>
          <dl class="kv" id="migrationResultDetails"></dl>
        </div>
        <div class="panel">
          <h2 class="section-title">Money Destinations</h2>
          <dl class="kv" id="destinationDetails"></dl>
        </div>
      </section>

      <section class="panel">
        <h2 class="section-title">Activity</h2>
        <div class="log" id="activityLog"></div>
      </section>
    </main>
  </div>

  <script>
    const RPC_URL = ${rpcUrl};
    const DEFAULT_QUOTE_MINT = ${defaultQuoteMint};
    const REFRESH_MS = 1000;
    const state = {
      health: null,
      dashboard: null,
      refreshing: false,
      lastError: null,
      lastMigrationResult: null,
    };

    const el = {
      status: document.getElementById("status"),
      rpcLabel: document.getElementById("rpcLabel"),
      poolInput: document.getElementById("poolInput"),
      watchButton: document.getElementById("watchButton"),
      quoteMintInput: document.getElementById("quoteMintInput"),
      migrationQuoteAmountCapInput: document.getElementById("migrationQuoteAmountCapInput"),
      migrationFeeInput: document.getElementById("migrationFeeInput"),
      creatorMigrationFeeInput: document.getElementById("creatorMigrationFeeInput"),
      configInput: document.getElementById("configInput"),
      deadlineInput: document.getElementById("deadlineInput"),
      createConfigButton: document.getElementById("createConfigButton"),
      createPoolButton: document.getElementById("createPoolButton"),
      buyModeInput: document.getElementById("buyModeInput"),
      buyAmountInput: document.getElementById("buyAmountInput"),
      minBaseRow: document.getElementById("minBaseRow"),
      minBaseInput: document.getElementById("minBaseInput"),
      buyButton: document.getElementById("buyButton"),
      dammConfigInput: document.getElementById("dammConfigInput"),
      migrateButton: document.getElementById("migrateButton"),
      withdrawPartnerMigrationFeeButton: document.getElementById("withdrawPartnerMigrationFeeButton"),
      withdrawLeftoverButton: document.getElementById("withdrawLeftoverButton"),
      metrics: document.getElementById("metrics"),
      curveSvg: document.getElementById("curveSvg"),
      saleDetails: document.getElementById("saleDetails"),
      addressDetails: document.getElementById("addressDetails"),
      migrationDetails: document.getElementById("migrationDetails"),
      feeBalanceDetails: document.getElementById("feeBalanceDetails"),
      feeEstimateDetails: document.getElementById("feeEstimateDetails"),
      migrationResultDetails: document.getElementById("migrationResultDetails"),
      destinationDetails: document.getElementById("destinationDetails"),
      activityLog: document.getElementById("activityLog"),
    };

    init();

    function init() {
      el.rpcLabel.textContent = RPC_URL;
      el.quoteMintInput.value = localStorage.getItem("dbc.ui.quoteMint") || DEFAULT_QUOTE_MINT;
      el.migrationQuoteAmountCapInput.value = localStorage.getItem("dbc.ui.migrationQuoteAmountCap") || "0";
      el.migrationFeeInput.value = localStorage.getItem("dbc.ui.migrationFeePercentage") || "0";
      el.creatorMigrationFeeInput.value = localStorage.getItem("dbc.ui.creatorMigrationFeePercentage") || "0";
      el.configInput.value = localStorage.getItem("dbc.ui.config") || "";
      el.deadlineInput.value = localStorage.getItem("dbc.ui.deadlineTimestamp") || "0";
      el.poolInput.value = new URLSearchParams(location.search).get("pool") || localStorage.getItem("dbc.ui.pool") || "";
      el.buyModeInput.value = localStorage.getItem("dbc.ui.buyMode") || "base";
      el.buyAmountInput.value = localStorage.getItem("dbc.ui.buyAmount") || "";
      el.minBaseInput.value = localStorage.getItem("dbc.ui.minBaseOut") || "";
      el.dammConfigInput.value = localStorage.getItem("dbc.ui.dammConfig") || "";

      el.watchButton.addEventListener("click", () => {
        setPool(el.poolInput.value.trim());
        refreshNow();
      });
      el.poolInput.addEventListener("change", () => setPool(el.poolInput.value.trim()));
      el.quoteMintInput.addEventListener("change", () => localStorage.setItem("dbc.ui.quoteMint", el.quoteMintInput.value.trim()));
      el.migrationQuoteAmountCapInput.addEventListener("change", () => localStorage.setItem("dbc.ui.migrationQuoteAmountCap", el.migrationQuoteAmountCapInput.value.trim()));
      el.migrationFeeInput.addEventListener("change", () => localStorage.setItem("dbc.ui.migrationFeePercentage", el.migrationFeeInput.value.trim()));
      el.creatorMigrationFeeInput.addEventListener("change", () => localStorage.setItem("dbc.ui.creatorMigrationFeePercentage", el.creatorMigrationFeeInput.value.trim()));
      el.configInput.addEventListener("change", () => localStorage.setItem("dbc.ui.config", el.configInput.value.trim()));
      el.deadlineInput.addEventListener("change", () => localStorage.setItem("dbc.ui.deadlineTimestamp", el.deadlineInput.value.trim()));
      el.buyModeInput.addEventListener("change", () => {
        localStorage.setItem("dbc.ui.buyMode", el.buyModeInput.value);
        syncBuyMode();
      });
      el.buyAmountInput.addEventListener("change", () => localStorage.setItem("dbc.ui.buyAmount", el.buyAmountInput.value.trim()));
      el.minBaseInput.addEventListener("change", () => localStorage.setItem("dbc.ui.minBaseOut", el.minBaseInput.value.trim()));
      el.dammConfigInput.addEventListener("change", () => {
        localStorage.setItem("dbc.ui.dammConfig", el.dammConfigInput.value.trim());
        refreshNow();
      });
      el.createConfigButton.addEventListener("click", createConfigAction);
      el.createPoolButton.addEventListener("click", createPoolAction);
      el.buyButton.addEventListener("click", buyAction);
      el.migrateButton.addEventListener("click", migrateAction);
      el.withdrawPartnerMigrationFeeButton.addEventListener("click", withdrawPartnerMigrationFeeAction);
      el.withdrawLeftoverButton.addEventListener("click", withdrawLeftoverAction);

      syncBuyMode();
      renderEmpty();
      refreshNow();
      setInterval(refreshNow, REFRESH_MS);
    }

    function setPool(pool) {
      const previousPool = localStorage.getItem("dbc.ui.pool") || "";
      if (pool !== previousPool) {
        state.lastMigrationResult = null;
      }
      localStorage.setItem("dbc.ui.pool", pool);
      const url = new URL(location.href);
      if (pool) {
        url.searchParams.set("pool", pool);
      } else {
        url.searchParams.delete("pool");
      }
      history.replaceState(null, "", url);
    }

    function syncBuyMode() {
      el.minBaseRow.style.display = el.buyModeInput.value === "quote" ? "block" : "none";
    }

    async function refreshNow() {
      if (state.refreshing) return;
      state.refreshing = true;
      try {
        state.health = await getJson("/api/health");
        renderHealth();
        const pool = el.poolInput.value.trim();
        if (state.health.ok && pool) {
          const dammConfig = el.dammConfigInput.value.trim();
          const path =
            "/api/pool-info?pool=" +
            encodeURIComponent(pool) +
            (dammConfig ? "&dammConfig=" + encodeURIComponent(dammConfig) : "");
          state.dashboard = await getJson(path);
          state.lastError = null;
          renderDashboard();
        } else if (!pool) {
          state.dashboard = null;
          renderEmpty();
        }
      } catch (error) {
        state.lastError = error.message || String(error);
        renderHealth();
      } finally {
        state.refreshing = false;
      }
    }

    async function createConfigAction() {
      await withButton(el.createConfigButton, async () => {
        const quoteMint = el.quoteMintInput.value.trim() || DEFAULT_QUOTE_MINT;
        const migrationQuoteAmountCap =
          el.migrationQuoteAmountCapInput.value.trim() || "0";
        const migrationFeePercentage = el.migrationFeeInput.value.trim() || "0";
        const creatorMigrationFeePercentage =
          el.creatorMigrationFeeInput.value.trim() || "0";
        localStorage.setItem("dbc.ui.migrationQuoteAmountCap", migrationQuoteAmountCap);
        localStorage.setItem("dbc.ui.migrationFeePercentage", migrationFeePercentage);
        localStorage.setItem("dbc.ui.creatorMigrationFeePercentage", creatorMigrationFeePercentage);
        const result = await postJson("/api/create-config", {
          quoteMint,
          migrationQuoteAmountCap,
          migrationFeePercentage,
          creatorMigrationFeePercentage,
        });
        el.configInput.value = result.config;
        localStorage.setItem("dbc.ui.config", result.config);
        log("config", result);
        await refreshNow();
      });
    }

    async function createPoolAction() {
      await withButton(el.createPoolButton, async () => {
        const config = el.configInput.value.trim();
        const deadlineTimestamp = el.deadlineInput.value.trim();
        const result = await postJson("/api/create-pool", {
          config,
          deadlineTimestamp,
        });
        el.poolInput.value = result.pool;
        setPool(result.pool);
        log("pool", result);
        await refreshNow();
      });
    }

    async function buyAction() {
      await withButton(el.buyButton, async () => {
        const pool = el.poolInput.value.trim();
        const amount = el.buyAmountInput.value.trim();
        const mode = el.buyModeInput.value;
        const minimumBaseAmountOut = el.minBaseInput.value.trim();
        const result = await postJson("/api/buy", {
          pool,
          amount,
          mode,
          minimumBaseAmountOut: mode === "quote" ? minimumBaseAmountOut : undefined,
        });
        log("buy", result);
        await refreshNow();
      });
    }

    async function migrateAction() {
      await withButton(el.migrateButton, async () => {
        const pool = el.poolInput.value.trim();
        const dammConfig = el.dammConfigInput.value.trim();
        if (!pool) {
          throw new Error("pool is required");
        }
        if (!dammConfig) {
          throw new Error("DAMM v2 config is required");
        }
        if (!confirm("Migrate this curve now? This sends a transaction using the local keypair.")) {
          return;
        }
        const result = await postJson("/api/migrate", { pool, dammConfig });
        state.lastMigrationResult = result;
        localStorage.setItem("dbc.ui.dammConfig", dammConfig);
        log("migrate", result);
        await refreshNow();
      });
    }

    async function withdrawPartnerMigrationFeeAction() {
      await withButton(el.withdrawPartnerMigrationFeeButton, async () => {
        const pool = el.poolInput.value.trim();
        if (!pool) {
          throw new Error("pool is required");
        }
        if (!confirm("Withdraw the partner migration quote fee now? This sends a transaction using the local keypair and only succeeds if it is the config fee claimer.")) {
          return;
        }
        const result = await postJson("/api/withdraw-partner-migration-fee", { pool });
        log("withdraw partner quote fee", result);
        await refreshNow();
      });
    }

    async function withdrawLeftoverAction() {
      await withButton(el.withdrawLeftoverButton, async () => {
        const pool = el.poolInput.value.trim();
        if (!pool) {
          throw new Error("pool is required");
        }
        if (!confirm("Withdraw leftover base to the configured leftover receiver now? This sends a transaction using the local keypair as fee payer.")) {
          return;
        }
        const result = await postJson("/api/withdraw-leftover", { pool });
        log("withdraw leftover base", result);
        await refreshNow();
      });
    }

    async function withButton(button, fn) {
      button.disabled = true;
      try {
        await fn();
      } catch (error) {
        log("error", error.message || String(error));
      } finally {
        button.disabled = false;
      }
    }

    async function getJson(path) {
      const response = await fetch(path, { cache: "no-store" });
      return parseResponse(response);
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseResponse(response);
    }

    async function parseResponse(response) {
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || payload.message || response.statusText);
      }
      return payload;
    }

    function renderHealth() {
      const health = state.health;
      el.status.className = "status";
      if (health && health.ok) {
        el.status.classList.add("good");
        el.status.textContent = "slot " + health.slot;
      } else {
        el.status.classList.add("bad");
        el.status.textContent = "surfpool not found";
      }
      if (state.lastError) {
        log("poll", state.lastError);
      }
    }

    function renderEmpty() {
      el.metrics.innerHTML = "";
      addMetric("Current price", "Waiting", "quote per base");
      addMetric("Tokens sold", "-", "base");
      addMetric("Migration", "-", "status");
      addMetric("Quote remaining", "-", "quote");
      el.saleDetails.innerHTML = '<div class="empty">No pool selected</div>';
      el.addressDetails.innerHTML = '<div class="empty">No pool selected</div>';
      el.migrationDetails.innerHTML = '<div class="empty">No pool selected</div>';
      el.feeBalanceDetails.innerHTML = '<div class="empty">No pool selected</div>';
      el.feeEstimateDetails.innerHTML = '<div class="empty">No pool selected</div>';
      el.migrationResultDetails.innerHTML = '<div class="empty">No migration run yet</div>';
      el.destinationDetails.innerHTML = '<div class="empty">No pool selected</div>';
      renderCurve(null);
    }

    function renderDashboard() {
      const dashboard = state.dashboard;
      if (!dashboard || !dashboard.info) {
        renderEmpty();
        return;
      }

      const info = dashboard.info;
      const balances = info.destinationBalances || {};
      const migrationResult = currentMigrationResult(info);
      el.metrics.innerHTML = "";
      addMetric("Current price", formatNumber(info.price.currentQuotePerBase), "quote per base");
      addMetric("Tokens sold", formatNumber(info.sale.tokensSoldUi), pct(info.sale.tokensSoldPercentOfPlannedSwap));
      addMetric("Migration", info.migration.migrationProgressLabel, pct(info.migration.saleCompletionPercent));
      addMetric("Quote remaining", formatNumber(info.migration.quoteRemainingUi), "to migration");

      renderKv(el.saleDetails, [
        ["Base reserve", info.sale.baseReserveUi],
        ["Quote reserve", info.sale.quoteReserveUi],
        ["Initial base supply", info.sale.initialBaseSupplyUi],
        ["Planned swap base", info.sale.plannedSwapBaseAmountUi],
        ["Sold of initial", pct(info.sale.tokensSoldPercentOfInitialSupply)],
        ["Sold of planned", pct(info.sale.tokensSoldPercentOfPlannedSwap)],
      ]);
      renderKv(el.addressDetails, Object.entries(info.addresses));
      renderKv(el.migrationDetails, [
        ["Progress", info.migration.migrationProgressLabel],
        ["Curve complete", String(info.migration.isCurveComplete)],
        ["Sale complete", String(info.migration.saleComplete)],
        ["Completion mode", info.migration.completionMode],
        ["Deadline reached", String(info.migration.deadlineReached)],
        ["Deadline timestamp", String(info.migration.deadlineTimestamp)],
        ["Has locked vesting", String(info.migration.hasLockedVesting)],
        ["Migrated", String(info.migration.isMigrated)],
        ["Quote threshold", info.migration.migrationQuoteThresholdUi],
        ["Migration quote cap", info.migration.migrationQuoteAmountCapUi],
        ["Fixed quote cap", String(info.migration.fixedMigrationQuoteAmountEnabled)],
        ["Base threshold", info.migration.migrationBaseThresholdUi],
        ["Creator fee pct", info.fees.creatorTradingFeePercentage],
        ["Migration fee pct", info.fees.migrationFeePercentage],
      ]);
      renderKv(el.feeBalanceDetails, [
        ["Total base fees", formatTokenAmount(info.fees.totalBaseFeeUi, "base")],
        ["Total quote fees", formatTokenAmount(info.fees.totalQuoteFeeUi, "quote")],
        ["Protocol base fees", formatTokenAmount(info.fees.protocolBaseFeeUi, "base")],
        ["Protocol quote fees", formatTokenAmount(info.fees.protocolQuoteFeeUi, "quote")],
        ["Partner base fees", formatTokenAmount(info.fees.partnerBaseFeeUi, "base")],
        ["Partner quote fees", formatTokenAmount(info.fees.partnerQuoteFeeUi, "quote")],
        ["Creator base fees", formatTokenAmount(info.fees.creatorBaseFeeUi, "base")],
        ["Creator quote fees", formatTokenAmount(info.fees.creatorQuoteFeeUi, "quote")],
        ["Protocol migration base", formatTokenAmount(info.fees.protocolMigrationBaseFeeUi, "base")],
        ["Protocol migration quote", formatTokenAmount(info.fees.protocolMigrationQuoteFeeUi, "quote")],
      ]);
      renderKv(el.feeEstimateDetails, [
        ["Basis amount", formatTokenAmount(info.fees.migrationFeeBasisUi, "quote")],
        ["Partner-only surplus", formatTokenAmount(info.fees.partnerOnlyQuoteSurplusUi, "quote")],
        ["Migration fee pct", pct(info.fees.migrationFeePercentage)],
        ["Creator split", pct(info.fees.creatorMigrationFeePercentage)],
        ["Partner split", pct(info.fees.partnerMigrationFeePercentage)],
        ["Estimated total fee", formatTokenAmount(info.fees.estimatedMigrationFeeTotalUi, "quote")],
        ["Estimated creator fee", formatTokenAmount(info.fees.estimatedCreatorMigrationFeeUi, "quote")],
        ["Estimated partner fee", formatTokenAmount(info.fees.estimatedPartnerMigrationFeeUi, "quote")],
        ["Creator fee withdrawn", String(info.fees.creatorMigrationFeeWithdrawn)],
        ["Partner fee withdrawn", String(info.fees.partnerMigrationFeeWithdrawn)],
        ["Protocol migration bps", info.fees.protocolLiquidityMigrationFeeBps],
      ]);
      renderMigrationResult(migrationResult);
      renderKv(el.destinationDetails, [
        ["Creator", info.addresses.creator],
        ["Creator base", formatBalance(balances.creator && balances.creator.base, "base")],
        ["Creator quote", formatBalance(balances.creator && balances.creator.quote, "quote")],
        ["Partner fee claimer", info.addresses.feeClaimer],
        ["Partner base", formatBalance(balances.feeClaimer && balances.feeClaimer.base, "base")],
        ["Partner quote", formatBalance(balances.feeClaimer && balances.feeClaimer.quote, "quote")],
        ["Leftover receiver", info.addresses.leftoverReceiver],
        ["Leftover base", formatBalance(balances.leftoverReceiver && balances.leftoverReceiver.base, "base")],
        ["Leftover quote", formatBalance(balances.leftoverReceiver && balances.leftoverReceiver.quote, "quote")],
        ["Base vault", info.addresses.baseVault],
        ["Base vault balance", formatBalance(balances.dbcBaseVault, "base")],
        ["Quote vault", info.addresses.quoteVault],
        ["Quote vault balance", formatBalance(balances.dbcQuoteVault, "quote")],
        ["DAMM v2 config", el.dammConfigInput.value.trim()],
        ["DAMM pool", info.addresses.dammPool || (migrationResult && migrationResult.dammPool)],
        ["DAMM base vault", info.addresses.dammBaseVault],
        ["DAMM base balance", formatBalance(balances.dammBaseVault, "base")],
        ["DAMM quote vault", info.addresses.dammQuoteVault],
        ["DAMM quote balance", formatBalance(balances.dammQuoteVault, "quote")],
        ["First position", migrationResult && migrationResult.firstPosition],
        ["Second position", migrationResult && migrationResult.secondPosition],
      ]);
      renderCurve(dashboard);
    }

    function currentMigrationResult(info) {
      const result = state.lastMigrationResult;
      if (!result || result.pool !== info.addresses.pool) {
        return null;
      }
      return result;
    }

    function renderMigrationResult(result) {
      if (!result) {
        el.migrationResultDetails.innerHTML = '<div class="empty">No migration run yet</div>';
        return;
      }

      renderKv(el.migrationResultDetails, [
        ["Action", result.action],
        ["Pool", result.pool],
        ["Config", result.config],
        ["DAMM config", result.dammConfig],
        ["DAMM pool", result.dammPool],
        ["First position", result.firstPosition],
        ["Second position", result.secondPosition],
        ["Signature", result.signature],
      ]);
    }

    function addMetric(label, value, sub) {
      const item = document.createElement("div");
      item.className = "metric";
      item.innerHTML =
        '<div class="label"></div><div class="value"></div><div class="sub"></div>';
      item.children[0].textContent = label;
      item.children[1].textContent = value == null || value === "" ? "-" : String(value);
      item.children[2].textContent = sub == null || sub === "" ? "" : String(sub);
      el.metrics.appendChild(item);
    }

    function renderKv(node, rows) {
      node.innerHTML = "";
      rows.forEach(([key, value]) => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = labelize(key);
        dd.textContent = value == null || value === "" ? "-" : String(value);
        node.append(dt, dd);
      });
    }

    function renderCurve(dashboard) {
      const svg = el.curveSvg;
      svg.innerHTML = "";
      const width = 760;
      const height = 220;
      const pad = { left: 42, right: 28, top: 22, bottom: 32 };
      const x0 = pad.left;
      const y0 = height - pad.bottom;
      const x1 = width - pad.right;
      const y1 = pad.top;
      line(svg, x0, y0, x1, y0, "#c7d0cc", 1);
      line(svg, x0, y0, x0, y1, "#c7d0cc", 1);

      if (!dashboard || !dashboard.info || !dashboard.curve) {
        text(svg, width / 2, height / 2, "No pool selected", "#60706a", "middle");
        return;
      }

      const info = dashboard.info;
      const curve = dashboard.curve;
      const start = toPositiveNumber(curve.startPrice);
      const current = toPositiveNumber(curve.currentPrice);
      const migration = toPositiveNumber(curve.migrationPrice);
      const values = [start, current, migration].filter((v) => Number.isFinite(v) && v > 0);
      const minPrice = Math.min(...values);
      const maxPrice = Math.max(...values);
      const priceToY = (price) => {
        if (!Number.isFinite(price) || price <= 0) return y0;
        if (maxPrice === minPrice) return (y0 + y1) / 2;
        const low = Math.log(minPrice);
        const high = Math.log(maxPrice);
        const pct = (Math.log(price) - low) / (high - low);
        return y0 - pct * (y0 - y1);
      };
      const progress = clamp(Number(info.migration.saleCompletionPercent || 0) / 100, 0, 1);
      const cx = x0 + progress * (x1 - x0);
      const sy = priceToY(start);
      const my = priceToY(migration);
      const cy = priceToY(current);
      const midX = x0 + (x1 - x0) * 0.55;
      const midY = priceToY(Math.sqrt(start * migration || 1));

      path(svg, "M " + x0 + " " + sy + " Q " + midX + " " + midY + " " + x1 + " " + my, "#157f62", 3);
      line(svg, x1, y1, x1, y0, "#3a5f91", 1.5, "4 4");
      circle(svg, cx, cy, 6, "#8b3d73");
      circle(svg, x0, sy, 4, "#157f62");
      circle(svg, x1, my, 4, "#3a5f91");
      text(svg, x0, y0 + 22, "start " + formatNumber(start), "#60706a", "start");
      text(svg, x1, y0 + 22, "migration " + formatNumber(migration), "#60706a", "end");
      text(svg, cx, Math.max(y1 + 12, cy - 12), "current " + formatNumber(current), "#17201d", "middle");
    }

    function line(svg, xA, yA, xB, yB, stroke, width, dash) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", "line");
      node.setAttribute("x1", xA);
      node.setAttribute("y1", yA);
      node.setAttribute("x2", xB);
      node.setAttribute("y2", yB);
      node.setAttribute("stroke", stroke);
      node.setAttribute("stroke-width", width);
      if (dash) node.setAttribute("stroke-dasharray", dash);
      svg.appendChild(node);
    }

    function path(svg, d, stroke, width) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
      node.setAttribute("d", d);
      node.setAttribute("fill", "none");
      node.setAttribute("stroke", stroke);
      node.setAttribute("stroke-width", width);
      node.setAttribute("stroke-linecap", "round");
      svg.appendChild(node);
    }

    function circle(svg, x, y, r, fill) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      node.setAttribute("cx", x);
      node.setAttribute("cy", y);
      node.setAttribute("r", r);
      node.setAttribute("fill", fill);
      svg.appendChild(node);
    }

    function text(svg, x, y, value, fill, anchor) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
      node.setAttribute("x", x);
      node.setAttribute("y", y);
      node.setAttribute("fill", fill);
      node.setAttribute("font-size", "12");
      node.setAttribute("text-anchor", anchor);
      node.textContent = value;
      svg.appendChild(node);
    }

    function log(label, value) {
      const stamp = new Date().toLocaleTimeString();
      const line = "[" + stamp + "] " + label + " " + (typeof value === "string" ? value : JSON.stringify(value, null, 2));
      el.activityLog.textContent = line + "\\n" + el.activityLog.textContent;
    }

    function labelize(value) {
      return String(value)
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (char) => char.toUpperCase());
    }

    function pct(value) {
      if (value == null || value === "") return "-";
      return formatNumber(value) + "%";
    }

    function formatTokenAmount(value, symbol) {
      if (value == null || value === "") return "-";
      return formatNumber(value) + " " + symbol;
    }

    function formatBalance(balance, symbol) {
      if (!balance) return "-";
      return formatTokenAmount(balance.ui, symbol);
    }

    function formatNumber(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return value == null ? "-" : String(value);
      if (Math.abs(number) >= 1_000_000) {
        return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
      }
      if (Math.abs(number) >= 1) {
        return number.toLocaleString(undefined, { maximumFractionDigits: 6 });
      }
      return number.toLocaleString(undefined, { maximumSignificantDigits: 6 });
    }

    function toPositiveNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : 0;
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }
  </script>
</body>
</html>`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
