import { BN } from "@anchor-lang/core";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { LiteSVM } from "litesvm";

import {
  createMeteoraDammV2Metadata,
  migrateToDammV2,
} from "./instructions/dammV2Migration";
import {
  ConfigParameters,
  createConfig,
  CreateConfigParams,
  createLocker,
  createPoolWithSplToken,
  creatorWithdrawMigrationFee,
  swap,
  SwapMode,
  SwapParams,
} from "./instructions";
import {
  createDammV2Config,
  createDammV2Operator,
  createDbcConfig,
  createVirtualCurveProgram,
  DammV2OperatorPermission,
  designCurve,
  derivePoolAuthority,
  encodePermissions,
  expectThrowsAsync,
  generateAndFund,
  startSvm,
} from "./utils";
import { getDammV2Pool, getVirtualPool } from "./utils/fetcher";
import { VirtualCurveProgram } from "./utils/types";

describe("Migration deadline", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let partner: Keypair;
  let poolCreator: Keypair;
  let user: Keypair;
  let program: VirtualCurveProgram;

  beforeEach(async () => {
    svm = startSvm();
    admin = generateAndFund(svm);
    partner = generateAndFund(svm);
    poolCreator = generateAndFund(svm);
    user = generateAndFund(svm);
    program = createVirtualCurveProgram();

    await createDammV2Operator(svm, {
      whitelistAddress: admin.publicKey,
      admin,
      permission: encodePermissions([DammV2OperatorPermission.CreateConfigKey]),
    });
  });

  it("rejects pool init when deadline timestamp is in the past", async () => {
    setUnixTimestamp(svm, 1000);
    const currentTimestamp = svm.getClock().unixTimestamp;
    const config = await createDbcConfig(
      svm,
      program,
      1,
      0,
      {
        poolFeeBps: 0,
        collectFeeMode: 0,
        dynamicFee: 0,
      },
      partner
    );

    await expectThrowsAsync(async () => {
      await createPoolWithSplToken(svm, program, {
        poolCreator,
        payer: poolCreator,
        quoteMint: NATIVE_MINT,
        config,
        instructionParams: {
          name: "past deadline",
          symbol: "PAST",
          uri: "abc.com",
          deadlineTimestamp: new BN((currentTimestamp - BigInt(1)).toString()),
        },
      });
    }, "deadline");
  });

  it("keeps below-threshold migration blocked before the deadline", async () => {
    const currentTimestamp = svm.getClock().unixTimestamp;
    const { config, virtualPool } = await createUnderfilledPool({
      deadlineTimestamp: new BN(
        (currentTimestamp + BigInt(1_000_000)).toString()
      ),
    });
    const dammConfig = await setupDammV2Migration(config, virtualPool);

    await expectThrowsAsync(async () => {
      await migrateToDammV2(svm, program, {
        payer: admin,
        virtualPool,
        dammConfig,
      });
    }, "not permit");
  });

  it("keeps deadline completion disabled when the timestamp is zero", async () => {
    const currentTimestamp = svm.getClock().unixTimestamp;
    const { config, virtualPool } = await createUnderfilledPool({
      deadlineTimestamp: new BN(0),
    });
    const dammConfig = await setupDammV2Migration(config, virtualPool);

    setUnixTimestamp(svm, Number(currentTimestamp + BigInt(1_000_000)));

    await expectThrowsAsync(async () => {
      await migrateToDammV2(svm, program, {
        payer: admin,
        virtualPool,
        dammConfig,
      });
    }, "not permit");
  });

  it("keeps target completion available before the deadline", async () => {
    const currentTimestamp = svm.getClock().unixTimestamp;
    const deadlineTimestamp = new BN(
      (currentTimestamp + BigInt(1_000_000)).toString()
    );
    const { config, virtualPool } = await createUnderfilledPool({
      deadlineTimestamp,
    });
    const poolState = getVirtualPool(svm, program, virtualPool);

    await swap(svm, program, {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: poolState.baseMint,
      amountIn: new BN(LAMPORTS_PER_SOL * 10),
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    });

    const dammConfig = await setupDammV2Migration(config, virtualPool);

    await migrateToDammV2(svm, program, {
      payer: admin,
      virtualPool,
      dammConfig,
    });

    const afterMigrationPool = getVirtualPool(svm, program, virtualPool);
    expect(afterMigrationPool.isMigrated).eq(1);
    expect(afterMigrationPool.finishCurveTimestamp.lt(deadlineTimestamp)).eq(
      true
    );
  });

  it("migrates below threshold after the deadline at the current curve price", async () => {
    const currentTimestamp = svm.getClock().unixTimestamp;
    const deadlineTimestamp = new BN(
      (currentTimestamp + BigInt(10)).toString()
    );
    const { config, virtualPool } = await createUnderfilledPool({
      deadlineTimestamp,
    });
    const beforeMigrationPool = getVirtualPool(svm, program, virtualPool);
    const dammConfig = await setupDammV2Migration(config, virtualPool);

    setUnixTimestamp(svm, Number(currentTimestamp + BigInt(11)));
    const { dammPool } = await migrateToDammV2(svm, program, {
      payer: admin,
      virtualPool,
      dammConfig,
    });

    const afterMigrationPool = getVirtualPool(svm, program, virtualPool);
    const dammPoolState = getDammV2Pool(svm, dammPool);
    expect(afterMigrationPool.isMigrated).eq(1);
    expect(afterMigrationPool.finishCurveTimestamp.toString()).eq(
      deadlineTimestamp.toString()
    );
    expect(dammPoolState.sqrtPrice.toString()).eq(
      beforeMigrationPool.sqrtPrice.toString()
    );
  });

  it("blocks below-threshold migration fee withdrawal until after deadline migration", async () => {
    const currentTimestamp = svm.getClock().unixTimestamp;
    const deadlineTimestamp = new BN(
      (currentTimestamp + BigInt(10)).toString()
    );
    const config = await createDeadlineConfig({
      migrationFee: {
        feePercentage: 10,
        creatorFeePercentage: 100,
      },
    });
    const { virtualPool } = await createUnderfilledPool({
      config,
      deadlineTimestamp,
    });
    const dammConfig = await setupDammV2Migration(config, virtualPool);

    setUnixTimestamp(svm, Number(currentTimestamp + BigInt(11)));

    await expectThrowsAsync(async () => {
      await creatorWithdrawMigrationFee(svm, program, {
        creator: poolCreator,
        virtualPool,
      });
    }, "not permit");

    await migrateToDammV2(svm, program, {
      payer: admin,
      virtualPool,
      dammConfig,
    });

    await creatorWithdrawMigrationFee(svm, program, {
      creator: poolCreator,
      virtualPool,
    });
  });

  it("keeps threshold-complete migration fee withdrawal available before migration", async () => {
    const currentTimestamp = svm.getClock().unixTimestamp;
    const deadlineTimestamp = new BN(
      (currentTimestamp + BigInt(1_000_000)).toString()
    );
    const config = await createDeadlineConfig({
      migrationFee: {
        feePercentage: 10,
        creatorFeePercentage: 100,
      },
    });
    const { virtualPool } = await createUnderfilledPool({
      config,
      deadlineTimestamp,
    });
    const poolState = getVirtualPool(svm, program, virtualPool);

    await swap(svm, program, {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: poolState.baseMint,
      amountIn: new BN(LAMPORTS_PER_SOL * 10),
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    });

    await creatorWithdrawMigrationFee(svm, program, {
      creator: poolCreator,
      virtualPool,
    });
  });

  it("blocks deadline locker creation without migration liquidity", async () => {
    const currentTimestamp = svm.getClock().unixTimestamp;
    const deadlineTimestamp = new BN(
      (currentTimestamp + BigInt(10)).toString()
    );
    const config = await createDeadlineConfig({
      lockedVesting: getLockedVestingParams(),
    });
    const { virtualPool } = await createUnderfilledPool({
      config,
      deadlineTimestamp,
      performSwap: false,
    });

    setUnixTimestamp(svm, Number(currentTimestamp + BigInt(11)));

    await expectThrowsAsync(async () => {
      await createLocker(svm, program, {
        payer: admin,
        virtualPool,
      });
    }, "insufficient");

    const poolState = getVirtualPool(svm, program, virtualPool);
    expect(poolState.migrationProgress).eq(0);
  });

  it("creates deadline locker when underfilled migration liquidity is valid", async () => {
    const currentTimestamp = svm.getClock().unixTimestamp;
    const deadlineTimestamp = new BN(
      (currentTimestamp + BigInt(10)).toString()
    );
    const config = await createDeadlineConfig({
      lockedVesting: getLockedVestingParams(),
    });
    const { virtualPool } = await createUnderfilledPool({
      config,
      deadlineTimestamp,
    });
    const dammConfig = await setupDammV2Migration(config, virtualPool);

    setUnixTimestamp(svm, Number(currentTimestamp + BigInt(11)));

    await createLocker(svm, program, {
      payer: admin,
      virtualPool,
    });

    const afterLockerPool = getVirtualPool(svm, program, virtualPool);
    expect(afterLockerPool.migrationProgress).eq(2);

    await migrateToDammV2(svm, program, {
      payer: admin,
      virtualPool,
      dammConfig,
    });

    const afterMigrationPool = getVirtualPool(svm, program, virtualPool);
    expect(afterMigrationPool.isMigrated).eq(1);
  });

  async function createUnderfilledPool(params: {
    config?: PublicKey;
    deadlineTimestamp: BN;
    performSwap?: boolean;
  }): Promise<{ config: PublicKey; virtualPool: PublicKey }> {
    const config =
      params.config ??
      (await createDbcConfig(
        svm,
        program,
        1,
        0,
        {
          poolFeeBps: 0,
          collectFeeMode: 0,
          dynamicFee: 0,
        },
        partner
      ));
    const virtualPool = await createPoolWithSplToken(svm, program, {
      poolCreator,
      payer: poolCreator,
      quoteMint: NATIVE_MINT,
      config,
      instructionParams: {
        name: "deadline token",
        symbol: "DEAD",
        uri: "abc.com",
        deadlineTimestamp: params.deadlineTimestamp,
      },
    });
    if (params.performSwap === false) {
      return { config, virtualPool };
    }

    const poolState = getVirtualPool(svm, program, virtualPool);
    const swapParams: SwapParams = {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: poolState.baseMint,
      amountIn: new BN(LAMPORTS_PER_SOL),
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    };
    await swap(svm, program, swapParams);

    return { config, virtualPool };
  }

  async function createDeadlineConfig(params?: {
    lockedVesting?: ReturnType<typeof getLockedVestingParams>;
    migrationFee?: {
      feePercentage: number;
      creatorFeePercentage: number;
    };
  }): Promise<PublicKey> {
    const instructionParams = designCurve(
      1_000_000_000,
      0.9,
      5,
      1,
      6,
      9,
      0,
      1,
      params?.lockedVesting ?? getZeroLockedVestingParams(),
      params?.migrationFee ?? {
        feePercentage: 0,
        creatorFeePercentage: 0,
      }
    );
    const createConfigParams: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      leftoverReceiver: partner.publicKey,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams,
    };

    return createConfig(svm, program, createConfigParams);
  }

  async function setupDammV2Migration(
    config: PublicKey,
    virtualPool: PublicKey
  ): Promise<PublicKey> {
    await createMeteoraDammV2Metadata(svm, program, {
      payer: admin,
      virtualPool,
      config,
    });
    return createDammV2Config(svm, admin, derivePoolAuthority(), 1);
  }
});

function getZeroLockedVestingParams() {
  return {
    amountPerPeriod: new BN(0),
    cliffDurationFromMigrationTime: new BN(0),
    frequency: new BN(0),
    numberOfPeriod: new BN(0),
    cliffUnlockAmount: new BN(0),
  };
}

function getLockedVestingParams() {
  return {
    amountPerPeriod: new BN(1_000_000),
    cliffDurationFromMigrationTime: new BN(0),
    frequency: new BN(1),
    numberOfPeriod: new BN(10),
    cliffUnlockAmount: new BN(1_000_000),
  };
}

function setUnixTimestamp(svm: LiteSVM, unixTimestamp: number) {
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(unixTimestamp);
  svm.setClock(clock);
}
