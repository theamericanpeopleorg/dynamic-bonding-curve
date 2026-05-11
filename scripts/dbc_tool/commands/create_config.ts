import { Keypair } from "@solana/web3.js";
import {
  buildClient,
  buildMschfCurveConfig,
  loadKeypair,
  MAINNET_USDC_MINT,
  simulateAndSend,
  type CreateConfigOptions,
  type CreateConfigResult,
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
    .createConfig(buildMschfCurveConfig())
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
