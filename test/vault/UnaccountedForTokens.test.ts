import { ethers } from 'hardhat';
import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { TokenList, deployTokens, mintTokens } from '../helpers/tokens';
import { deploy } from '../../scripts/helpers/deploy';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { createPool, PairTS, setupPool } from '../../scripts/helpers/pools';
import { MAX_UINT256 } from '../helpers/constants';
import { SwapIn } from '../../scripts/helpers/trading';
import { expectBalanceChange } from '../helpers/tokenBalance';

describe('Vault - unaccounted for tokens', () => {
  let admin: SignerWithAddress;
  let trader: SignerWithAddress;
  let controller: SignerWithAddress;
  let recipient: SignerWithAddress;
  let other: SignerWithAddress;

  let vault: Contract;
  let tokens: TokenList = {};

  before('setup', async () => {
    [, admin, trader, controller, recipient, other] = await ethers.getSigners();
  });

  beforeEach(async () => {
    vault = await deploy('Vault', { from: admin, args: [admin.address] });
    tokens = await deployTokens(['DAI', 'MKR'], [18, 18]);

    for (const symbol in tokens) {
      await mintTokens(tokens, symbol, controller, 100e18);
      await tokens[symbol].connect(controller).approve(vault.address, MAX_UINT256);

      await mintTokens(tokens, symbol, trader, 100e18);
      await tokens[symbol].connect(trader).approve(vault.address, MAX_UINT256);

      await mintTokens(tokens, symbol, other, 100e18);
    }
  });

  it('initially is zero', async () => {
    expect(await vault.getTotalUnaccountedForTokens(tokens.DAI.address)).to.equal(0);
  });

  it('transfers increase unaccounted for balance for that token', async () => {
    await tokens.DAI.connect(other).transfer(vault.address, (1e18).toString());

    expect(await vault.getTotalUnaccountedForTokens(tokens.DAI.address)).to.equal((1e18).toString());
    expect(await vault.getTotalUnaccountedForTokens(tokens.MKR.address)).to.equal(0);
  });

  context('with pool', () => {
    let poolId: string;

    beforeEach(async () => {
      const strategy = await deploy('MockTradingStrategy', { args: [] });
      poolId = await createPool(vault, strategy, PairTS, controller);
    });

    it('adding liquidity does not alter unaccounted for balance', async () => {
      await tokens.DAI.connect(other).transfer(vault.address, (1e18).toString());

      await vault
        .connect(controller)
        .addLiquidity(
          poolId,
          controller.address,
          [tokens.DAI.address, tokens.MKR.address],
          [(2e18).toString(), (2e18).toString()],
          false
        );

      await tokens.DAI.connect(other).transfer(vault.address, (0.5e18).toString());

      expect(await vault.getTotalUnaccountedForTokens(tokens.DAI.address)).to.equal((1.5e18).toString());
      expect(await vault.getTotalUnaccountedForTokens(tokens.MKR.address)).to.equal(0);
    });
  });

  context('with funded pool', () => {
    let poolId: string;

    beforeEach(async () => {
      const strategy = await deploy('MockTradingStrategy', { args: [] });
      poolId = await setupPool(vault, strategy, PairTS, tokens, controller, [
        ['DAI', (2e18).toString()],
        ['MKR', (2e18).toString()],
      ]);
    });

    // TODO: fix, they actually do alter unaccounted for balance, but only as a percentage of the trading strategy fees
    // (the mock strategy used here charges no fees)
    it.skip('swaps do not alter unaccounted for balance', async () => {
      await tokens.DAI.connect(other).transfer(vault.address, (1e18).toString());

      const tokenAddresses = [tokens.DAI.address, tokens.MKR.address];
      const swaps: SwapIn[] = [
        {
          poolId,
          tokenInIndex: 0,
          tokenOutIndex: 1,
          amountIn: 500,
          userData: '0x',
        },
      ];

      await vault.connect(trader).batchSwapGiveIn(swaps, tokenAddresses, {
        sender: trader.address,
        recipient: trader.address,
        withdrawFromUserBalance: false,
        depositToUserBalance: false,
      });

      await tokens.DAI.connect(other).transfer(vault.address, (0.5e18).toString());

      expect(await vault.getTotalUnaccountedForTokens(tokens.DAI.address)).to.equal((1.5e18).toString());
      expect(await vault.getTotalUnaccountedForTokens(tokens.MKR.address)).to.equal(0);
    });
  });

  describe('claims', () => {
    beforeEach(async () => {
      await tokens.DAI.connect(other).transfer(vault.address, (1e18).toString());
      await tokens.MKR.connect(other).transfer(vault.address, (0.8e18).toString());
    });

    it('unaccounted for tokens can be claimed by admin', async () => {
      await expectBalanceChange(
        () =>
          vault
            .connect(admin)
            .claimUnaccountedForTokens(
              [tokens.DAI.address, tokens.MKR.address],
              [(1e18).toString(), (0.8e18).toString()],
              recipient.address
            ),
        recipient,
        tokens,
        { DAI: (1e18).toString(), MKR: (0.8e18).toString() }
      );

      expect(await vault.getTotalUnaccountedForTokens(tokens.DAI.address)).to.equal(0);
    });

    it('unaccounted for tokens can be partially claimed by admin', async () => {
      await expectBalanceChange(
        () =>
          vault
            .connect(admin)
            .claimUnaccountedForTokens([tokens.DAI.address], [(0.4e18).toString()], recipient.address),
        recipient,
        tokens,
        { DAI: (0.4e18).toString() }
      );

      expect(await vault.getTotalUnaccountedForTokens(tokens.DAI.address)).to.equal((0.6e18).toString());
    });

    it('non-admin cannot claim tokens', async () => {
      await expect(
        vault.connect(other).claimUnaccountedForTokens([tokens.DAI.address], [(1e18).toString()], recipient.address)
      ).to.be.revertedWith('Caller is not the admin');
    });

    it('a token cannot be over-claimed', async () => {
      await expect(
        vault
          .connect(admin)
          .claimUnaccountedForTokens(
            [tokens.DAI.address],
            [BigNumber.from((1e18).toString()).add(1)],
            recipient.address
          )
      ).to.be.revertedWith('Insufficient unaccounted for tokens');
    });

    it('a token cannot be over-claimed with repeated claims', async () => {
      await expect(
        vault
          .connect(admin)
          .claimUnaccountedForTokens(
            [tokens.DAI.address, tokens.DAI.address],
            [(1e18).toString(), 1],
            recipient.address
          )
      ).to.be.revertedWith('Insufficient unaccounted for tokens');
    });
  });
});