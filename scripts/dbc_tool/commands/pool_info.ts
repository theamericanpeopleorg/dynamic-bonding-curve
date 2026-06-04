import {
  deriveDammV2PoolAddress,
  deriveDammV2TokenVaultAddress,
  getPriceFromSqrtPrice,
  TokenDecimal,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  buildClient,
  getTokenProgramForFlag,
  getInitialBaseSupply,
  getQuoteDecimals,
  bnMin,
  percent,
  rawAmountToUi,
  toBN,
  toNumber,
  tokenTypeLabel,
  unwrapVirtualPoolAccount,
  type PoolInfoOptions,
  type PoolInfoResult,
} from "../shared";

export async function poolInfo(
  pool: PublicKey | string,
  options: PoolInfoOptions = {}
): Promise<PoolInfoResult> {
  const { connection, program } = await buildClient(options.rpcUrl);
  const poolPublicKey = typeof pool === "string" ? new PublicKey(pool) : pool;
  const poolState = unwrapVirtualPoolAccount(
    await (program.account as any).virtualPool.fetch(poolPublicKey)
  );
  const configPublicKey = new PublicKey(poolState.config);
  const config = (await (program.account as any).poolConfig.fetch(
    configPublicKey
  )) as any;

  const creator = new PublicKey(poolState.creator);
  const baseMint = new PublicKey(poolState.baseMint);
  const quoteMint = new PublicKey(config.quoteMint);
  const baseVault = new PublicKey(poolState.baseVault);
  const quoteVault = new PublicKey(poolState.quoteVault);
  const leftoverReceiver = new PublicKey(config.leftoverReceiver);
  const feeClaimer = new PublicKey(config.feeClaimer);
  const dammConfig =
    options.dammConfig == null
      ? null
      : typeof options.dammConfig === "string"
      ? new PublicKey(options.dammConfig)
      : options.dammConfig;
  const baseDecimals = toNumber(config.tokenDecimal);
  const quoteDecimals = await getQuoteDecimals(connection, quoteMint);
  const tokenBaseProgram = getTokenProgramForFlag(toNumber(config.tokenType));
  const tokenQuoteProgram = getTokenProgramForFlag(
    toNumber(config.quoteTokenFlag ?? 0)
  );
  const baseReserve = toBN(poolState.baseReserve);
  const quoteReserve = toBN(poolState.quoteReserve);
  const virtualQuoteReserve = toBN(poolState.virtualQuoteReserve ?? 0);
  const totalQuoteReserve = quoteReserve.add(virtualQuoteReserve);
  const migrationQuoteThreshold = toBN(config.migrationQuoteThreshold);
  const migrationBaseThreshold = toBN(config.migrationBaseThreshold);
  const deadlineTimestamp = toBN(poolState.deadlineTimestamp ?? 0);
  const nowTimestamp = new BN(Math.floor(Date.now() / 1000));
  const deadlineReached =
    !deadlineTimestamp.isZero() && nowTimestamp.gte(deadlineTimestamp);
  const thresholdReached = totalQuoteReserve.gte(migrationQuoteThreshold);
  const saleComplete = thresholdReached || deadlineReached;
  const completionMode = thresholdReached
    ? "threshold"
    : deadlineReached
    ? "deadline"
    : "open";
  const quoteRemainingToMigration = migrationQuoteThreshold.gt(totalQuoteReserve)
    ? migrationQuoteThreshold.sub(totalQuoteReserve)
    : toBN(0);
  const initialBaseSupply = getInitialBaseSupply(config);
  const tokensSold = initialBaseSupply.sub(
    bnMin(baseReserve, initialBaseSupply)
  );
  const protocolBaseFee = toBN(poolState.protocolBaseFee);
  const protocolQuoteFee = toBN(poolState.protocolQuoteFee);
  const partnerBaseFee = toBN(poolState.partnerBaseFee);
  const partnerQuoteFee = toBN(poolState.partnerQuoteFee);
  const creatorBaseFee = toBN(poolState.creatorBaseFee);
  const creatorQuoteFee = toBN(poolState.creatorQuoteFee);
  const totalBaseFee = protocolBaseFee.add(partnerBaseFee).add(creatorBaseFee);
  const totalQuoteFee = protocolQuoteFee
    .add(partnerQuoteFee)
    .add(creatorQuoteFee);
  const migrationFeePercentage = toNumber(config.migrationFeePercentage);
  const creatorMigrationFeePercentage = toNumber(
    config.creatorMigrationFeePercentage
  );
  const migrationFeeBasis = quoteReserve;
  const estimatedMigrationQuoteAmount = divCeil(
    migrationFeeBasis.muln(100 - migrationFeePercentage),
    new BN(100)
  );
  const estimatedMigrationFeeTotal = migrationFeeBasis.sub(
    estimatedMigrationQuoteAmount
  );
  const estimatedCreatorMigrationFee = estimatedMigrationFeeTotal
    .muln(creatorMigrationFeePercentage)
    .divn(100);
  const estimatedPartnerMigrationFee = estimatedMigrationFeeTotal.sub(
    estimatedCreatorMigrationFee
  );
  const migrationFeeWithdrawStatus = toNumber(
    poolState.migrationFeeWithdrawStatus ?? 0
  );
  const currentPrice = getPriceFromSqrtPrice(
    toBN(poolState.sqrtPrice),
    baseDecimals as TokenDecimal,
    quoteDecimals as TokenDecimal
  );
  const destinationBalances = await readDestinationBalances({
    connection,
    creator,
    feeClaimer,
    leftoverReceiver,
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
    dammConfig,
    baseDecimals,
    quoteDecimals,
    tokenBaseProgram,
    tokenQuoteProgram,
  });

  return {
    addresses: {
      pool: poolPublicKey.toBase58(),
      config: configPublicKey.toBase58(),
      creator: creator.toBase58(),
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      baseVault: baseVault.toBase58(),
      quoteVault: quoteVault.toBase58(),
      leftoverReceiver: leftoverReceiver.toBase58(),
      feeClaimer: feeClaimer.toBase58(),
      dammConfig: dammConfig?.toBase58() ?? null,
      dammPool: destinationBalances.dammPool,
      dammBaseVault: destinationBalances.dammBaseVault?.tokenAccount ?? null,
      dammQuoteVault: destinationBalances.dammQuoteVault?.tokenAccount ?? null,
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
      virtualQuoteReserveRaw: virtualQuoteReserve.toString(),
      virtualQuoteReserveUi: rawAmountToUi(virtualQuoteReserve, quoteDecimals),
      totalQuoteReserveRaw: totalQuoteReserve.toString(),
      totalQuoteReserveUi: rawAmountToUi(totalQuoteReserve, quoteDecimals),
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
      hasLockedVesting: hasLockedVesting(config),
      isCurveComplete: thresholdReached,
      saleComplete,
      completionMode,
      deadlineTimestamp: deadlineTimestamp.toNumber(),
      deadlineReached,
      finishCurveTimestamp: toNumber(poolState.finishCurveTimestamp),
      saleCompletionPercent: percent(
        bnMin(totalQuoteReserve, migrationQuoteThreshold),
        migrationQuoteThreshold
      ),
      quoteReserveRaw: quoteReserve.toString(),
      quoteReserveUi: rawAmountToUi(quoteReserve, quoteDecimals),
      virtualQuoteReserveRaw: virtualQuoteReserve.toString(),
      virtualQuoteReserveUi: rawAmountToUi(virtualQuoteReserve, quoteDecimals),
      totalQuoteReserveRaw: totalQuoteReserve.toString(),
      totalQuoteReserveUi: rawAmountToUi(totalQuoteReserve, quoteDecimals),
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
      protocolBaseFeeRaw: protocolBaseFee.toString(),
      protocolBaseFeeUi: rawAmountToUi(protocolBaseFee, baseDecimals),
      protocolQuoteFeeRaw: protocolQuoteFee.toString(),
      protocolQuoteFeeUi: rawAmountToUi(protocolQuoteFee, quoteDecimals),
      partnerBaseFeeRaw: partnerBaseFee.toString(),
      partnerBaseFeeUi: rawAmountToUi(partnerBaseFee, baseDecimals),
      partnerQuoteFeeRaw: partnerQuoteFee.toString(),
      partnerQuoteFeeUi: rawAmountToUi(partnerQuoteFee, quoteDecimals),
      creatorBaseFeeRaw: creatorBaseFee.toString(),
      creatorBaseFeeUi: rawAmountToUi(creatorBaseFee, baseDecimals),
      creatorQuoteFeeRaw: creatorQuoteFee.toString(),
      creatorQuoteFeeUi: rawAmountToUi(creatorQuoteFee, quoteDecimals),
      totalBaseFeeRaw: totalBaseFee.toString(),
      totalBaseFeeUi: rawAmountToUi(totalBaseFee, baseDecimals),
      totalQuoteFeeRaw: totalQuoteFee.toString(),
      totalQuoteFeeUi: rawAmountToUi(totalQuoteFee, quoteDecimals),
      protocolLiquidityMigrationFeeBps: toNumber(
        poolState.protocolLiquidityMigrationFeeBps ?? 0
      ),
      protocolMigrationBaseFeeRaw: toBN(
        poolState.protocolMigrationBaseFeeAmount ?? 0
      ).toString(),
      protocolMigrationBaseFeeUi: rawAmountToUi(
        toBN(poolState.protocolMigrationBaseFeeAmount ?? 0),
        baseDecimals
      ),
      protocolMigrationQuoteFeeRaw: toBN(
        poolState.protocolMigrationQuoteFeeAmount ?? 0
      ).toString(),
      protocolMigrationQuoteFeeUi: rawAmountToUi(
        toBN(poolState.protocolMigrationQuoteFeeAmount ?? 0),
        quoteDecimals
      ),
      creatorTradingFeePercentage: toNumber(config.creatorTradingFeePercentage),
      migrationFeePercentage,
      creatorMigrationFeePercentage,
      partnerMigrationFeePercentage: 100 - creatorMigrationFeePercentage,
      migrationFeeBasisRaw: migrationFeeBasis.toString(),
      migrationFeeBasisUi: rawAmountToUi(migrationFeeBasis, quoteDecimals),
      estimatedMigrationFeeTotalRaw: estimatedMigrationFeeTotal.toString(),
      estimatedMigrationFeeTotalUi: rawAmountToUi(
        estimatedMigrationFeeTotal,
        quoteDecimals
      ),
      estimatedCreatorMigrationFeeRaw: estimatedCreatorMigrationFee.toString(),
      estimatedCreatorMigrationFeeUi: rawAmountToUi(
        estimatedCreatorMigrationFee,
        quoteDecimals
      ),
      estimatedPartnerMigrationFeeRaw: estimatedPartnerMigrationFee.toString(),
      estimatedPartnerMigrationFeeUi: rawAmountToUi(
        estimatedPartnerMigrationFee,
        quoteDecimals
      ),
      creatorMigrationFeeWithdrawn:
        (migrationFeeWithdrawStatus & CREATOR_MIGRATION_FEE_MASK) !== 0,
      partnerMigrationFeeWithdrawn:
        (migrationFeeWithdrawStatus & PARTNER_MIGRATION_FEE_MASK) !== 0,
    },
    destinationBalances,
  };
}

