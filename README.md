# DOVI

Send USDC to an X handle or an email. They claim it with one login, no wallet address needed.

DOVI runs on Base Sepolia with test USDC. Mainnet is not live yet, and no real money moves.

- App: https://dovi.finance
- Try it in 60 seconds: https://dovi.finance/judges
- Live numbers from the escrow contract: https://dovi.finance/live
- Demo video, about 5 minutes: https://dovi.finance/assets/video/dovi-demo.mp4

## How it works

1. You type an X handle or an email and an amount. DOVI shows the exact fee before you approve.
2. The USDC is locked in the DOVI escrow contract on Base. The contract stores a hash of the recipient, not the handle itself.
3. The recipient signs in once with X or an email code. A Coinbase wallet is created for them on sign in, and they claim in one step.
4. If nobody claims before the expiry, the sender takes the money back in full with no fee.

Also in the app:

- Pay many people in one approval, for giveaways and payouts.
- Payment links, QR codes and requests, with receipts in Activity.
- Ask DOVI turns plain words into a payment preview. Nothing moves without your approval.
- Pay from X lets you pay by posting a tweet that mentions DOVI, inside limits you set.
- Withdraw to your own Base wallet.
- Cash out to 253 Nigerian banks in naira, OPay included, with an automatic refund when a payout fails. Naira runs in test mode.

## On chain

Escrow proxy on Base Sepolia: [0x07e5bE5687b739024f28bf8c85faf1d6E14fDbd4](https://base-sepolia.blockscout.com/address/0x07e5bE5687b739024f28bf8c85faf1d6E14fDbd4)

- `DoviClaimV4.sol` is the current implementation behind the proxy. It adds other tokens to the same escrow.
- `DoviClaim.sol` to `DoviClaimV3.sol` are the earlier versions, kept so the upgrade tests can run against them.
- `DoviPool.sol` is a small USDC and VIBES test pool, and `TestVibes.sol` is the VIBES test token.

## Stack

Node.js and SQLite server, viem, Coinbase CDP SDK wallets, Solidity contracts tested with Foundry, deployed on Base Sepolia.

## Build history

This repo is a curated public mirror of DOVI's private working repo. The private repo holds 167 commits made between 18 Oct and 10 Nov 2026, and it also keeps deploy scripts and server configs that stay private. Everything needed to read, test, and judge the app is here.

- 18 Oct: project start, chain registry, config, and first claim flow
- 25 Oct: landing page redesign with demo and FAQ
- 26 Oct: account dashboard with limits and linked X accounts
- 27 Oct: upgradeable DoviClaim escrow behind a proxy with delayed upgrades, plus Foundry tests
- 3 Nov: judges page and Vibeathon submission
- 6 Nov: payment intent model, tested on 50 labelled posts with zero unsafe results
- 8 Nov: naira rail to buy USDC and cash out to a Nigerian bank, in test mode
- 9 Nov: live numbers counted from escrow contract events, matching the explorer
- 10 Nov: SEO, metadata, and new illustrations

## Run the tests

Needs Node 25 or newer. Foundry is needed for the contract tests.

```sh
npm ci
npm test                                   # app tests
forge test --root contracts                # contract tests
node tools/check.mjs                       # syntax and copy checks
DOVI_ENV=dev node tools/dev-server.js      # local app on :3399 with a fake chain and a mock wallet
node tools/intent-eval.cjs                 # scores the Pay from X intent model on 50 labelled tweets, needs an LLM key
```

The tests, checks and dev server need no keys. `.env.example` lists the settings a full deployment reads, with placeholder values only.

## Folder layout

- `server/` HTTP API, claims, the chain indexer, Ask DOVI, Pay from X and the naira rail
- `lib/` sign in, wallets, email codes, faucets and the naira payout client
- `public/` the web app
- `contracts/` Solidity sources and Foundry tests
- `test/` app tests and fixtures
- `tools/` local dev server, browser walkthroughs, asset build and checks
