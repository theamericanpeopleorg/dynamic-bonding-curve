import { PublicKey } from "@solana/web3.js";
import {
  DBC_PROGRAM_ID,
  DEFAULT_KEYPAIR_PATH,
  DEFAULT_RPC_URL,
  MAINNET_USDC_MINT,
  loadKeypair,
} from "./shared";
import {
  buy,
  createConfig,
  createPool,
  poolInfo,
  withdrawLeftover,
  withdrawPartnerMigrationFee,
} from "./commands";

export function usage() {
  console.log(`Usage:
  bun scripts/dbc_tool/dbc_tool.ts create-config [--rpc-url <URL>] [--quote-mint <MINT>] [--migration-fee-pct <0-100>] [--creator-migration-fee-pct <0-100>]
  bun scripts/dbc_tool/dbc_tool.ts create-pool <CONFIG_PUBKEY> [--rpc-url <URL>] [--base-mint-keypair <PATH>] [--deadline-timestamp <UNIX_SECONDS>]
  bun scripts/dbc_tool/dbc_tool.ts pool-info <POOL_PUBKEY> [--rpc-url <URL>]
  bun scripts/dbc_tool/dbc_tool.ts buy <POOL_PUBKEY> <BASE_AMOUNT> [--rpc-url <URL>] [--raw]
  bun scripts/dbc_tool/dbc_tool.ts buy <POOL_PUBKEY> <QUOTE_AMOUNT> --partial [--min-base-out <BASE_AMOUNT>] [--rpc-url <URL>] [--raw]
  bun scripts/dbc_tool/dbc_tool.ts withdraw-leftover <POOL_PUBKEY> [--rpc-url <URL>]
  bun scripts/dbc_tool/dbc_tool.ts withdraw-partner-migration-fee <POOL_PUBKEY> [--rpc-url <URL>] [--migration-fee-receiver <OWNER>]

Environment:
  RPC_URL            Optional default RPC URL
  KEYPAIR_PATH       Defaults to ${DEFAULT_KEYPAIR_PATH}

Defaults:
  Program ID: ${DBC_PROGRAM_ID.toBase58()}
  RPC URL:    ${DEFAULT_RPC_URL}
  Quote mint: ${MAINNET_USDC_MINT.toBase58()} (mainnet USDC)
`);
}