const CREATOR_MIGRATION_FEE_MASK = 0b010;
const PARTNER_MIGRATION_FEE_MASK = 0b100;

function divCeil(numerator: BN, denominator: BN): BN {
  return numerator.add(denominator).subn(1).div(denominator);
}

function hasLockedVesting(config: any): boolean {
  const lockedVesting = config.lockedVestingConfig;
  if (!lockedVesting) {
    return false;
  }

  return [
    lockedVesting.amountPerPeriod,
    lockedVesting.cliffDurationFromMigrationTime,
    lockedVesting.frequency,
    lockedVesting.numberOfPeriod,
    lockedVesting.cliffUnlockAmount,
  ].some((value) => !toBN(value ?? 0).isZero());
}

async function readDestinationBalances(params: {
  connection: any;
  creator: PublicKey;
  feeClaimer: PublicKey;
  leftoverReceiver: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  dammConfig: PublicKey | null;
  baseDecimals: number;
  quoteDecimals: number;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
}) {
  const {
    connection,
    creator,
    feeClaimer,
    leftoverReceiver,
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
    dammConfig,
    baseDecimals,
    quoteDecimals,
    tokenBaseProgram,
    tokenQuoteProgram,
  } = params;
  const [creatorBalances, feeClaimerBalances, leftoverReceiverBalances] =
    await Promise.all(
      [creator, feeClaimer, leftoverReceiver].map((owner) =>
        readOwnerTokenBalances({
          connection,
          owner,
          baseMint,
          quoteMint,
          baseDecimals,
          quoteDecimals,
          tokenBaseProgram,
          tokenQuoteProgram,
        })
      )
    );
  const [dbcBaseVault, dbcQuoteVault] = await Promise.all([
    readTokenAccountBalance(connection, baseVault, baseDecimals),
    readTokenAccountBalance(connection, quoteVault, quoteDecimals),
  ]);

  if (!dammConfig) {
    return {
      creator: creatorBalances,
      feeClaimer: feeClaimerBalances,
      leftoverReceiver: leftoverReceiverBalances,
      dbcBaseVault,
      dbcQuoteVault,
      dammPool: null,
      dammBaseVault: null,
      dammQuoteVault: null,
    };
  }

  const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint);
  const dammBaseVaultAddress = deriveDammV2TokenVaultAddress(dammPool, baseMint);
  const dammQuoteVaultAddress = deriveDammV2TokenVaultAddress(
    dammPool,
    quoteMint
  );
  const [dammBaseVault, dammQuoteVault] = await Promise.all([
    readTokenAccountBalance(connection, dammBaseVaultAddress, baseDecimals),
    readTokenAccountBalance(connection, dammQuoteVaultAddress, quoteDecimals),
  ]);

  return {
    creator: creatorBalances,
    feeClaimer: feeClaimerBalances,
    leftoverReceiver: leftoverReceiverBalances,
    dbcBaseVault,
    dbcQuoteVault,
    dammPool: dammPool.toBase58(),
    dammBaseVault,
    dammQuoteVault,
  };
}

