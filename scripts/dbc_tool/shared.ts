/// <reference types="node" />

import { readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { AnchorProvider, Program } from "@anchor-lang/core";
import DynamicBondingCurveIdl from "../../target/idl/dynamic_bonding_curve.json";
import {
  ActivationType,
  BaseFeeMode,
  buildCurve,
  CollectFeeMode,
  getBaseTokenForSwap,
  getDeltaAmountQuoteUnsigned,
  getInitialLiquidityFromDeltaBase,
  getSqrtPriceFromPrice,
  getSwapAmountWithBuffer,
  getTokenDecimals,
  METAPLEX_PROGRAM_ID,
  MigrationFeeOption,
  MigrationOption,
  Rounding,
  TokenDecimal,
  TokenType,
  TokenUpdateAuthorityOption,
  type ConfigParameters,
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
import BN from "bn.js";
import Decimal from "decimal.js";

export const DEFAULT_RPC_URL = "http://127.0.0.1:8899";
export const DEFAULT_COMMITMENT: Commitment = "confirmed";
export const DEFAULT_KEYPAIR_PATH = path.join(
  homedir(),
  ".config/solana/id.json"
);
export const MAINNET_USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
export const DEFAULT_TOTAL_TOKEN_SUPPLY = 1_000_000_000;
export const DEFAULT_CURVE_START_PRICE = "0.18";
export const DEFAULT_CURVE_MIGRATION_PRICE = "0.30";
export const DEFAULT_BASE_TOKENS_SOLD_BEFORE_MIGRATION = "180000000";
export const DBC_PROGRAM_ID = new PublicKey(
  (DynamicBondingCurveIdl as any).address
);

export type CreateConfigOptions = {
  rpcUrl?: string;
  payer?: Keypair;
  config?: Keypair;
  feeClaimer?: PublicKey;
  leftoverReceiver?: PublicKey;
  quoteMint?: PublicKey;
  migrationFeePercentage?: number;
  creatorMigrationFeePercentage?: number;
};

export type CreatePoolOptions = {
  rpcUrl?: string;
  payer?: Keypair;
  poolCreator?: Keypair;
  baseMint?: Keypair;
  name?: string;
  symbol?: string;
  uri?: string;
  deadlineTimestamp?: string | number | BN;
};

export type PoolInfoOptions = {
  rpcUrl?: string;
  dammConfig?: PublicKey | string;
};

export type BuyOptions = {
  rpcUrl?: string;
  payer?: Keypair;
  rawAmounts?: boolean;
  partialFill?: boolean;
  minimumBaseAmountOut?: string | number | BN;
  referralTokenAccount?: PublicKey | null;
};

export type WithdrawPartnerMigrationFeeOptions = {
  rpcUrl?: string;
  feeClaimer?: Keypair;
};

export type WithdrawLeftoverOptions = {
  rpcUrl?: string;
  payer?: Keypair;
};

type SendResult = {
  signature: string;
};

export type CreateConfigResult = SendResult & {
  config: PublicKey;
  quoteMint: PublicKey;
};

export type CreatePoolResult = SendResult & {
  pool: PublicKey;
  baseMint: PublicKey;
};

export type PoolInfoResult = Record<string, unknown>;

export type BuyResult = SendResult & {
  pool: PublicKey;
  baseAmount: string;
  quoteAmount: string;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
};

export type WithdrawPartnerMigrationFeeResult = SendResult & {
  pool: PublicKey;
  feeClaimer: PublicKey;
  tokenQuoteAccount: PublicKey;
};

export type WithdrawLeftoverResult = SendResult & {
  pool: PublicKey;
  leftoverReceiver: PublicKey;
  tokenBaseAccount: PublicKey;
};

export type CreateConfigOnLocalnetOptions = CreateConfigOptions;
export type CreatePoolOnLocalnetOptions = CreatePoolOptions;
export type CreateConfigOnLocalnetResult = CreateConfigResult;
export type CreatePoolOnLocalnetResult = CreatePoolResult;

export function getRpcUrl(rpcUrl?: string): string {
  return rpcUrl ?? process.env.RPC_URL ?? DEFAULT_RPC_URL;
}

export function loadKeypair(keypairPath = process.env.KEYPAIR_PATH): Keypair {
  const resolvedPath = keypairPath ?? DEFAULT_KEYPAIR_PATH;
  const bytes = JSON.parse(readFileSync(resolvedPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export function buildMschfCurveConfig(options: {
  migrationFeePercentage?: number;
  creatorMigrationFeePercentage?: number;
} = {}): ConfigParameters {
  const tokenBaseDecimal = TokenDecimal.SIX;
  const tokenQuoteDecimal = TokenDecimal.SIX;
  const soldBaseAmount = uiAmountToRaw(
    DEFAULT_BASE_TOKENS_SOLD_BEFORE_MIGRATION,
    tokenBaseDecimal
  );
  const totalSupply = uiAmountToRaw(
    DEFAULT_TOTAL_TOKEN_SUPPLY,
    tokenBaseDecimal
  );
  const sqrtStartPrice = getSqrtPriceFromPrice(
    DEFAULT_CURVE_START_PRICE,
    tokenBaseDecimal,
    tokenQuoteDecimal
  );
  const sqrtMigrationPrice = getSqrtPriceFromPrice(
    DEFAULT_CURVE_MIGRATION_PRICE,
    tokenBaseDecimal,
    tokenQuoteDecimal
  );
  const liquidity = getInitialLiquidityFromDeltaBase(
    soldBaseAmount,
    sqrtMigrationPrice,
    sqrtStartPrice
  );
  const curve = [{ sqrtPrice: sqrtMigrationPrice, liquidity }];
  const migrationQuoteThreshold = getDeltaAmountQuoteUnsigned(
    sqrtStartPrice,
    sqrtMigrationPrice,
    liquidity,
    Rounding.Up
  );
  const actualSoldBaseAmount = getBaseTokenForSwap(
    sqrtStartPrice,
    sqrtMigrationPrice,
    curve
  );

  if (!actualSoldBaseAmount.eq(soldBaseAmount)) {
    throw new Error(
      `curve sold base mismatch: expected ${soldBaseAmount.toString()}, got ${actualSoldBaseAmount.toString()}`
    );
  }

  const config = buildCurve({
    token: {
      tokenType: TokenType.SPL,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      tokenUpdateAuthority: TokenUpdateAuthorityOption.Immutable,
      totalTokenSupply: DEFAULT_TOTAL_TOKEN_SUPPLY,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: 0,
          endingFeeBps: 0,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: {
        feePercentage: options.migrationFeePercentage ?? 0,
        creatorFeePercentage: options.creatorMigrationFeePercentage ?? 0,
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 10,
    migrationQuoteThreshold: Number(
      rawAmountToUi(migrationQuoteThreshold, tokenQuoteDecimal)
    ),
  });

  return {
    ...config,
    migrationQuoteThreshold,
    sqrtStartPrice,
    tokenSupply: {
      preMigrationTokenSupply: totalSupply,
      postMigrationTokenSupply: totalSupply,
    },
    curve,
  };
}

export async function buildClient(rpcUrl?: string) {
  const resolvedRpcUrl = getRpcUrl(rpcUrl);

  const connection = new Connection(resolvedRpcUrl, DEFAULT_COMMITMENT);
  const provider = new AnchorProvider(connection, null as any, {
    commitment: DEFAULT_COMMITMENT,
  });
  const idl = JSON.parse(JSON.stringify(DynamicBondingCurveIdl));
  idl.address = DBC_PROGRAM_ID.toBase58();
  const program = new Program(idl, provider);

  return {
    connection,
    program,
    programId: DBC_PROGRAM_ID,
    rpcUrl: resolvedRpcUrl,
  };
}

export function deriveDbcPoolAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    programId
  )[0];
}

export function deriveDbcPoolAddressForProgram(
  quoteMint: PublicKey,
  baseMint: PublicKey,
  config: PublicKey,
  programId: PublicKey
): PublicKey {
  const [firstMint, secondMint] =
    quoteMint.toBuffer().compare(baseMint.toBuffer()) > 0
      ? [quoteMint, baseMint]
      : [baseMint, quoteMint];

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      config.toBuffer(),
      firstMint.toBuffer(),
      secondMint.toBuffer(),
    ],
    programId
  )[0];
}

export function deriveDbcTokenVaultAddress(
  mint: PublicKey,
  pool: PublicKey,
  programId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()],
    programId
  )[0];
}

export function deriveMintMetadata(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM_ID
  )[0];
}

