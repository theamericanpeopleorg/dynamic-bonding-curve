/// <reference types="node" />

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "child_process";
import { once } from "events";
import { Connection, PublicKey } from "@solana/web3.js";
import { buy, createConfig, createPool } from "./dbc_tool/commands";
import {
  DBC_PROGRAM_ID,
  DAMM_V2_CONFIG,
  DEFAULT_RPC_URL,
  deriveDbcPoolAuthority,
  unwrapVirtualPoolAccount,
} from "./dbc_tool/shared";
import { runKeeper } from "./migration_keeper/keeper";
import {
  MigrationProgress,
  buildClient as buildKeeperClient,
  migrationProgressLabel,
} from "./migration_keeper/shared";

const DEFAULT_MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
const DAMM_V2_PROGRAM_ID = new PublicKey(
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
);
const DAMM_CONFIG_POOL_CREATOR_AUTHORITY_OFFSET = 40;
const DAMM_CONFIG_POOL_CREATOR_AUTHORITY_LENGTH = 32;

type Options = {
  rpcUrl: string;
  mainnetRpcUrl: string;
  useExistingSurfpool: boolean;
  keepSurfpool: boolean;
  skipDeployment: boolean;
  waitTimeoutMs: number;
};

type SurfpoolProcess = {
  process: ChildProcessWithoutNullStreams;
  logs: string[];
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let surfpool: SurfpoolProcess | undefined;

  try {
    if (!options.useExistingSurfpool) {
      surfpool = startSurfpool(options.mainnetRpcUrl);
    }

    await waitForRpc(options.rpcUrl, options.waitTimeoutMs);

    if (!options.skipDeployment) {
      runSurfpoolDeployment();
    }

    await assertDefaultDammV2ConfigCompatible(options.rpcUrl);

    logStep("create_config");
    const configResult = await createConfig({
      rpcUrl: options.rpcUrl,
      migratedPoolFeeBps: 100,
    });
    logResult("config_created", publicKeyResultToBase58(configResult));

    logStep("create_pool");
    const poolResult = await createPool(configResult.config, {
      rpcUrl: options.rpcUrl,
    });
    logResult("pool_created", publicKeyResultToBase58(poolResult));

    logStep("buy_curve");
    const buyResult = await buy(poolResult.pool, "100000000", {
      rpcUrl: options.rpcUrl,
      partialFill: true,
      minimumBaseAmountOut: "179999999",
    });
    logResult("curve_bought", publicKeyResultToBase58(buyResult));

    logStep("migrate");
    const keeperResult = await runKeeper({
      pool: poolResult.pool,
      dammConfig: DAMM_V2_CONFIG,
      dbcProgramId: DBC_PROGRAM_ID,
      rpcUrl: options.rpcUrl,
    });
    logResult("keeper_done", publicKeyResultToBase58(keeperResult));

    const finalState = await fetchPoolState(options.rpcUrl, poolResult.pool);
    if (finalState.migrationProgress !== MigrationProgress.CreatedPool) {
      throw new Error(
        `migration did not complete: expected ${MigrationProgress.CreatedPool}, got ${finalState.migrationProgress}`
      );
    }

    logResult("migration_completed", {
      ...finalState,
      migrationProgressLabel: migrationProgressLabel(
        finalState.migrationProgress
      ),
    });
  } finally {
    if (surfpool && !options.keepSurfpool) {
      await stopSurfpool(surfpool);
    }
  }
}

function usage() {
  console.log(`Usage:
  bun scripts/test_fixed_bps100_migration.ts [options]

Options:
  --rpc-url <URL>              Surfpool RPC URL. Default: ${DEFAULT_RPC_URL}
  --mainnet-rpc-url <URL>      Upstream RPC for a fresh Surfpool fork. Default: ${DEFAULT_MAINNET_RPC_URL}
  --use-existing-surfpool      Do not start or stop Surfpool; use --rpc-url as-is
  --skip-deployment            Do not run the localnet deployment runbook
  --keep-surfpool              Leave the spawned Surfpool process running
  --wait-timeout-ms <MS>       RPC readiness timeout. Default: 60000
  -h, --help                   Show this help
`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    rpcUrl: process.env.RPC_URL ?? DEFAULT_RPC_URL,
    mainnetRpcUrl: process.env.MAINNET_RPC_URL ?? DEFAULT_MAINNET_RPC_URL,
    useExistingSurfpool: false,
    keepSurfpool: false,
    skipDeployment: false,
    waitTimeoutMs: 60_000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--rpc-url") {
      options.rpcUrl = readValue(argv, ++i, "--rpc-url requires a URL");
      continue;
    }
    if (arg.startsWith("--rpc-url=")) {
      options.rpcUrl = arg.slice("--rpc-url=".length);
      continue;
    }
    if (arg === "--mainnet-rpc-url") {
      options.mainnetRpcUrl = readValue(
        argv,
        ++i,
        "--mainnet-rpc-url requires a URL"
      );
      continue;
    }
    if (arg.startsWith("--mainnet-rpc-url=")) {
      options.mainnetRpcUrl = arg.slice("--mainnet-rpc-url=".length);
      continue;
    }
    if (arg === "--use-existing-surfpool") {
      options.useExistingSurfpool = true;
      continue;
    }
    if (arg === "--skip-deployment") {
      options.skipDeployment = true;
      continue;
    }
    if (arg === "--keep-surfpool") {
      options.keepSurfpool = true;
      continue;
    }
    if (arg === "--wait-timeout-ms") {
      options.waitTimeoutMs = Number(
        readValue(argv, ++i, "--wait-timeout-ms requires a number")
      );
      if (
        !Number.isFinite(options.waitTimeoutMs) ||
        options.waitTimeoutMs <= 0
      ) {
        throw new Error("--wait-timeout-ms must be a positive number");
      }
      continue;
    }
    if (arg.startsWith("--wait-timeout-ms=")) {
      options.waitTimeoutMs = Number(arg.slice("--wait-timeout-ms=".length));
      if (
        !Number.isFinite(options.waitTimeoutMs) ||
        options.waitTimeoutMs <= 0
      ) {
        throw new Error("--wait-timeout-ms must be a positive number");
      }
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return options;
}

function startSurfpool(mainnetRpcUrl: string): SurfpoolProcess {
  logStep("start_surfpool");
  const child = spawn(
    "surfpool",
    ["start", "--rpc-url", mainnetRpcUrl, "--no-tui", "--no-studio", "--ci"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_DNA: "1",
      },
    }
  );
  const surfpool = {
    process: child,
    logs: [] as string[],
  };

  child.stdout.on("data", (chunk) => collectLog(surfpool, chunk));
  child.stderr.on("data", (chunk) => collectLog(surfpool, chunk));
  child.once("exit", (code, signal) => {
    if (code !== 0 && signal == null) {
      console.error(
        [
          `surfpool exited before the test completed with code ${code}`,
          ...surfpool.logs.slice(-20),
        ].join("\n")
      );
    }
  });

  return surfpool;
}

