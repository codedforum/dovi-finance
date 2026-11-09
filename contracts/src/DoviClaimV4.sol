// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {DoviClaimV3} from "./DoviClaimV3.sol";

/// Adds escrow for additional ERC20 tokens next to the main token. Each extra token is switched on by the owner with
/// its own limits and carries no fee. Extra-token claims live in their own table and use the same attestation as
/// main-token claims, so the existing claim, reclaim and fee paths are unchanged. Amounts are in the token's own units.
contract DoviClaimV4 is DoviClaimV3 {
    using SafeERC20 for IERC20;

    uint8 private constant T_OPEN = 1;
    uint8 private constant T_CLAIMED = 2;
    uint8 private constant T_RECLAIMED = 3;

    struct TokenCfg {
        bool enabled;
        uint96 minAmount;
        uint96 perClaimCap;
        uint96 globalCap;
        uint96 locked;
    }

    struct TokenClaim {
        address sender;
        address token;
        uint96 amount;
        uint64 expiry;
        uint8 status;
        bytes32 recipientHash;
    }

    mapping(address => TokenCfg) public tokens;
    mapping(bytes32 => TokenClaim) public tokenClaims;

    uint256[47] private __gapV4;

    event TokenConfigured(address indexed token, bool enabled, uint96 minAmount, uint96 perClaimCap, uint96 globalCap);
    event TokenClaimCreated(bytes32 indexed id, address indexed sender, address indexed token, bytes32 recipientHash, uint96 amount, uint64 expiry);
    event TokenClaimClaimed(bytes32 indexed id, address indexed recipient, address indexed token, uint96 amount);
    event TokenClaimReclaimed(bytes32 indexed id, address indexed sender, address indexed token, uint96 returned);

    error TokenNotEnabled();
    error BadToken();
    error TransferShort();

    function implementationVersion() external pure override returns (uint16) {
        return 4;
    }

    function setToken(address t, bool enabled, uint96 minAmount_, uint96 perClaim, uint96 globalLocked) external onlyOwner {
        if (t == address(0) || t == address(token)) revert BadToken();
        if (perClaim < minAmount_) revert BadAmount();
        TokenCfg storage cfg = tokens[t];
        cfg.enabled = enabled;
        cfg.minAmount = minAmount_;
        cfg.perClaimCap = perClaim;
        cfg.globalCap = globalLocked;
        emit TokenConfigured(t, enabled, minAmount_, perClaim, globalLocked);
    }

    function createTokenClaim(address t, bytes32 id, bytes32 recipientHash, uint96 amount, uint64 expiry) external nonReentrant {
        if (paused) revert PausedError();
        TokenCfg storage cfg = tokens[t];
        if (!cfg.enabled) revert TokenNotEnabled();
        if (claims[id].status != 0 || tokenClaims[id].status != 0) revert Exists();
        if (recipientHash == bytes32(0)) revert BadRecipient();
        if (amount < cfg.minAmount || amount > cfg.perClaimCap) revert BadAmount();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_EXPIRY) revert BadExpiry();
        if (uint256(cfg.locked) + amount > cfg.globalCap) revert CapExceeded();

        cfg.locked += amount;
        tokenClaims[id] = TokenClaim({sender: msg.sender, token: t, amount: amount, expiry: expiry, status: T_OPEN, recipientHash: recipientHash});

        uint256 before = IERC20(t).balanceOf(address(this));
        IERC20(t).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(t).balanceOf(address(this)) - before != amount) revert TransferShort();
        emit TokenClaimCreated(id, msg.sender, t, recipientHash, amount, expiry);
    }

    function claimToken(bytes32 id, address recipient, uint64 deadline, bytes calldata attestation) external nonReentrant {
        if (paused) revert PausedError();
        TokenClaim storage c = tokenClaims[id];
        if (c.status != T_OPEN) revert NotOpen();
        if (block.timestamp > c.expiry) revert Expired();
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (recipient == address(0)) revert BadRecipient();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ATTEST_TYPEHASH, id, recipient, deadline)));
        if (ECDSA.recover(digest, attestation) != attester) revert BadSignature();

        uint96 amount = c.amount;
        address t = c.token;
        c.status = T_CLAIMED;
        tokens[t].locked -= amount;
        IERC20(t).safeTransfer(recipient, amount);
        emit TokenClaimClaimed(id, recipient, t, amount);
    }

    function reclaimToken(bytes32 id) external nonReentrant {
        TokenClaim storage c = tokenClaims[id];
        if (c.status != T_OPEN) revert NotOpen();
        if (c.sender != msg.sender) revert NotSender();
        uint96 back = c.amount;
        address t = c.token;
        c.status = T_RECLAIMED;
        tokens[t].locked -= back;
        IERC20(t).safeTransfer(msg.sender, back);
        emit TokenClaimReclaimed(id, msg.sender, t, back);
    }
}