export async function simulateAndSend(
  connection: Connection,
  transaction: Transaction,
  signers: Signer[]
): Promise<string> {
  const uniqueSigners = Array.from(
    new Map(
      signers.map((signer) => [signer.publicKey.toBase58(), signer])
    ).values()
  );
  const latestBlockhash = await connection.getLatestBlockhash(
    DEFAULT_COMMITMENT
  );
  transaction.feePayer = uniqueSigners[0].publicKey;
  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.sign(...uniqueSigners);

  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    throw new Error(
      [
        `Transaction simulation failed: ${JSON.stringify(
          simulation.value.err
        )}`,
        ...(simulation.value.logs ?? []),
      ].join("\n")
    );
  }

  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight: false,
      preflightCommitment: DEFAULT_COMMITMENT,
    }
  );

  try {
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        ...latestBlockhash,
      },
      DEFAULT_COMMITMENT
    );
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

export async function getQuoteDecimals(
  connection: Connection,
  quoteMint: PublicKey
): Promise<number> {
  if (quoteMint.equals(NATIVE_MINT)) {
    return 9;
  }

  return getTokenDecimals(connection, quoteMint);
}

export function toBN(value: unknown): BN {
  if (BN.isBN(value)) {
    return value;
  }

  return new BN(String(value));
}