async function stopSurfpool(surfpool: SurfpoolProcess) {
  if (surfpool.process.exitCode !== null) {
    return;
  }

  logStep("stop_surfpool");
  surfpool.process.kill("SIGINT");
  await Promise.race([
    once(surfpool.process, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)).then(() => {
      if (surfpool.process.exitCode === null) {
        surfpool.process.kill("SIGKILL");
      }
    }),
  ]);
}

function runSurfpoolDeployment() {
  logStep("run_deployment");
  const result = spawnSync(
    "surfpool",
    ["run", "deployment", "--env", "localnet", "--explain", "--unsupervised"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_DNA: "1",
      },
      encoding: "utf8",
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `surfpool deployment failed with status ${result.status}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

async function waitForRpc(rpcUrl: string, timeoutMs: number) {
  logStep("wait_for_rpc");
  const connection = new Connection(rpcUrl, "confirmed");
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      const slot = await connection.getSlot("confirmed");
      logResult("rpc_ready", { rpcUrl, slot });
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw new Error(
    `RPC did not become ready within ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function assertDefaultDammV2ConfigCompatible(rpcUrl: string) {
  logStep("verify_default_damm_v2_config");
  const connection = new Connection(rpcUrl, "confirmed");
  const account = await connection.getAccountInfo(DAMM_V2_CONFIG);
  if (!account) {
    throw new Error(
      `DAMM v2 config account not found: ${DAMM_V2_CONFIG.toBase58()}`
    );
  }
  if (!account.owner.equals(DAMM_V2_PROGRAM_ID)) {
    throw new Error(
      `DAMM v2 config owner mismatch: expected ${DAMM_V2_PROGRAM_ID.toBase58()}, got ${account.owner.toBase58()}`
    );
  }

  const expectedPoolCreatorAuthority = deriveDbcPoolAuthority(DBC_PROGRAM_ID);
  const actualPoolCreatorAuthority = new PublicKey(
    account.data.subarray(
      DAMM_CONFIG_POOL_CREATOR_AUTHORITY_OFFSET,
      DAMM_CONFIG_POOL_CREATOR_AUTHORITY_OFFSET +
        DAMM_CONFIG_POOL_CREATOR_AUTHORITY_LENGTH
    )
  );
  if (!actualPoolCreatorAuthority.equals(expectedPoolCreatorAuthority)) {
    throw new Error(
      `DAMM v2 config pool_creator_authority mismatch: expected ${expectedPoolCreatorAuthority.toBase58()}, got ${actualPoolCreatorAuthority.toBase58()}`
    );
  }

  logResult("default_damm_v2_config_verified", {
    dammConfig: DAMM_V2_CONFIG.toBase58(),
    owner: account.owner.toBase58(),
    lamports: account.lamports,
    dataLength: account.data.length,
    poolCreatorAuthority: actualPoolCreatorAuthority.toBase58(),
  });
}

async function fetchPoolState(rpcUrl: string, pool: PublicKey) {
  const { program } = buildKeeperClient(rpcUrl, DBC_PROGRAM_ID);
  const state = unwrapVirtualPoolAccount(
    await (program.account as any).virtualPool.fetch(pool)
  );
  return {
    pool: pool.toBase58(),
    config: new PublicKey(state.config).toBase58(),
    baseMint: new PublicKey(state.baseMint).toBase58(),
    migrationProgress: Number(state.migrationProgress),
  };
}

function collectLog(surfpool: SurfpoolProcess, chunk: Buffer) {
  const text = chunk.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) {
      surfpool.logs.push(line);
    }
  }
  if (surfpool.logs.length > 200) {
    surfpool.logs.splice(0, surfpool.logs.length - 200);
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

function logStep(step: string) {
  console.log(JSON.stringify({ event: "step", step }));
}

function logResult(event: string, result: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...result }, null, 2));
}

function readValue(argv: string[], index: number, message: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
