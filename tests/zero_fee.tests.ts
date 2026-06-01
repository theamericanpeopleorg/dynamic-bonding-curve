import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { BN } from "bn.js";
import { expect } from "chai";
import {
  BaseFee,
  claimProtocolFee,
  ConfigParameters,
  createConfig,
  CreateConfigParams,
  createOperatorAccount,
  createPoolWithSplToken,
  OperatorPermission,
  swap,
  SwapMode,
  SwapParams,
} from "./instructions";
import {
  createDammV2Config,
  createDammV2Operator,
  createVirtualCurveProgram,
  DammV2OperatorPermission,
  derivePoolAuthority,
  encodePermissions,
  generateAndFund,
  getTokenAccount,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  startSvm,
  U64_MAX,
} from "./utils";
import { getVirtualPool } from "./utils/fetcher";
import { Pool, VirtualCurveProgram } from "./utils/types";

import { LiteSVM } from "litesvm";
import {
  createMeteoraDammV2Metadata,
  MigrateMeteoraDammV2Params,
  migrateToDammV2,
} from "./instructions/dammV2Migration";

// Covers the zero-fee bonding curve path end-to-end:
// cliffFeeNumerator = 0 on the bonding curve and
// PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS = 0 (set in program constants).
describe("Zero fee bonding curve + zero migration protocol fee", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let operator: Keypair;
  let partner: Keypair;
  let user: Keypair;
  let poolCreator: Keypair;
  let program: VirtualCurveProgram;
  let config: PublicKey;
  let virtualPool: PublicKey;
  let virtualPoolState: Pool;
  let dammConfig: PublicKey;

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
  });

  it("Admin create operator account", async () => {
    await createOperatorAccount(svm, program, {
      admin,
      whitelistedAddress: operator.publicKey,
      permissions: [OperatorPermission.ClaimProtocolFee],
    });
  });

  it("Partner create config with zero base fee", async () => {
    const baseFee: BaseFee = {
      cliffFeeNumerator: new BN(0),
      firstFactor: 0,
      secondFactor: new BN(0),
      thirdFactor: new BN(0),
      baseFeeMode: 0,
    };

    const curves = [];
    for (let i = 1; i <= 16; i++) {
      if (i == 16) {
        curves.push({
          sqrtPrice: MAX_SQRT_PRICE,
          liquidity: U64_MAX.shln(30 + i),
        });
      } else {
        curves.push({
          sqrtPrice: MAX_SQRT_PRICE.muln(i * 5).divn(100),
          liquidity: U64_MAX.shln(30 + i),
        });
      }
    }

    const instructionParams: ConfigParameters = {
      poolFees: { baseFee, dynamicFee: null },
      activationType: 0,
      collectFeeMode: 0,
      migrationOption: 1,
      tokenType: 0,
      tokenDecimal: 6,
      migrationQuoteThreshold: new BN(LAMPORTS_PER_SOL * 5),
      partnerLiquidityPercentage: 20,
      creatorLiquidityPercentage: 20,
      partnerPermanentLockedLiquidityPercentage: 55,
      creatorPermanentLockedLiquidityPercentage: 5,
      sqrtStartPrice: MIN_SQRT_PRICE.shln(32),
      lockedVesting: {
        amountPerPeriod: new BN(0),
        cliffDurationFromMigrationTime: new BN(0),
        frequency: new BN(0),
        numberOfPeriod: new BN(0),
        cliffUnlockAmount: new BN(0),
      },
      migrationFeeOption: 0,
      tokenSupply: null,
      creatorTradingFeePercentage: 0,
      tokenUpdateAuthority: 0,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 },
      creatorLiquidityVestingInfo: {
        vestingPercentage: 0,
        cliffDurationFromMigrationTime: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        frequency: 0,
      },
      partnerLiquidityVestingInfo: {
        vestingPercentage: 0,
        cliffDurationFromMigrationTime: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        frequency: 0,
      },
      poolCreationFee: new BN(0),
      curve: curves,
      enableFirstSwapWithMinFee: false,
      compoundingFeeBps: 0,
      migratedPoolBaseFeeMode: 0,
      migratedPoolMarketCapFeeSchedulerParams: null,
    };
    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      leftoverReceiver: partner.publicKey,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams,
    };
    config = await createConfig(svm, program, params);
  });

  it("Create spl pool from config", async () => {
    virtualPool = await createPoolWithSplToken(svm, program, {
      poolCreator,
      payer: operator,
      quoteMint: NATIVE_MINT,
      config,
      instructionParams: {
        name: "test token spl",
        symbol: "TEST",
        uri: "abc.com",
      },
    });
    virtualPoolState = getVirtualPool(svm, program, virtualPool);
    expect(virtualPoolState.protocolLiquidityMigrationFeeBps).eq(0);
  });

  it("Swap charges zero fees", async () => {
    const preQuoteTradingFee = virtualPoolState.partnerQuoteFee;
    const preQuoteProtocolFee = virtualPoolState.protocolQuoteFee;

    const params: SwapParams = {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: virtualPoolState.baseMint,
      amountIn: new BN(LAMPORTS_PER_SOL * 5.5),
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    };
    await swap(svm, program, params);

    virtualPoolState = getVirtualPool(svm, program, virtualPool);

    expect(
      virtualPoolState.partnerQuoteFee.sub(preQuoteTradingFee).toString()
    ).eq("0");
    expect(
      virtualPoolState.protocolQuoteFee.sub(preQuoteProtocolFee).toString()
    ).eq("0");
    expect(virtualPoolState.partnerBaseFee.toString()).eq("0");
    expect(virtualPoolState.protocolBaseFee.toString()).eq("0");
  });

  it("Create meteora damm v2 metadata", async () => {
    await createMeteoraDammV2Metadata(svm, program, {
      payer: admin,
      virtualPool,
      config,
    });
  });

  it("Migrate to Meteora Damm V2 Pool (zero protocol migration fee)", async () => {
    const poolAuthority = derivePoolAuthority();
    dammConfig = await createDammV2Config(svm, admin, poolAuthority, 1);
    const migrationParams: MigrateMeteoraDammV2Params = {
      payer: admin,
      virtualPool,
      dammConfig,
    };
    await migrateToDammV2(svm, program, migrationParams);
  });

  it("Operator claim protocol fee", async () => {
    await claimProtocolFee(svm, program, {
      pool: virtualPool,
      operator: operator,
    });
  });
});
