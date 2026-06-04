import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ConfigParameters,
  createConfig,
  CreateConfigParams,
  createMeteoraDammV2Metadata,
  createPoolWithSplToken,
  migrateToDammV2,
  swap2,
  SwapMode,
  SwapParams2,
  virtualSwap2,
} from "./instructions";
import {
  createDammV2Config,
  createDammV2Operator,
  createVirtualCurveProgram,
  DammV2OperatorPermission,
  designCurve,
  derivePoolAuthority,
  encodePermissions,
  expectThrowsAsync,
  FEE_DENOMINATOR,
  generateAndFund,
  getDbcProgramErrorCodeHexString,
  getTokenAccount,
  startSvm,
  U64_MAX,
} from "./utils";
import { getDammV2Pool, getVirtualPool } from "./utils/fetcher";
import { VirtualCurveProgram } from "./utils/types";

import {
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { expect } from "chai";
import { LiteSVM } from "litesvm";
import { createToken, mintSplTokenTo } from "./utils/token";

describe("Swap V2", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let operator: Keypair;
  let partner: Keypair;
  let user: Keypair;
  let poolCreator: Keypair;
  let program: VirtualCurveProgram;
  let dammV2Config: PublicKey;

  before(async () => {
    svm = startSvm();
    admin = generateAndFund(svm);
    operator = generateAndFund(svm);
    partner = generateAndFund(svm);
    user = generateAndFund(svm);
    poolCreator = generateAndFund(svm);
    program = createVirtualCurveProgram();
    await createDammV2Operator(svm, {
      whitelistAddress: admin.publicKey,
      admin,
      permission: encodePermissions([DammV2OperatorPermission.CreateConfigKey]),
    });
    dammV2Config = await createDammV2Config(
      svm,
      admin,
      derivePoolAuthority(),
      1
    );
  });
  it("Swap over the curve exact in collect fee mode both tokens", async () => {
    let totalTokenSupply = 1_000_000_000; // 1 billion
    let percentageSupplyOnMigration = 10; // 10%;
    let migrationQuoteThreshold = 300; // 300 sol
    let tokenBaseDecimal = 6;
    let tokenQuoteDecimal = 9;
    let migrationOption = 0; // damm v1
    let lockedVesting = {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    };
    let collectFeeMode = 1;
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      0,
      collectFeeMode,
      lockedVesting,
      {
        feePercentage: 0,
        creatorFeePercentage: 0,
      }
    );

    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      leftoverReceiver: partner.publicKey,
      feeClaimer: partner.publicKey,
      quoteMint,
      instructionParams,
    };
    let config = await createConfig(svm, program, params);
    // exact amount in is migration quote threshold amount
    let swapAmount = instructionParams.migrationQuoteThreshold;

    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      swapAmount.toNumber()
    );

    // create pool
    let virtualPool = await createPoolWithSplToken(svm, program, {
      poolCreator,
      payer: operator,
      quoteMint,
      config,
      instructionParams: {
        name: "test token spl",
        symbol: "TEST",
        uri: "abc.com",
      },
    });
    let virtualPoolState = getVirtualPool(svm, program, virtualPool);

    // swap
    const preVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;
    const swapParams: SwapParams2 = {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: quoteMint,
      outputTokenMint: virtualPoolState.baseMint,
      amount0: swapAmount,
      amount1: new BN(0),
      referralTokenAccount: null,
      swapMode: SwapMode.ExactIn,
    };
    await swap2(svm, program, swapParams);
    const postVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;

    expect(Number(postVaultBalance) - Number(preVaultBalance)).eq(
      swapAmount.toNumber()
    );
    virtualPoolState = getVirtualPool(svm, program, virtualPool);

    expect(virtualPoolState.quoteReserve.toNumber()).eq(
      instructionParams.migrationQuoteThreshold.toNumber()
    );
  });

  it("Swap over the curve exact in collect fee only quote token", async () => {
    let totalTokenSupply = 1_000_000_000; // 1 billion
    let percentageSupplyOnMigration = 10; // 10%;
    let migrationQuoteThreshold = 300; // 300 sol
    let tokenBaseDecimal = 6;
    let tokenQuoteDecimal = 9;
    let migrationOption = 0; // damm v1
    let lockedVesting = {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    };
    let collectFeeMode = 0;
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      0,
      collectFeeMode,
      lockedVesting,
      {
        feePercentage: 0,
        creatorFeePercentage: 0,
      }
    );

    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      leftoverReceiver: partner.publicKey,
      feeClaimer: partner.publicKey,
      quoteMint,
      instructionParams,
    };
    let config = await createConfig(svm, program, params);

    const tradeFeeNumerator =
      instructionParams.poolFees.baseFee.cliffFeeNumerator;
    // swapAmount - swapAmount * fee_numerator / denominator = migration_quote_threshold;
    let { div, mod } = instructionParams.migrationQuoteThreshold
      .mul(FEE_DENOMINATOR)
      .divmod(FEE_DENOMINATOR.sub(tradeFeeNumerator));
    const swapAmount = mod.isZero() ? div : div.add(new BN(1)); // round up

    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      swapAmount.toNumber()
    );

    // create pool
    let virtualPool = await createPoolWithSplToken(svm, program, {
      poolCreator,
      payer: operator,
      quoteMint,
      config,
      instructionParams: {
        name: "test token spl",
        symbol: "TEST",
        uri: "abc.com",
      },
    });
    let virtualPoolState = getVirtualPool(svm, program, virtualPool);

    // swap
    const preVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;
    const swapParams: SwapParams2 = {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: quoteMint,
      outputTokenMint: virtualPoolState.baseMint,
      amount0: swapAmount,
      amount1: new BN(0),
      referralTokenAccount: null,
      swapMode: SwapMode.ExactIn,
    };

    await swap2(svm, program, swapParams);
    const postVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;

    expect(Number(postVaultBalance) - Number(preVaultBalance)).eq(
      swapAmount.toNumber()
    );
    virtualPoolState = getVirtualPool(svm, program, virtualPool);

    expect(virtualPoolState.quoteReserve.toNumber()).eq(
      instructionParams.migrationQuoteThreshold.toNumber()
    );
  });

  it("Swap over the curve partial fill collect fee mode both tokens", async () => {
    let totalTokenSupply = 1_000_000_000; // 1 billion
    let percentageSupplyOnMigration = 10; // 10%;
    let migrationQuoteThreshold = 300; // 300 sol
    let tokenBaseDecimal = 6;
    let tokenQuoteDecimal = 9;
    let migrationOption = 0; // damm v1
    let lockedVesting = {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    };
    let collectFeeMode = 1;
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      0,
      collectFeeMode,
      lockedVesting,
      {
        feePercentage: 0,
        creatorFeePercentage: 0,
      }
    );

    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      leftoverReceiver: partner.publicKey,
      feeClaimer: partner.publicKey,
      quoteMint,
      instructionParams,
    };
    let config = await createConfig(svm, program, params);
    let swapAmount = instructionParams.migrationQuoteThreshold
      .mul(new BN(120))
      .div(new BN(100)); // swap more 20%

    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      swapAmount.toNumber()
    );

    // create pool
    let virtualPool = await createPoolWithSplToken(svm, program, {
      poolCreator,
      payer: operator,
      quoteMint,
      config,
      instructionParams: {
        name: "test token spl",
        symbol: "TEST",
        uri: "abc.com",
      },
    });
    let virtualPoolState = getVirtualPool(svm, program, virtualPool);

    // swap
    const preVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;
    const swapParams: SwapParams2 = {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: quoteMint,
      outputTokenMint: virtualPoolState.baseMint,
      amount0: swapAmount,
      amount1: new BN(0),
      referralTokenAccount: null,
      swapMode: SwapMode.PartialFill,
    };
    await swap2(svm, program, swapParams);
    const postVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;

    expect(Number(postVaultBalance) - Number(preVaultBalance)).lt(
      swapAmount.toNumber()
    );
    virtualPoolState = getVirtualPool(svm, program, virtualPool);
    console.log(
      "diffBalance %d swapAmount %d",
      Number(postVaultBalance) - Number(preVaultBalance),
      swapAmount.toString()
    );
    console.log(
      "quoteReserve %d migrationQuoteThreshold %d",
      virtualPoolState.quoteReserve.toString(),
      instructionParams.migrationQuoteThreshold.toString()
    );
    expect(virtualPoolState.quoteReserve.toNumber()).eq(
      instructionParams.migrationQuoteThreshold.toNumber()
    );
  });

  it("Swap over the curve partial fill collect fee mode only quote token", async () => {
    let totalTokenSupply = 1_000_000_000; // 1 billion
    let percentageSupplyOnMigration = 10; // 10%;
    let migrationQuoteThreshold = 300; // 300 sol
    let tokenBaseDecimal = 6;
    let tokenQuoteDecimal = 9;
    let migrationOption = 0; // damm v1
    let lockedVesting = {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    };
    let collectFeeMode = 0;
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      0,
      collectFeeMode,
      lockedVesting,
      {
        feePercentage: 0,
        creatorFeePercentage: 0,
      }
    );

    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      leftoverReceiver: partner.publicKey,
      feeClaimer: partner.publicKey,
      quoteMint,
      instructionParams,
    };
    let config = await createConfig(svm, program, params);
    let swapAmount = instructionParams.migrationQuoteThreshold
      .mul(new BN(120))
      .div(new BN(100)); // swap more 20%

    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      swapAmount.toNumber()
    );

    // create pool
    let virtualPool = await createPoolWithSplToken(svm, program, {
      poolCreator,
      payer: operator,
      quoteMint,
      config,
      instructionParams: {
        name: "test token spl",
        symbol: "TEST",
        uri: "abc.com",
      },
    });
    let virtualPoolState = getVirtualPool(svm, program, virtualPool);

    // swap
    const preVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;
    const swapParams: SwapParams2 = {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: quoteMint,
      outputTokenMint: virtualPoolState.baseMint,
      amount0: swapAmount,
      amount1: new BN(0),
      referralTokenAccount: null,
      swapMode: SwapMode.PartialFill,
    };
    await swap2(svm, program, swapParams);
    const postVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;

    expect(Number(postVaultBalance) - Number(preVaultBalance)).lt(
      swapAmount.toNumber()
    );
    virtualPoolState = getVirtualPool(svm, program, virtualPool);
    console.log(
      "diffBalance %d swapAmount %d",
      Number(postVaultBalance) - Number(preVaultBalance),
      swapAmount.toString()
    );
    console.log(
      "quoteReserve %d migrationQuoteThreshold %d",
      virtualPoolState.quoteReserve.toString(),
      instructionParams.migrationQuoteThreshold.toString()
    );
    expect(virtualPoolState.quoteReserve.toNumber()).eq(
      instructionParams.migrationQuoteThreshold.toNumber()
    );
  });

  it("Swap exact out", async () => {
    let totalTokenSupply = 1_000_000_000; // 1 billion
    let percentageSupplyOnMigration = 10; // 10%;
    let migrationQuoteThreshold = 300; // 300 sol
    let tokenBaseDecimal = 6;
    let tokenQuoteDecimal = 9;
    let migrationOption = 0; // damm v1
    let lockedVesting = {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    };
    let collectFeeMode = 0;
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    const feeIncrementBps = 100;
    const maxLimiterDuration = 86400;
    const referenceAmount = 1_000_000;
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      0,
      collectFeeMode,
      lockedVesting,
      {
        feePercentage: 0,
        creatorFeePercentage: 0,
      },
      {
        baseFeeOption: {
          cliffFeeNumerator: new BN(2_500_000),
          firstFactor: feeIncrementBps,
          secondFactor: new BN(maxLimiterDuration),
          thirdFactor: new BN(referenceAmount),
          baseFeeMode: 2, // Rate limiter
        },
      }
    );

    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      leftoverReceiver: partner.publicKey,
      feeClaimer: partner.publicKey,
      quoteMint,
      instructionParams,
    };
    let config = await createConfig(svm, program, params);
    let swapAmount = instructionParams.migrationQuoteThreshold
      .mul(new BN(120))
      .div(new BN(100)); // swap more 20%

    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      swapAmount.toNumber()
    );

    // create pool
    let virtualPool = await createPoolWithSplToken(svm, program, {
      poolCreator,
      payer: operator,
      quoteMint,
      config,
      instructionParams: {
        name: "test token spl",
        symbol: "TEST",
        uri: "abc.com",
      },
    });
    let virtualPoolState = getVirtualPool(svm, program, virtualPool);

    // 90% of base
    const outAmount = new BN(totalTokenSupply).muln(90).divn(100);

    const swapParams: SwapParams2 = {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: quoteMint,
      outputTokenMint: virtualPoolState.baseMint,
      amount0: outAmount,
      amount1: U64_MAX, // yolo
      referralTokenAccount: null,
      swapMode: SwapMode.ExactOut,
    };

    const { computeUnitsConsumed } = await swap2(svm, program, swapParams);

    console.log(`CU used ${computeUnitsConsumed}`);

    const userOutTokenAccount = getAssociatedTokenAddressSync(
      swapParams.outputTokenMint,
      swapParams.payer.publicKey,
      false
    );
    const userOutRawTokenAccount = svm.getAccount(userOutTokenAccount);
    const userOutTokenBal = unpackAccount(
      userOutTokenAccount,
      // @ts-expect-error
      userOutRawTokenAccount
    ).amount;
    expect(new BN(userOutTokenBal.toString()).eq(outAmount)).to.be.true;
  });

  async function createVirtualSwapFixture(collectFeeMode = 1, migrationOption = 0) {
    const totalTokenSupply = 1_000_000_000;
    const percentageSupplyOnMigration = 10;
    const migrationQuoteThreshold = 300;
    const tokenBaseDecimal = 6;
    const tokenQuoteDecimal = 9;
    const lockedVesting = {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    };
    const quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    const instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      0,
      collectFeeMode,
      lockedVesting,
      {
        feePercentage: 0,
        creatorFeePercentage: 0,
      }
    );

    const config = await createConfig(svm, program, {
      payer: partner,
      leftoverReceiver: partner.publicKey,
      feeClaimer: partner.publicKey,
      quoteMint,
      instructionParams,
    });

    const virtualPool = await createPoolWithSplToken(svm, program, {
      poolCreator,
      payer: operator,
      quoteMint,
      config,
      instructionParams: {
        name: "test token spl",
        symbol: "TEST",
        uri: "abc.com",
      },
    });

    return { config, instructionParams, quoteMint, virtualPool };
  }

  it("virtual_swap2 exact in advances virtual quote without quote transfer", async () => {
    const { config, instructionParams, virtualPool } =
      await createVirtualSwapFixture();
    let virtualPoolState = getVirtualPool(svm, program, virtualPool);
    const preQuoteVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;
    const preBaseReserve = virtualPoolState.baseReserve;
    const preSqrtPrice = virtualPoolState.sqrtPrice;
    const amountIn = instructionParams.migrationQuoteThreshold.divn(10);

    await virtualSwap2(svm, program, {
      config,
      payer: user,
      virtualSwapAuthority: operator,
      pool: virtualPool,
      amount0: amountIn,
      amount1: new BN(0),
      swapMode: SwapMode.ExactIn,
    });

    virtualPoolState = getVirtualPool(svm, program, virtualPool);
    const postQuoteVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;
    expect(postQuoteVaultBalance).eq(preQuoteVaultBalance);
    expect(virtualPoolState.quoteReserve.toString()).eq("0");
    expect(virtualPoolState.virtualQuoteReserve.gt(new BN(0))).to.be.true;
    expect(virtualPoolState.baseReserve.lt(preBaseReserve)).to.be.true;
    expect(virtualPoolState.sqrtPrice.gt(preSqrtPrice)).to.be.true;
  });

  it("virtual_swap2 partial fill can complete sale virtually", async () => {
    const { config, instructionParams, virtualPool } =
      await createVirtualSwapFixture();
    let virtualPoolState = getVirtualPool(svm, program, virtualPool);
    const preQuoteVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;
    const amountIn = instructionParams.migrationQuoteThreshold.muln(2);

    const result = await virtualSwap2(svm, program, {
      config,
      payer: user,
      virtualSwapAuthority: operator,
      pool: virtualPool,
      amount0: amountIn,
      amount1: new BN(0),
      swapMode: SwapMode.PartialFill,
    });

    virtualPoolState = getVirtualPool(svm, program, virtualPool);
    const postQuoteVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;
    expect(result.completed).to.be.true;
    expect(postQuoteVaultBalance).eq(preQuoteVaultBalance);
    expect(virtualPoolState.quoteReserve.toString()).eq("0");
    expect(virtualPoolState.virtualQuoteReserve.toString()).eq(
      instructionParams.migrationQuoteThreshold.toString()
    );
  });

  it("virtual_swap2 exact out sends requested base amount", async () => {
    const { config, virtualPool } = await createVirtualSwapFixture();
    const virtualPoolState = getVirtualPool(svm, program, virtualPool);
    const preQuoteVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;
    const outAmount = virtualPoolState.baseReserve.divn(100);

    await virtualSwap2(svm, program, {
      config,
      payer: user,
      virtualSwapAuthority: operator,
      pool: virtualPool,
      amount0: outAmount,
      amount1: U64_MAX,
      swapMode: SwapMode.ExactOut,
    });

    const userOutTokenAccount = getAssociatedTokenAddressSync(
      virtualPoolState.baseMint,
      user.publicKey,
      false
    );
    const userOutRawTokenAccount = svm.getAccount(userOutTokenAccount);
    const userOutTokenBal = unpackAccount(
      userOutTokenAccount,
      // @ts-expect-error
      userOutRawTokenAccount
    ).amount;
    const postPoolState = getVirtualPool(svm, program, virtualPool);
    const postQuoteVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;

    expect(new BN(userOutTokenBal.toString()).eq(outAmount)).to.be.true;
    expect(postQuoteVaultBalance).eq(preQuoteVaultBalance);
    expect(postPoolState.quoteReserve.toString()).eq("0");
    expect(postPoolState.virtualQuoteReserve.gt(new BN(0))).to.be.true;
  });

  it("virtual_swap2 does not accrue on-chain quote fees in quote fee mode", async () => {
    const { config, instructionParams, virtualPool } =
      await createVirtualSwapFixture(0);
    const virtualPoolState = getVirtualPool(svm, program, virtualPool);

    await virtualSwap2(svm, program, {
      config,
      payer: user,
      virtualSwapAuthority: operator,
      pool: virtualPool,
      amount0: instructionParams.migrationQuoteThreshold.divn(10),
      amount1: new BN(0),
      swapMode: SwapMode.ExactIn,
    });

    const postPoolState = getVirtualPool(svm, program, virtualPool);
    expect(postPoolState.quoteReserve.toString()).eq("0");
    expect(postPoolState.virtualQuoteReserve.gt(new BN(0))).to.be.true;
    expect(postPoolState.partnerQuoteFee.toString()).eq("0");
    expect(postPoolState.protocolQuoteFee.toString()).eq("0");
    expect(postPoolState.creatorQuoteFee.toString()).eq("0");
    expect(
      (getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0).toString()
    ).eq("0");
  });

  it("mixed real and virtual completion migrates with real quote only at the current curve price", async () => {
    const { config, instructionParams, quoteMint, virtualPool } =
      await createVirtualSwapFixture(1, 1);
    let virtualPoolState = getVirtualPool(svm, program, virtualPool);
    const realQuoteAmount = instructionParams.migrationQuoteThreshold.divn(2);

    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      realQuoteAmount.toNumber()
    );

    await swap2(svm, program, {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: quoteMint,
      outputTokenMint: virtualPoolState.baseMint,
      amount0: realQuoteAmount,
      amount1: new BN(0),
      referralTokenAccount: null,
      swapMode: SwapMode.ExactIn,
    });

    await virtualSwap2(svm, program, {
      config,
      payer: user,
      virtualSwapAuthority: operator,
      pool: virtualPool,
      amount0: instructionParams.migrationQuoteThreshold,
      amount1: new BN(0),
      swapMode: SwapMode.PartialFill,
    });

    virtualPoolState = getVirtualPool(svm, program, virtualPool);
    const beforeMigrationSqrtPrice = virtualPoolState.sqrtPrice;
    const beforeMigrationQuoteVaultBalance =
      getTokenAccount(svm, virtualPoolState.quoteVault).amount ?? 0;

    expect(virtualPoolState.quoteReserve.toString()).eq(
      realQuoteAmount.toString()
    );
    expect(virtualPoolState.virtualQuoteReserve.toString()).eq(
      instructionParams.migrationQuoteThreshold.sub(realQuoteAmount).toString()
    );
    expect(beforeMigrationQuoteVaultBalance.toString()).eq(
      realQuoteAmount.toString()
    );

    await createMeteoraDammV2Metadata(svm, program, {
      payer: admin,
      virtualPool,
      config,
    });
    const { dammPool } = await migrateToDammV2(svm, program, {
      payer: admin,
      virtualPool,
      dammConfig: dammV2Config,
    });

    const migratedPoolState = getDammV2Pool(svm, dammPool);
    expect(migratedPoolState.sqrtPrice.toString()).eq(
      beforeMigrationSqrtPrice.toString()
    );
    expect(getVirtualPool(svm, program, virtualPool).isMigrated).eq(1);
  });

  it("all-virtual completion rejects migration because no real quote funds liquidity", async () => {
    const { config, instructionParams, virtualPool } =
      await createVirtualSwapFixture(1, 1);
    await virtualSwap2(svm, program, {
      config,
      payer: user,
      virtualSwapAuthority: operator,
      pool: virtualPool,
      amount0: instructionParams.migrationQuoteThreshold.muln(2),
      amount1: new BN(0),
      swapMode: SwapMode.PartialFill,
    });

    const virtualPoolState = getVirtualPool(svm, program, virtualPool);
    expect(virtualPoolState.quoteReserve.toString()).eq("0");
    expect(virtualPoolState.virtualQuoteReserve.toString()).eq(
      instructionParams.migrationQuoteThreshold.toString()
    );

    await createMeteoraDammV2Metadata(svm, program, {
      payer: admin,
      virtualPool,
      config,
    });
    await expectThrowsAsync(async () => {
      await migrateToDammV2(svm, program, {
        payer: admin,
        virtualPool,
        dammConfig: dammV2Config,
      });
    }, getDbcProgramErrorCodeHexString("InsufficientLiquidityForMigration"));
  });

  it("virtual completion prevents later real swap funding", async () => {
    const { config, instructionParams, quoteMint, virtualPool } =
      await createVirtualSwapFixture();
    let virtualPoolState = getVirtualPool(svm, program, virtualPool);

    await virtualSwap2(svm, program, {
      config,
      payer: user,
      virtualSwapAuthority: operator,
      pool: virtualPool,
      amount0: instructionParams.migrationQuoteThreshold.muln(2),
      amount1: new BN(0),
      swapMode: SwapMode.PartialFill,
    });

    virtualPoolState = getVirtualPool(svm, program, virtualPool);
    expect(virtualPoolState.quoteReserve.toString()).eq("0");
    expect(virtualPoolState.virtualQuoteReserve.toString()).eq(
      instructionParams.migrationQuoteThreshold.toString()
    );

    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      instructionParams.migrationQuoteThreshold.toNumber()
    );

    await expectThrowsAsync(async () => {
      await swap2(svm, program, {
        config,
        payer: user,
        pool: virtualPool,
        inputTokenMint: quoteMint,
        outputTokenMint: virtualPoolState.baseMint,
        amount0: instructionParams.migrationQuoteThreshold,
        amount1: new BN(0),
        referralTokenAccount: null,
        swapMode: SwapMode.ExactIn,
      });
    }, getDbcProgramErrorCodeHexString("PoolIsCompleted"));
  });
});
