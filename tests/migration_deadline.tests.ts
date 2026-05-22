import { BN } from "@coral-xyz/anchor";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { LiteSVM } from "litesvm";

import {
  createMeteoraDammV2Metadata,
  migrateToDammV2,
} from "./instructions/dammV2Migration";
import {
  createPoolWithSplToken,
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

  async function createUnderfilledPool(params: {
    deadlineTimestamp: BN;
  }): Promise<{ config: PublicKey; virtualPool: PublicKey }> {
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

function setUnixTimestamp(svm: LiteSVM, unixTimestamp: number) {
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(unixTimestamp);
  svm.setClock(clock);
}
