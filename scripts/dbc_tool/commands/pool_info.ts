import {
  getPriceFromSqrtPrice,
  TokenDecimal,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PublicKey } from "@solana/web3.js";
import {
  buildClient,
  getInitialBaseSupply,
  getQuoteDecimals,
  bnMin,
  percent,
  rawAmountToUi,
  toBN,
  toNumber,
  tokenTypeLabel,
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
  const migrationQuoteThreshold = toBN(config.migrationQuoteThreshold);
  const migrationBaseThreshold = toBN(config.migrationBaseThreshold);
  const quoteRemainingToMigration = migrationQuoteThreshold.gt(quoteReserve)
    ? migrationQuoteThreshold.sub(quoteReserve)
    : toBN(0);
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
    migration: {
      migrationProgress: toNumber(poolState.migrationProgress),
      migrationProgressLabel: migrationProgressLabel(
        toNumber(poolState.migrationProgress)
      ),
      isMigrated: toNumber(poolState.isMigrated) === 1,
      isCurveComplete: quoteReserve.gte(migrationQuoteThreshold),
      finishCurveTimestamp: toNumber(poolState.finishCurveTimestamp),
      saleCompletionPercent: percent(
        bnMin(quoteReserve, migrationQuoteThreshold),
        migrationQuoteThreshold
      ),
      quoteReserveRaw: quoteReserve.toString(),
      quoteReserveUi: rawAmountToUi(quoteReserve, quoteDecimals),
      migrationQuoteThresholdRaw: migrationQuoteThreshold.toString(),
      migrationQuoteThresholdUi: rawAmountToUi(
        migrationQuoteThreshold,
        quoteDecimals
      ),
      quoteRemainingRaw: quoteRemainingToMigration.toString(),
      quoteRemainingUi: rawAmountToUi(quoteRemainingToMigration, quoteDecimals),
      migrationBaseThresholdRaw: migrationBaseThreshold.toString(),
      migrationBaseThresholdUi: rawAmountToUi(
        migrationBaseThreshold,
        baseDecimals
      ),
      migrationSqrtPrice: toBN(config.migrationSqrtPrice).toString(),
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

function migrationProgressLabel(value: number): string {
  return (
    [
      "pre_bonding_curve",
      "post_bonding_curve",
      "locked_vesting",
      "created_pool",
    ][value] ?? `unknown_${value}`
  );
}
