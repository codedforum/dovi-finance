// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DoviClaimV2} from "./DoviClaimV2.sol";

/// Adds locked payouts: a claim can carry a time before which its sender
/// cannot reclaim it. A lock never blocks the recipient's claim, never extends past the claim's expiry, and applies
/// while the contract is paused as well. Unlocked claims behave exactly as before.
contract DoviClaimV3 is DoviClaimV2 {
    using SafeERC20 for IERC20;

    mapping(bytes32 => uint64) public reclaimAfter;

    uint256[49] private __gapV3;

    event ClaimLocked(bytes32 indexed id, uint64 reclaimAfter);

    error Locked();
    error BadLock();

    function implementationVersion() external pure virtual override returns (uint16) {
        return 3;
    }

    function createClaimLocked(bytes32 id, bytes32 recipientHash, uint96 amount, uint64 expiry, uint64 lockUntil) external nonReentrant {
        if (paused) revert PausedError();
        _checkLock(lockUntil, expiry);
        uint96 total = _createOne(msg.sender, id, recipientHash, amount, expiry);
        reclaimAfter[id] = lockUntil;
        token.safeTransferFrom(msg.sender, address(this), total);
        emit ClaimLocked(id, lockUntil);
    }

    function createBatchLocked(bytes32[] calldata ids, bytes32[] calldata recipientHashes, uint96[] calldata amounts, uint64 expiry, uint64 lockUntil) external nonReentrant {
        if (paused) revert PausedError();
        uint256 n = ids.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge();
        if (recipientHashes.length != n || amounts.length != n) revert LengthMismatch();
        _checkLock(lockUntil, expiry);
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            sum += _createOne(msg.sender, ids[i], recipientHashes[i], amounts[i], expiry);
            reclaimAfter[ids[i]] = lockUntil;
            emit ClaimLocked(ids[i], lockUntil);
        }
        token.safeTransferFrom(msg.sender, address(this), sum);
    }

    function _beforeReclaim(bytes32 id) internal view override {
        if (block.timestamp < reclaimAfter[id]) revert Locked();
    }

    function _checkLock(uint64 lockUntil, uint64 expiry) internal view {
        if (lockUntil <= block.timestamp || lockUntil > expiry) revert BadLock();
    }
}