export function toNumber(value: unknown): number {
  return Number(toBN(value).toString());
}

export function rawAmountToUi(rawAmount: BN, decimals: number): string {
  return new Decimal(rawAmount.toString())
    .div(new Decimal(10).pow(decimals))
    .toString();
}

export function uiAmountToRaw(amount: string | number, decimals: number): BN {
  const raw = new Decimal(String(amount)).mul(new Decimal(10).pow(decimals));
  if (!raw.isInteger() || raw.isNegative()) {
    throw new Error(
      `Amount ${amount} cannot be represented exactly with ${decimals} decimals`
    );
  }

  return new BN(raw.toFixed(0));
}

export function amountToRaw(
  amount: string | number | BN,
  decimals: number,
  rawAmounts?: boolean
): BN {
  if (BN.isBN(amount)) {
    return amount;
  }

  if (rawAmounts) {
    return new BN(String(amount));
  }

  return uiAmountToRaw(amount, decimals);
}

export function percent(numerator: BN, denominator: BN): string | null {
  if (denominator.isZero()) {
    return null;
  }

  return new Decimal(numerator.toString())
    .mul(100)
    .div(new Decimal(denominator.toString()))
    .toDecimalPlaces(6)
    .toString();
}

export function bnMin(a: BN, b: BN): BN {
  return a.lte(b) ? a : b;
}

export function getActiveCurve(config: any) {
  return (config.curve ?? [])
    .map((point: any) => ({
      sqrtPrice: toBN(point.sqrtPrice),
      liquidity: toBN(point.liquidity),
    }))
    .filter((point: { sqrtPrice: BN; liquidity: BN }) => {
      return !point.sqrtPrice.isZero() && !point.liquidity.isZero();
    });
}

export function getLockedVestingTotal(config: any): BN {
  const lockedVesting = config.lockedVestingConfig;
  if (!lockedVesting) {
    return new BN(0);
  }

  return toBN(lockedVesting.cliffUnlockAmount).add(
    toBN(lockedVesting.amountPerPeriod).mul(toBN(lockedVesting.numberOfPeriod))
  );
}

export function getInitialBaseSupply(config: any): BN {
  if (toNumber(config.fixedTokenSupplyFlag) === 1) {
    return toBN(config.preMigrationTokenSupply);
  }

  return getSwapAmountWithBuffer(
    toBN(config.swapBaseAmount),
    toBN(config.sqrtStartPrice),
    getActiveCurve(config)
  )
    .add(toBN(config.migrationBaseThreshold))
    .add(getLockedVestingTotal(config));
}

export function tokenTypeLabel(value: number): string {
  return value === TokenType.Token2022 ? "token_2022" : "spl_token";
}

export function unwrapVirtualPoolAccount<T = any>(account: T): any {
  return (account as any)?.poolState ?? account;
}

export function getTokenProgramForFlag(tokenFlag: number): PublicKey {
  return tokenFlag === TokenType.Token2022
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}