export async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  const command = args.command;

  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "create-config") {
    const result = await createConfig({
      rpcUrl: args.rpcUrl,
      quoteMint: args.quoteMint ? new PublicKey(args.quoteMint) : undefined,
      migrationQuoteAmountCap: args.migrationQuoteAmountCap,
      migrationFeePercentage: args.migrationFeePercentage,
      creatorMigrationFeePercentage: args.creatorMigrationFeePercentage,
    });
    console.log(JSON.stringify(publicKeyResultToBase58(result), null, 2));
    return;
  }

  if (command === "create-pool") {
    const config = args.positionals[0];
    if (!config) {
      throw new Error("create-pool requires a config public key argument");
    }

    const result = await createPool(config, {
      rpcUrl: args.rpcUrl,
      baseMint: args.baseMintKeypairPath
        ? loadKeypair(args.baseMintKeypairPath)
        : undefined,
      deadlineTimestamp: args.deadlineTimestamp,
    });
    console.log(JSON.stringify(publicKeyResultToBase58(result), null, 2));
    return;
  }

  if (command === "pool-info") {
    const pool = args.positionals[0];
    if (!pool) {
      throw new Error("pool-info requires a pool public key argument");
    }

    const result = await poolInfo(pool, { rpcUrl: args.rpcUrl });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "buy") {
    const pool = args.positionals[0];
    const amount = args.positionals[1];
    if (!pool || !amount) {
      throw new Error(
        args.partialFill
          ? "partial buy requires a pool public key and quote amount"
          : "buy requires a pool public key and base amount"
      );
    }

    const result = await buy(pool, amount, {
      rpcUrl: args.rpcUrl,
      rawAmounts: args.rawAmounts,
      partialFill: args.partialFill,
      minimumBaseAmountOut: args.minimumBaseAmountOut,
    });
    console.log(JSON.stringify(publicKeyResultToBase58(result), null, 2));
    return;
  }

  if (command === "withdraw-partner-migration-fee") {
    const pool = args.positionals[0];
    if (!pool) {
      throw new Error(
        "withdraw-partner-migration-fee requires a pool public key argument"
      );
    }

    const result = await withdrawPartnerMigrationFee(pool, {
      rpcUrl: args.rpcUrl,
      migrationFeeReceiver: args.migrationFeeReceiver
        ? new PublicKey(args.migrationFeeReceiver)
        : undefined,
    });
    console.log(JSON.stringify(publicKeyResultToBase58(result), null, 2));
    return;
  }

  if (command === "withdraw-leftover") {
    const pool = args.positionals[0];
    if (!pool) {
      throw new Error("withdraw-leftover requires a pool public key argument");
    }

    const result = await withdrawLeftover(pool, {
      rpcUrl: args.rpcUrl,
    });
    console.log(JSON.stringify(publicKeyResultToBase58(result), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

export function parseCliArgs(argv: string[]) {
  const positionals: string[] = [];
  let command: string | undefined;
  let rpcUrl: string | undefined;
  let quoteMint: string | undefined;
  let migrationQuoteAmountCap: string | undefined;
  let migrationFeePercentage: number | undefined;
  let migrationFeeReceiver: string | undefined;
  let creatorMigrationFeePercentage: number | undefined;
  let baseMintKeypairPath: string | undefined;
  let deadlineTimestamp: string | undefined;
  let minimumBaseAmountOut: string | undefined;
  let partialFill = false;
  let rawAmounts = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--rpc-url") {
      rpcUrl = argv[++i];
      if (!rpcUrl) {
        throw new Error("--rpc-url requires a URL value");
      }
      continue;
    }

    if (arg.startsWith("--rpc-url=")) {
      rpcUrl = arg.slice("--rpc-url=".length);
      continue;
    }

    if (arg === "--quote-mint") {
      quoteMint = argv[++i];
      if (!quoteMint) {
        throw new Error("--quote-mint requires a mint public key");
      }
      continue;
    }

    if (arg.startsWith("--quote-mint=")) {
      quoteMint = arg.slice("--quote-mint=".length);
      continue;
    }

    if (arg === "--migration-quote-amount-cap") {
      migrationQuoteAmountCap = argv[++i];
      if (!migrationQuoteAmountCap) {
        throw new Error(
          "--migration-quote-amount-cap requires a raw quote amount"
        );
      }
      continue;
    }

    if (arg.startsWith("--migration-quote-amount-cap=")) {
      migrationQuoteAmountCap = arg.slice(
        "--migration-quote-amount-cap=".length
      );
      continue;
    }

    if (arg === "--migration-fee-pct") {
      migrationFeePercentage = parsePercentage(
        argv[++i],
        "--migration-fee-pct"
      );
      continue;
    }

    if (arg.startsWith("--migration-fee-pct=")) {
      migrationFeePercentage = parsePercentage(
        arg.slice("--migration-fee-pct=".length),
        "--migration-fee-pct"
      );
      continue;
    }

    if (arg === "--creator-migration-fee-pct") {
      creatorMigrationFeePercentage = parsePercentage(
        argv[++i],
        "--creator-migration-fee-pct"
      );
      continue;
    }

    if (arg.startsWith("--creator-migration-fee-pct=")) {
      creatorMigrationFeePercentage = parsePercentage(
        arg.slice("--creator-migration-fee-pct=".length),
        "--creator-migration-fee-pct"
      );
      continue;
    }

    if (arg === "--migration-fee-receiver") {
      migrationFeeReceiver = argv[++i];
      if (!migrationFeeReceiver) {
        throw new Error(
          "--migration-fee-receiver requires an owner public key"
        );
      }
      continue;
    }

    if (arg.startsWith("--migration-fee-receiver=")) {
      migrationFeeReceiver = arg.slice("--migration-fee-receiver=".length);
      continue;
    }

    if (arg === "--base-mint-keypair") {
      baseMintKeypairPath = argv[++i];
      if (!baseMintKeypairPath) {
        throw new Error("--base-mint-keypair requires a keypair file path");
      }
      continue;
    }

    if (arg.startsWith("--base-mint-keypair=")) {
      baseMintKeypairPath = arg.slice("--base-mint-keypair=".length);
      continue;
    }

    if (arg === "--deadline-timestamp") {
      deadlineTimestamp = argv[++i];
      if (!deadlineTimestamp) {
        throw new Error("--deadline-timestamp requires a unix timestamp");
      }
      continue;
    }

    if (arg.startsWith("--deadline-timestamp=")) {
      deadlineTimestamp = arg.slice("--deadline-timestamp=".length);
      continue;
    }

    if (arg === "--partial" || arg === "--partial-fill") {
      partialFill = true;
      continue;
    }

    if (arg === "--min-base-out") {
      minimumBaseAmountOut = argv[++i];
      if (!minimumBaseAmountOut) {
        throw new Error("--min-base-out requires a base amount");
      }
      continue;
    }

    if (arg.startsWith("--min-base-out=")) {
      minimumBaseAmountOut = arg.slice("--min-base-out=".length);
      continue;
    }

    if (arg === "--raw" || arg === "--base-raw") {
      rawAmounts = true;
      continue;
    }

    if (!command) {
      command = arg;
      continue;
    }

    positionals.push(arg);
  }

  return {
    baseMintKeypairPath,
    command,
    creatorMigrationFeePercentage,
    deadlineTimestamp,
    migrationQuoteAmountCap,
    migrationFeeReceiver,
    migrationFeePercentage,
    minimumBaseAmountOut,
    partialFill,
    positionals,
    quoteMint,
    rawAmounts,
    rpcUrl,
  };
}

function parsePercentage(value: string | undefined, name: string): number {
  if (value == null || value.trim() === "") {
    throw new Error(`${name} requires a percentage value`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${name} must be an integer from 0 to 100`);
  }

  return parsed;
}

export function publicKeyResultToBase58<T extends Record<string, unknown>>(
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
