import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey, Keypair, SystemProgram, Transaction, Connection,
  ComputeBudgetProgram, SYSVAR_INSTRUCTIONS_PUBKEY, sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { StateUpdate, toAnchorArg, signState, cosignIxs, serializeState } from "./state";

export const SEEDS = {
  config: () => [Buffer.from("config")],
  feeVault: () => [Buffer.from("fee_vault")],
  node: (asset: PublicKey) => [Buffer.from("node"), asset.toBuffer()],
  session: (node: PublicKey, consumer: PublicKey, seed: BN) =>
    [Buffer.from("session"), node.toBuffer(), consumer.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
};

export function pda(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export class SolMesh {
  constructor(public program: Program, public connection: Connection) {}

  get programId() { return this.program.programId; }
  configPda() { return pda(SEEDS.config(), this.programId); }
  feeVaultPda() { return pda(SEEDS.feeVault(), this.programId); }
  nodePda(asset: PublicKey) { return pda(SEEDS.node(asset), this.programId); }
  sessionPda(node: PublicKey, consumer: PublicKey, seed: BN) { return pda(SEEDS.session(node, consumer, seed), this.programId); }

  async initializeConfig(authority: Keypair, feeBps: number, challengeWindowSecs: number, mplCore: PublicKey) {
    return this.program.methods
      .initializeConfig(feeBps, new BN(challengeWindowSecs), mplCore)
      .accounts({
        config: this.configPda(),
        feeVault: this.feeVaultPda(),
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
  }

  async registerNode(provider: Keypair, asset: Keypair, args: { name: string; uri: string; capacity: number; geo: string; initReputation?: number }, mplCore: PublicKey) {
    return this.program.methods
      .registerNode(args.name, args.uri, new BN(args.capacity), args.geo, args.initReputation ?? 0)
      .accounts({
        config: this.configPda(),
        node: this.nodePda(asset.publicKey),
        asset: asset.publicKey,
        provider: provider.publicKey,
        mplCoreProgram: mplCore,
        systemProgram: SystemProgram.programId,
      })
      .signers([provider, asset])
      .rpc();
  }

  async openSession(consumer: Keypair, node: PublicKey, seed: BN, amount: BN, durationSecs: number, ratePerUnit: BN) {
    return this.program.methods
      .openSession(seed, amount, new BN(durationSecs), ratePerUnit)
      .accounts({
        config: this.configPda(),
        node,
        session: this.sessionPda(node, consumer.publicKey, seed),
        consumer: consumer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([consumer])
      .rpc();
  }

  /** Build settle or checkpoint tx with the two ed25519 precompile ixs prepended. */
  async settle(opts: {
    payer: Keypair;
    node: PublicKey;
    asset: PublicKey;
    provider: PublicKey;
    consumer: PublicKey;
    session: PublicKey;
    mplCore: PublicKey;
    state: StateUpdate;
    providerSig: Uint8Array;
    consumerSig: Uint8Array;
    checkpoint?: boolean;
  }) {
    const ixs = cosignIxs(
      opts.state,
      { publicKey: opts.provider, sig: opts.providerSig },
      { publicKey: opts.consumer, sig: opts.consumerSig }
    );
    const method = opts.checkpoint ? this.program.methods.checkpointSettle : this.program.methods.settleSession;
    const settleIx = await method(toAnchorArg(opts.state))
      .accounts({
        config: this.configPda(),
        node: opts.node,
        session: opts.session,
        provider: opts.provider,
        consumer: opts.consumer,
        asset: opts.asset,
        feeVault: this.feeVaultPda(),
        payer: opts.payer.publicKey,
        mplCoreProgram: opts.mplCore,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(...ixs)
      .add(settleIx);
    return sendAndConfirmTransaction(this.connection, tx, [opts.payer]);
  }

  /** initiate_unilateral_close OR challenge — both take a co-signed state + 2 ed25519 ixs. */
  private async cosignedClose(
    method: "initiateUnilateralClose" | "challenge",
    opts: {
      caller: Keypair; provider: PublicKey; consumer: PublicKey; session: PublicKey;
      state: StateUpdate; providerSig: Uint8Array; consumerSig: Uint8Array;
    }
  ) {
    const ixs = cosignIxs(
      opts.state,
      { publicKey: opts.provider, sig: opts.providerSig },
      { publicKey: opts.consumer, sig: opts.consumerSig }
    );
    const ix = await (this.program.methods as any)[method](toAnchorArg(opts.state))
      .accounts({
        config: this.configPda(),
        session: opts.session,
        provider: opts.provider,
        consumer: opts.consumer,
        caller: opts.caller.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    const tx = new Transaction().add(...ixs).add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [opts.caller]);
  }

  initiateUnilateralClose(opts: Parameters<SolMesh["cosignedClose"]>[1]) { return this.cosignedClose("initiateUnilateralClose", opts); }
  challenge(opts: Parameters<SolMesh["cosignedClose"]>[1]) { return this.cosignedClose("challenge", opts); }

  async finalizeClose(opts: { payer: Keypair; node: PublicKey; asset: PublicKey; provider: PublicKey; consumer: PublicKey; session: PublicKey; mplCore: PublicKey }) {
    return this.program.methods.finalizeClose()
      .accounts({
        config: this.configPda(), node: opts.node, session: opts.session,
        provider: opts.provider, consumer: opts.consumer, asset: opts.asset,
        feeVault: this.feeVaultPda(), payer: opts.payer.publicKey,
        mplCoreProgram: opts.mplCore, systemProgram: SystemProgram.programId,
      })
      .signers([opts.payer]).rpc();
  }

  async cancelSession(consumer: Keypair, session: PublicKey) {
    return this.program.methods.cancelSession()
      .accounts({ config: this.configPda(), session, consumer: consumer.publicKey })
      .signers([consumer]).rpc();
  }

  async expireSession(cranker: Keypair, session: PublicKey, consumer: PublicKey) {
    return this.program.methods.expireSession()
      .accounts({ config: this.configPda(), session, consumer, cranker: cranker.publicKey })
      .signers([cranker]).rpc();
  }

  // -------------------------------------------------------------- SPL / USDC path (M8)
  vaultAuthority(session: PublicKey) { return pda([Buffer.from("vault"), session.toBuffer()], this.programId); }

  async openSessionSpl(opts: {
    consumer: Keypair; node: PublicKey; seed: BN; mint: PublicKey; amount: BN; durationSecs: number; ratePerUnit: BN;
    consumerToken: PublicKey; tokenProgram: PublicKey; associatedTokenProgram: PublicKey;
  }) {
    const session = this.sessionPda(opts.node, opts.consumer.publicKey, opts.seed);
    const vaultAuthority = this.vaultAuthority(session);
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const vaultToken = getAssociatedTokenAddressSync(opts.mint, vaultAuthority, true, opts.tokenProgram, opts.associatedTokenProgram);
    return this.program.methods
      .openSessionSpl(opts.seed, opts.amount, new BN(opts.durationSecs), opts.ratePerUnit)
      .accounts({
        config: this.configPda(), node: opts.node, session, mint: opts.mint,
        consumerToken: opts.consumerToken, vaultAuthority, vaultToken,
        consumer: opts.consumer.publicKey, tokenProgram: opts.tokenProgram,
        associatedTokenProgram: opts.associatedTokenProgram, systemProgram: SystemProgram.programId,
      })
      .signers([opts.consumer]).rpc();
  }

  async settleSpl(opts: {
    payer: Keypair; node: PublicKey; asset: PublicKey; provider: PublicKey; consumer: PublicKey; session: PublicKey;
    mint: PublicKey; mplCore: PublicKey; state: StateUpdate; providerSig: Uint8Array; consumerSig: Uint8Array;
    vaultToken: PublicKey; providerToken: PublicKey; consumerToken: PublicKey; feeToken: PublicKey;
    tokenProgram: PublicKey; checkpoint?: boolean;
  }) {
    const ixs = cosignIxs(opts.state, { publicKey: opts.provider, sig: opts.providerSig }, { publicKey: opts.consumer, sig: opts.consumerSig });
    const method = opts.checkpoint ? this.program.methods.checkpointSettleSpl : this.program.methods.settleSessionSpl;
    const settleIx = await method(toAnchorArg(opts.state))
      .accounts({
        config: this.configPda(), node: opts.node, session: opts.session,
        provider: opts.provider, consumer: opts.consumer, asset: opts.asset,
        vaultAuthority: this.vaultAuthority(opts.session), vaultToken: opts.vaultToken,
        providerToken: opts.providerToken, consumerToken: opts.consumerToken, feeToken: opts.feeToken,
        payer: opts.payer.publicKey, mplCoreProgram: opts.mplCore,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: opts.tokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(...ixs).add(settleIx);
    return sendAndConfirmTransaction(this.connection, tx, [opts.payer]);
  }

  async updateNodeMeta(opts: { provider: Keypair; node: PublicKey; asset: PublicKey; mplCore: PublicKey; capacity?: number; geo?: string; active?: boolean; }) {
    return this.program.methods
      .updateNodeMeta(
        opts.capacity != null ? new BN(opts.capacity) : null,
        opts.geo ?? null,
        opts.active ?? null
      )
      .accounts({
        config: this.configPda(),
        node: opts.node,
        asset: opts.asset,
        payer: opts.provider.publicKey,
        provider: opts.provider.publicKey,
        mplCoreProgram: opts.mplCore,
        systemProgram: SystemProgram.programId,
      })
      .signers([opts.provider])
      .rpc();
  }

  async fetchSession(session: PublicKey) { return this.program.account.session.fetch(session); }
  async fetchNode(node: PublicKey) { return this.program.account.node.fetch(node); }
}

export { StateUpdate, signState, serializeState };
