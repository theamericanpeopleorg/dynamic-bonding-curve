/// <reference types="node" />

import { readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { AnchorProvider, Program } from "@anchor-lang/core";
import DynamicBondingCurveIdl from "../../target/idl/dynamic_bonding_curve.json";
import {
  getTokenDecimals,
  TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  Signer,
  Transaction,
} from "@solana/web3.js";

export const DEFAULT_RPC_URL = "http://127.0.0.1:8899";
export const DEFAULT_COMMITMENT: Commitment = "confirmed";
export const DEFAULT_STATUS_INTERVAL_MS = 5_000;
export const DEFAULT_RPC_TIMEOUT_MS = 15_000;
export const DEFAULT_SEND_TIMEOUT_MS = 20_000;
export const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;
export const DEFAULT_RPC_RETRY_ATTEMPTS = 3;
export const DEFAULT_RPC_RETRY_DELAY_MS = 1_000;
export const DEFAULT_KEYPAIR_PATH = path.join(
  homedir(),
  ".config/solana/id.json"
);
export const DBC_PROGRAM_ID = new PublicKey(
  (DynamicBondingCurveIdl as any).address
);
export const DAMM_V2_CONFIG = new PublicKey(
  "4Z1M85nC1vmZzEsYx6seTo5EM2tfAg7b67J4nJKWtWuu"
);

export enum MigrationProgress {
  PreBondingCurve = 0,
  PostBondingCurve = 1,
  LockedVesting = 2,
  CreatedPool = 3,
}

export type KeeperOptions = {
  pool: PublicKey;
  dammConfig: PublicKey;
  rpcUrl?: string;
  dbcProgramId?: PublicKey;
  keypairPath?: string;
  statusIntervalMs?: number;
  withdrawLeftover?: boolean;
  surplusReceiver?: PublicKey;
};

export type RpcRetryInfo = {
  operation: string;
  attempt: number;
  maxAttempts: number;
  nextDelayMs: number;
  message: string;
};

export type RpcRetryLogger = (info: RpcRetryInfo) => void;

export type KeeperResult = {
  action: "migrated" | "already_migrated" | "externally_migrated";
  pool: PublicKey;
  config?: PublicKey;
  dammConfig: PublicKey;
  dammPool?: PublicKey;
  firstPosition?: PublicKey;
  secondPosition?: PublicKey;
  signature?: string;
  leftoverWithdrawStatus?:
    | "withdrawn"
    | "already_withdrawn"
    | "skipped_non_fixed_supply"
    | "failed";
  leftoverWithdrawSignature?: string;
  leftoverReceiver?: PublicKey;
  leftoverBaseAccount?: PublicKey;
  leftoverWithdrawError?: string;
  partnerSurplusWithdrawStatus?:
    | "withdrawn"
    | "already_withdrawn"
    | "skipped_not_fee_claimer"
    | "skipped_no_surplus"
    | "failed";
  partnerSurplusWithdrawSignature?: string;
  partnerFeeClaimer?: PublicKey;
  surplusReceiver?: PublicKey;
  partnerQuoteAccount?: PublicKey;
  partnerSurplusWithdrawError?: string;
};

export function getRpcUrl(rpcUrl?: string): string {
  return rpcUrl ?? process.env.RPC_URL ?? DEFAULT_RPC_URL;
}

export function getDbcProgramId(dbcProgramId?: PublicKey): PublicKey {
  return dbcProgramId ?? DBC_PROGRAM_ID;
}

export function loadKeypair(keypairPath = process.env.KEYPAIR_PATH): Keypair {
  const resolvedPath = keypairPath ?? DEFAULT_KEYPAIR_PATH;
  const bytes = JSON.parse(readFileSync(resolvedPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export function parsePublicKey(value: string, name: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a valid public key: ${value}`);
  }
}

export function buildClient(rpcUrl?: string, dbcProgramId?: PublicKey) {
  const resolvedRpcUrl = getRpcUrl(rpcUrl);
  const programId = getDbcProgramId(dbcProgramId);
  const connection = new Connection(resolvedRpcUrl, DEFAULT_COMMITMENT);
  const provider = new AnchorProvider(connection, null as any, {
    commitment: DEFAULT_COMMITMENT,
  });
  const idl = JSON.parse(JSON.stringify(DynamicBondingCurveIdl));
  idl.address = programId.toBase58();
  const program = new Program(idl, provider);

  return {
    connection,
    program,
    programId,
    rpcUrl: resolvedRpcUrl,
  };
}

export function deriveDbcPoolAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    programId
  )[0];
}

export function deriveDammV2MigrationMetadata(
  pool: PublicKey,
  dbcProgramId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("damm_v2"), pool.toBuffer()],
    dbcProgramId
  )[0];
}

export function getTokenProgramForFlag(tokenFlag: number): PublicKey {
  return tokenFlag === TokenType.Token2022
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}

export function unwrapVirtualPoolAccount<T = any>(account: T): any {
  return (account as any)?.poolState ?? account;
}

export async function getQuoteDecimals(
  connection: Connection,
  quoteMint: PublicKey
): Promise<number> {
  if (quoteMint.equals(NATIVE_MINT)) {
    return 9;
  }

  return getTokenDecimals(connection, quoteMint);
}

export function toBigInt(value: unknown): bigint {
  return BigInt(String(value));
}

export function rawAmountToUi(rawAmount: bigint, decimals: number): string {
  const zero = BigInt(0);
  const sign = rawAmount < zero ? "-" : "";
  const absolute = rawAmount < zero ? -rawAmount : rawAmount;
  const divisor = pow10(decimals);
  const whole = absolute / divisor;
  const fraction = absolute % divisor;

  if (fraction === zero) {
    return `${sign}${whole.toString()}`;
  }

  return `${sign}${whole.toString()}.${fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "")}`;
}

export function percent(numerator: bigint, denominator: bigint): string | null {
  if (denominator === BigInt(0)) {
    return null;
  }

  const percentScale = BigInt(100_000_000);
  const fractionScale = BigInt(1_000_000);
  const scaled = (numerator * percentScale) / denominator;
  const whole = scaled / fractionScale;
  const fraction = (scaled % fractionScale)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");

  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

function pow10(decimals: number): bigint {
  let value = BigInt(1);
  for (let i = 0; i < decimals; i++) {
    value *= BigInt(10);
  }

  return value;
}

export function migrationProgressLabel(value: number): string {
  return (
    [
      "pre_bonding_curve",
      "post_bonding_curve",
      "locked_vesting",
      "created_pool",
    ][value] ?? `unknown_${value}`
  );
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

export function logEvent(event: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
    })
  );
}

export async function retryRpc<T>(params: {
  operation: string;
  fn: () => Promise<T>;
  attempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  onRetry?: RpcRetryLogger;
}): Promise<T> {
  const attempts = params.attempts ?? DEFAULT_RPC_RETRY_ATTEMPTS;
  const timeoutMs = params.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const retryDelayMs = params.retryDelayMs ?? DEFAULT_RPC_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(
        Promise.resolve().then(params.fn),
        timeoutMs,
        params.operation
      );
    } catch (error) {
      if (!isRetryableRpcError(error) || attempt === attempts) {
        throw error;
      }

      params.onRetry?.({
        operation: params.operation,
        attempt,
        maxAttempts: attempts,
        nextDelayMs: retryDelayMs,
        message: errorMessage(error),
      });
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`${params.operation} failed without returning a result`);
}

export function isRetryableRpcError(error: unknown): boolean {
  if (error instanceof RpcTimeoutError) {
    return true;
  }

  const message = errorMessage(error);
  if (isLikelyOnChainError(message)) {
    return false;
  }

  return /fetch failed|failed to fetch|network|econnreset|etimedout|esockettimedout|econnrefused|eai_again|enotfound|socket hang up|timed out|timeout|too many requests|rate limit|429|500|502|503|504|gateway|headers timeout|body timeout|und_err|connection closed|blockhash not found|block height exceeded|not confirmed/i.test(
    message
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function signSendAndConfirm(
  connection: Connection,
  transaction: Transaction,
  signers: Signer[],
  onRetry?: RpcRetryLogger
): Promise<string> {
  const uniqueSigners = Array.from(
    new Map(
      signers.map((signer) => [signer.publicKey.toBase58(), signer])
    ).values()
  );
  const latestBlockhash = await retryRpc({
    operation: "getLatestBlockhash",
    fn: () => connection.getLatestBlockhash(DEFAULT_COMMITMENT),
    onRetry,
  });
  transaction.feePayer = uniqueSigners[0].publicKey;
  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.sign(...uniqueSigners);
  const rawTransaction = transaction.serialize();

  const signature = await retryRpc({
    operation: "sendRawTransaction",
    timeoutMs: DEFAULT_SEND_TIMEOUT_MS,
    fn: () =>
      connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        preflightCommitment: DEFAULT_COMMITMENT,
      }),
    onRetry,
  });

  try {
    const confirmation = await retryRpc({
      operation: "confirmTransaction",
      timeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
      fn: () =>
        connection.confirmTransaction(
          {
            signature,
            ...latestBlockhash,
          },
          DEFAULT_COMMITMENT
        ),
      onRetry,
    });
    if (confirmation.value.err) {
      throw new Error(
        `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
      );
    }
  } finally {
    closeRpcWebSocket(connection);
  }

  return signature;
}

export function closeRpcWebSocket(connection: Connection) {
  const rpcConnection = connection as any;
  if (rpcConnection._rpcWebSocketHeartbeat) {
    clearInterval(rpcConnection._rpcWebSocketHeartbeat);
    rpcConnection._rpcWebSocketHeartbeat = null;
  }
  if (rpcConnection._rpcWebSocketIdleTimeout) {
    clearTimeout(rpcConnection._rpcWebSocketIdleTimeout);
    rpcConnection._rpcWebSocketIdleTimeout = null;
  }
  rpcConnection._subscriptionsByHash = {};
  rpcConnection._subscriptionCallbacksByServerSubscriptionId = {};
  rpcConnection._rpcWebSocket?.close?.(1000);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new RpcTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RpcTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

function isLikelyOnChainError(message: string): boolean {
  return /custom program error|instructionerror|instruction error|transaction simulation failed|anchorerror|insufficient funds|signature verification failed|invalid account|owner does not match|account not found/i.test(
    message
  );
}

function isPublicKeyLike(value: unknown): value is { toBase58(): string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  );
}
