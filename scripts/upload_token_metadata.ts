/// <reference types="node" />

import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { createInterface } from "readline";
import {
  createGenericFile,
  createSignerFromKeypair,
  signerIdentity,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";

const DEFAULT_RPC_URL =
  process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const DEFAULT_KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ?? path.join(homedir(), ".config/solana/id.json");

type CliArgs = {
  imagePath?: string;
  metadataPath?: string;
  keypairPath: string;
  rpcUrl: string;
  contentType?: string;
  outPath?: string;
  yes: boolean;
};

type TokenMetadata = Record<string, unknown> & {
  image?: string;
};

function usage() {
  console.log(`Usage:
  bun scripts/upload_token_metadata.ts --image <PATH> --metadata <PATH> [--out <PATH>]

Options:
  --image <PATH>         Image/logo file to upload first
  --metadata <PATH>      Local metadata JSON file to upload after image is set
  --out <PATH>           Optional path to write the final JSON with the Irys image URL
  --content-type <TYPE>  Optional image MIME type override
  --rpc-url <URL>        Defaults to RPC_URL or ${DEFAULT_RPC_URL}
  --keypair <PATH>       Defaults to KEYPAIR_PATH or ${DEFAULT_KEYPAIR_PATH}
  --yes                  Skip confirmation prompt

Output:
  Prints imageUri and metadataUri. Use metadataUri as the DBC pool uri.
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    keypairPath: DEFAULT_KEYPAIR_PATH,
    rpcUrl: DEFAULT_RPC_URL,
    yes: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = (name: string) => {
      const value = argv[++i];
      if (!value) {
        throw new Error(`${name} requires a value`);
      }
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--image") {
      args.imagePath = readValue("--image");
      continue;
    }
    if (arg.startsWith("--image=")) {
      args.imagePath = arg.slice("--image=".length);
      continue;
    }
    if (arg === "--metadata") {
      args.metadataPath = readValue("--metadata");
      continue;
    }
    if (arg.startsWith("--metadata=")) {
      args.metadataPath = arg.slice("--metadata=".length);
      continue;
    }
    if (arg === "--out") {
      args.outPath = readValue("--out");
      continue;
    }
    if (arg.startsWith("--out=")) {
      args.outPath = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--content-type") {
      args.contentType = readValue("--content-type");
      continue;
    }
    if (arg.startsWith("--content-type=")) {
      args.contentType = arg.slice("--content-type=".length);
      continue;
    }
    if (arg === "--rpc-url") {
      args.rpcUrl = readValue("--rpc-url");
      continue;
    }
    if (arg.startsWith("--rpc-url=")) {
      args.rpcUrl = arg.slice("--rpc-url=".length);
      continue;
    }
    if (arg === "--keypair") {
      args.keypairPath = readValue("--keypair");
      continue;
    }
    if (arg.startsWith("--keypair=")) {
      args.keypairPath = arg.slice("--keypair=".length);
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      args.yes = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.imagePath) {
    throw new Error("--image is required");
  }
  if (!args.metadataPath) {
    throw new Error("--metadata is required");
  }

  return args;
}

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function loadKeypair(pathname: string): Uint8Array {
  const bytes = JSON.parse(readFileSync(pathname, "utf8"));
  if (!Array.isArray(bytes)) {
    throw new Error(`keypair must be a JSON array: ${pathname}`);
  }
  return Uint8Array.from(bytes);
}

function loadMetadata(pathname: string): TokenMetadata {
  const metadata = JSON.parse(readFileSync(pathname, "utf8"));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`metadata must be a JSON object: ${pathname}`);
  }
  validateMetadata(metadata, pathname);
  return metadata;
}

function validateMetadata(metadata: TokenMetadata, pathname: string) {
  const requiredStringFields = ["name", "symbol", "description"];
  for (const field of requiredStringFields) {
    const value = metadata[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${pathname}: ${field} must be a non-empty string`);
    }
  }

  const name = metadata.name as string;
  const symbol = metadata.symbol as string;
  if (name.length > 32) {
    throw new Error(`${pathname}: name must be 32 characters or fewer`);
  }
  if (symbol.length > 10) {
    throw new Error(`${pathname}: symbol must be 10 characters or fewer`);
  }
  if (
    metadata.image !== undefined &&
    (typeof metadata.image !== "string" || metadata.image.trim().length === 0)
  ) {
    throw new Error(`${pathname}: image must be a non-empty string when set`);
  }
}

function askForConfirmation(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const imagePath = path.resolve(args.imagePath!);
  const metadataPath = path.resolve(args.metadataPath!);
  const contentType = args.contentType ?? inferContentType(imagePath);
  const metadata = loadMetadata(metadataPath);
  const metadataPreview = {
    ...metadata,
    image:
      typeof metadata.image === "string" && metadata.image.trim().length > 0
        ? metadata.image
        : "<will be replaced with uploaded Irys image URI>",
  };

  console.error("Loaded metadata JSON:");
  console.error(JSON.stringify(metadataPreview, null, 2));
  console.error(`Image file: ${imagePath}`);
  console.error(`Image content type: ${contentType}`);

  if (!args.yes) {
    const confirmed = await askForConfirmation(
      "Upload this image and metadata to Irys? [y/N] "
    );
    if (!confirmed) {
      console.error("Upload cancelled.");
      return;
    }
  }

  const umi = createUmi(args.rpcUrl);
  const keypair = umi.eddsa.createKeypairFromSecretKey(
    loadKeypair(path.resolve(args.keypairPath))
  );
  const signer = createSignerFromKeypair(umi, keypair);

  umi.use(signerIdentity(signer));
  umi.use(irysUploader());

  const imageFile = createGenericFile(
    readFileSync(imagePath),
    path.basename(imagePath),
    { contentType }
  );

  console.error(`Uploading image as ${contentType} from ${imagePath}`);
  const [imageUri] = await umi.uploader.upload([imageFile]);

  metadata.image = imageUri;

  if (args.outPath) {
    writeFileSync(
      path.resolve(args.outPath),
      `${JSON.stringify(metadata, null, 2)}\n`
    );
  }

  console.error(`Uploading metadata from ${metadataPath}`);
  const metadataUri = await umi.uploader.uploadJson(metadata);

  console.log(
    JSON.stringify(
      {
        imageUri,
        metadataUri,
        payer: signer.publicKey.toString(),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
