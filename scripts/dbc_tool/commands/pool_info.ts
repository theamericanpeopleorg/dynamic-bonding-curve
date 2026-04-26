import { Program } from "@coral-xyz/anchor";
import {
  getCurrentPoint,
  getFeeMode,
  getPriceFromSqrtPrice,
  getSwapResultFromExactOutput,
  getSwapResultFromPartialInput,
  METAPLEX_PROGRAM_ID,
  MigrationOption,
  TokenDecimal,
  TokenType,
  TradeDirection,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  buildClient,
  buildDefaultCurveConfig,
  getInitialBaseSupply,
  getQuoteDecimals,
  getTokenProgramForFlag,
  loadKeypair,
  MAINNET_USDC_MINT,
  amountToRaw,
  bnMin,
  deriveDbcPoolAddressForProgram,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  deriveMintMetadata,
  percent,
  rawAmountToUi,
  simulateAndSend,
  toBN,
  toNumber,
  tokenTypeLabel,
  type BuyOptions,
  type BuyResult,
  type CreateConfigOptions,
  type CreateConfigResult,
  type CreatePoolOptions,
  type CreatePoolResult,
  type PoolInfoOptions,
  type PoolInfoResult,
} from "../shared";

export async function poolInfo(
  pool: PublicKey | string,
  options: PoolInfoOptions = {}
): Promise<PoolInfoResult> {
  const { connection, program } = await buildClient(options.rpcUrl);
  const poolPublicKey = typeof pool === "string" ? new PublicKey(pool) : pool;
  const poolState = (await (program.account as any).virtualPool.fetch(
    poolPublicKey
  )) as any;
  const configPublicKey = new PublicKey(poolState.config);
  const config = (await (program.account as any).poolConfig.fetch(
    configPublicKey
  )) as any;

  const baseMint = new PublicKey(poolState.baseMint);
  const quoteMint = new PublicKey(config.quoteMint);
  const baseDecimals = toNumber(config.tokenDecimal);
  const quoteDecimals = await getQuoteDecimals(connection, quoteMint);
  const baseReserve = toBN(poolState.baseReserve);
  const quoteReserve = toBN(poolState.quoteReserve);
  const initialBaseSupply = getInitialBaseSupply(config);
  const tokensSold = initialBaseSupply.sub(
    bnMin(baseReserve, initialBaseSupply)
  );
  const currentPrice = getPriceFromSqrtPrice(
    toBN(poolState.sqrtPrice),
    baseDecimals as TokenDecimal,
    quoteDecimals as TokenDecimal
  );

  return {
    addresses: {
      pool: poolPublicKey.toBase58(),
      config: configPublicKey.toBase58(),
      creator: new PublicKey(poolState.creator).toBase58(),
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      baseVault: new PublicKey(poolState.baseVault).toBase58(),
      quoteVault: new PublicKey(poolState.quoteVault).toBase58(),
      leftoverReceiver: new PublicKey(config.leftoverReceiver).toBase58(),
      feeClaimer: new PublicKey(config.feeClaimer).toBase58(),
    },
    token: {
      baseDecimals,
      quoteDecimals,
      tokenType: tokenTypeLabel(toNumber(config.tokenType)),
      quoteTokenFlag: toNumber(config.quoteTokenFlag ?? 0),
      fixedSupply: toNumber(config.fixedTokenSupplyFlag) === 1,
    },
    price: {
      currentQuotePerBase: currentPrice.toString(),
      sqrtPrice: toBN(poolState.sqrtPrice).toString(),
      sqrtStartPrice: toBN(config.sqrtStartPrice).toString(),
    },
    sale: {
      initialBaseSupplyRaw: initialBaseSupply.toString(),
      initialBaseSupplyUi: rawAmountToUi(initialBaseSupply, baseDecimals),
      baseReserveRaw: baseReserve.toString(),
      baseReserveUi: rawAmountToUi(baseReserve, baseDecimals),
      quoteReserveRaw: quoteReserve.toString(),
      quoteReserveUi: rawAmountToUi(quoteReserve, quoteDecimals),
      tokensSoldRaw: tokensSold.toString(),
      tokensSoldUi: rawAmountToUi(tokensSold, baseDecimals),
      tokensSoldPercentOfInitialSupply: percent(tokensSold, initialBaseSupply),
      tokensSoldPercentOfPlannedSwap: percent(
        tokensSold,
        toBN(config.swapBaseAmount)
      ),
      plannedSwapBaseAmountRaw: toBN(config.swapBaseAmount).toString(),
      plannedSwapBaseAmountUi: rawAmountToUi(
        toBN(config.swapBaseAmount),
        baseDecimals
      ),
    },
    fees: {
      protocolBaseFeeRaw: toBN(poolState.protocolBaseFee).toString(),
      protocolQuoteFeeRaw: toBN(poolState.protocolQuoteFee).toString(),
      partnerBaseFeeRaw: toBN(poolState.partnerBaseFee).toString(),
      partnerQuoteFeeRaw: toBN(poolState.partnerQuoteFee).toString(),
      creatorBaseFeeRaw: toBN(poolState.creatorBaseFee).toString(),
      creatorQuoteFeeRaw: toBN(poolState.creatorQuoteFee).toString(),
      creatorTradingFeePercentage: toNumber(config.creatorTradingFeePercentage),
      migrationFeePercentage: toNumber(config.migrationFeePercentage),
      creatorMigrationFeePercentage: toNumber(
        config.creatorMigrationFeePercentage
      ),
    },
  };
}