async function readOwnerTokenBalances(params: {
  connection: any;
  owner: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
}) {
  const baseTokenAccount = getAssociatedTokenAddressSync(
    params.baseMint,
    params.owner,
    true,
    params.tokenBaseProgram
  );
  const quoteTokenAccount = getAssociatedTokenAddressSync(
    params.quoteMint,
    params.owner,
    true,
    params.tokenQuoteProgram
  );
  const [base, quote] = await Promise.all([
    readTokenAccountBalance(
      params.connection,
      baseTokenAccount,
      params.baseDecimals
    ),
    readTokenAccountBalance(
      params.connection,
      quoteTokenAccount,
      params.quoteDecimals
    ),
  ]);

  return { base, quote };
}

async function readTokenAccountBalance(
  connection: any,
  tokenAccount: PublicKey,
  decimals: number
) {
  try {
    const balance = await connection.getTokenAccountBalance(tokenAccount);
    const raw = toBN(balance.value.amount);
    return {
      tokenAccount: tokenAccount.toBase58(),
      raw: raw.toString(),
      ui: rawAmountToUi(raw, decimals),
      exists: true,
    };
  } catch {
    return {
      tokenAccount: tokenAccount.toBase58(),
      raw: "0",
      ui: rawAmountToUi(new BN(0), decimals),
      exists: false,
    };
  }
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
