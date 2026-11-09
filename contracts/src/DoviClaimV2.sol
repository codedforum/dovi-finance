// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DoviClaimUpgradeable} from "./DoviClaimUpgradeable.sol";

/// Adds batch payouts and executor created payments for payers who opted in with a limit. Funds only
/// ever move from the payer into escrow, never to an executor, and the payer remains the sender, so
/// reclaim works exactly as before.
contract DoviClaimV2 is DoviClaimUpgradeable {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_BATCH = 100;
    uint8 private constant OPEN_STATUS = 1;

    struct AutoPay {
        uint96 perPayment;
        uint96 perDay;
    }

    mapping(address => bool) public executors;
    mapping(address => AutoPay) public autoPay;

    uint256[38] private __gapV2;

    event ExecutorSet(address indexed executor, bool allowed);
    event AutoPaySet(address indexed payer, uint96 perPayment, uint96 perDay);

    error BatchTooLarge();
    error LengthMismatch();
    error EmptyBatch();
    error NotExecutor();
    error AutoPayNotAllowed();
    error AutoPayLimit();

    function implementationVersion() external pure virtual override returns (uint16) {
        return 2;
    }

    function setExecutor(address executor, bool allowed) external onlyOwner {
        if (executor == address(0)) revert ZeroAddress();
        executors[executor] = allowed;
        emit ExecutorSet(executor, allowed);
    }

    function setAutoPay(uint96 perPayment, uint96 perDay) external {
        autoPay[msg.sender] = AutoPay({perPayment: perPayment, perDay: perDay});
        emit AutoPaySet(msg.sender, perPayment, perDay);
    }

    function createBatch(bytes32[] calldata ids, bytes32[] calldata recipientHashes, uint96[] calldata amounts, uint64 expiry) external nonReentrant {
        if (paused) revert PausedError();
        uint256 n = ids.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge();
        if (recipientHashes.length != n || amounts.length != n) revert LengthMismatch();
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            sum += _createOne(msg.sender, ids[i], recipientHashes[i], amounts[i], expiry);
        }
        token.safeTransferFrom(msg.sender, address(this), sum);
    }

    function createClaimFor(address payer, bytes32 id, bytes32 recipientHash, uint96 amount, uint64 expiry) external nonReentrant {
        if (paused) revert PausedError();
        if (!executors[msg.sender]) revert NotExecutor();
        AutoPay memory cfg = autoPay[payer];
        if (cfg.perPayment == 0 || cfg.perDay == 0) revert AutoPayNotAllowed();
        if (amount > cfg.perPayment) revert AutoPayLimit();
        if (uint256(senderDaySpent[payer][uint64(block.timestamp / 1 days)]) + amount > cfg.perDay) revert AutoPayLimit();
        uint96 total = _createOne(payer, id, recipientHash, amount, expiry);
        token.safeTransferFrom(payer, address(this), total);
    }

    function _createOne(address payer, bytes32 id, bytes32 recipientHash, uint96 amount, uint64 expiry) internal returns (uint96 total) {
        if (claims[id].status != 0) revert Exists();
        if (recipientHash == bytes32(0)) revert BadRecipient();
        if (amount < minAmount || amount > perClaimCap) revert BadAmount();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_EXPIRY) revert BadExpiry();

        uint64 day = uint64(block.timestamp / 1 days);
        uint96 spent = senderDaySpent[payer][day] + amount;
        if (spent > perSenderDayCap) revert CapExceeded();

        uint96 fee = quoteFee(amount);
        total = amount + fee;
        if (uint256(totalLocked) + total > globalCap) revert CapExceeded();

        senderDaySpent[payer][day] = spent;
        totalLocked += total;
        claims[id] = Claim({sender: payer, amount: amount, fee: fee, expiry: expiry, status: OPEN_STATUS, recipientHash: recipientHash});
        emit ClaimCreated(id, payer, recipientHash, amount, fee, expiry);
    }
}
