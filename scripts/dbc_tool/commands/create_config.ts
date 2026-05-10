import { Keypair } from "@solana/web3.js";
import {
  buildClient,
  buildDefaultCurveConfig,
  loadKeypair,
  MAINNET_USDC_MINT,
  simulateAndSend,
  type BuyOptions,
  type BuyResult,
  type CreateConfigOptions,
  type CreateConfigResult,
  type CreatePoolOptions,
  type CreatePoolResult,
  type PoolInfoOptions,
  type PoolInfoResult,
} from "../shared";

export async function createConfig(
  options: CreateConfigOptions = {}
): Promise<CreateConfigResult> {
  const { connection, program } = await buildClient(options.rpcUrl);
  const payer = options.payer ?? loadKeypair();
  const config = options.config ?? Keypair.generate();
  const feeClaimer = options.feeClaimer ?? payer.publicKey;
  const leftoverReceiver = options.leftoverReceiver ?? payer.publicKey;
  const quoteMint = options.quoteMint ?? MAINNET_USDC_MINT;

  const transaction = await program.methods
    .createConfig(buildDefaultCurveConfig())
    .accountsPartial({
      payer: payer.publicKey,
      config: config.publicKey,
      feeClaimer,
      leftoverReceiver,
      quoteMint,
    })
    .transaction();

  const signature = await simulateAndSend(connection, transaction, [
    payer,
    config,
  ]);

  return {
    config: config.publicKey,
    quoteMint,
    signature,
  };
}
