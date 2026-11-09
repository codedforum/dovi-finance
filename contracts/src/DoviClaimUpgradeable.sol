// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";
import {EIP712Upgradeable} from "openzeppelin-contracts-upgradeable/contracts/utils/cryptography/EIP712Upgradeable.sol";

/// Escrow for payments claimed by recipient hash. The attester signs each claim and the sender can
/// reclaim an unclaimed payment after it is created.
contract DoviClaimUpgradeable is
    Initializable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 150;
    uint96 public constant MAX_MIN_FEE = 1_000_000;
    uint64 public constant MAX_EXPIRY = 30 days;
    uint64 public constant MAX_UPGRADE_DELAY = 14 days;
    bytes32 public constant ATTEST_TYPEHASH = keccak256("Attest(bytes32 id,address recipient,uint64 deadline)");

    uint8 private constant OPEN = 1;
    uint8 private constant CLAIMED = 2;
    uint8 private constant RECLAIMED = 3;

    struct Claim {
        address sender;
        uint96 amount;
        uint96 fee;
        uint64 expiry;
        uint8 status;
        bytes32 recipientHash;
    }

    IERC20 public token;
    uint96 public minAmount;
    address public attester;
    address public feeRecipient;
    uint16 public feeBps;
    uint96 public minFee;
    uint96 public perClaimCap;
    uint96 public perSenderDayCap;
    uint96 public globalCap;
    uint96 public totalLocked;
    bool public paused;

    mapping(bytes32 => Claim) public claims;
    mapping(address => mapping(uint64 => uint96)) public senderDaySpent;

    uint64 public upgradeDelay;
    uint64 public upgradeReadyAt;
    address public pendingImplementation;
    bytes32 public pendingCallHash;

    uint256[40] private __gap;

    event ClaimCreated(bytes32 indexed id, address indexed sender, bytes32 recipientHash, uint96 amount, uint96 fee, uint64 expiry);
    event ClaimClaimed(bytes32 indexed id, address indexed recipient, uint96 amount, uint96 fee);
    event ClaimReclaimed(bytes32 indexed id, address indexed sender, uint96 returned);
    event Paused(bool value);
    event AttesterChanged(address attester);
    event FeeRecipientChanged(address feeRecipient);
    event FeeChanged(uint16 feeBps, uint96 minFee);
    event CapsChanged(uint96 perClaimCap, uint96 perSenderDayCap, uint96 globalCap);
    event UpgradeScheduled(address indexed implementation, bytes32 callHash, uint64 readyAt);
    event UpgradeCancelled(address indexed implementation);
    event UpgradeDelayChanged(uint64 delay);

    error NotOpen();
    error Expired();
    error BadAmount();
    error BadExpiry();
    error BadRecipient();
    error BadSignature();
    error CapExceeded();
    error PausedError();
    error NotSender();
    error FeeTooHigh();
    error ZeroAddress();
    error Exists();
    error DeadlinePassed();
    error UpgradeNotScheduled();
    error UpgradeNotReady();
    error UpgradeMismatch();
    error DelayTooLong();
    error DelayCannotShrink();
    error RenounceDisabled();
    error NoValue();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        IERC20 token_,
        address attester_,
        address feeRecipient_,
        uint16 feeBps_,
        uint96 minFee_,
        uint96 minAmount_,
        uint96 perClaimCap_,
        uint96 perSenderDayCap_,
        uint96 globalCap_,
        uint64 upgradeDelay_
    ) external initializer {
        if (owner_ == address(0) || attester_ == address(0) || feeRecipient_ == address(0) || address(token_) == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS || minFee_ > MAX_MIN_FEE) revert FeeTooHigh();
        if (perClaimCap_ < minAmount_) revert BadAmount();
        if (upgradeDelay_ > MAX_UPGRADE_DELAY) revert DelayTooLong();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __EIP712_init("DoviClaim", "1");
        __UUPSUpgradeable_init();
        token = token_;
        minAmount = minAmount_;
        attester = attester_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        minFee = minFee_;
        perClaimCap = perClaimCap_;
        perSenderDayCap = perSenderDayCap_;
        globalCap = globalCap_;
        upgradeDelay = upgradeDelay_;
    }

    function implementationVersion() external pure virtual returns (uint16) {
        return 1;
    }

    function quoteFee(uint96 amount) public view returns (uint96) {
        uint256 pct = (uint256(amount) * feeBps) / 10_000;
        return pct > minFee ? uint96(pct) : minFee;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function createClaim(bytes32 id, bytes32 recipientHash, uint96 amount, uint64 expiry) external nonReentrant {
        if (paused) revert PausedError();
        if (claims[id].status != 0) revert Exists();
        if (recipientHash == bytes32(0)) revert BadRecipient();
        if (amount < minAmount || amount > perClaimCap) revert BadAmount();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_EXPIRY) revert BadExpiry();

        uint64 day = uint64(block.timestamp / 1 days);
        uint96 spent = senderDaySpent[msg.sender][day] + amount;
        if (spent > perSenderDayCap) revert CapExceeded();

        uint96 fee = quoteFee(amount);
        uint96 total = amount + fee;
        if (uint256(totalLocked) + total > globalCap) revert CapExceeded();

        senderDaySpent[msg.sender][day] = spent;
        totalLocked += total;
        claims[id] = Claim({sender: msg.sender, amount: amount, fee: fee, expiry: expiry, status: OPEN, recipientHash: recipientHash});

        token.safeTransferFrom(msg.sender, address(this), total);
        emit ClaimCreated(id, msg.sender, recipientHash, amount, fee, expiry);
    }

    function claim(bytes32 id, address recipient, uint64 deadline, bytes calldata attestation) external nonReentrant {
        if (paused) revert PausedError();
        Claim storage c = claims[id];
        if (c.status != OPEN) revert NotOpen();
        if (block.timestamp > c.expiry) revert Expired();
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (recipient == address(0)) revert BadRecipient();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ATTEST_TYPEHASH, id, recipient, deadline)));
        if (ECDSA.recover(digest, attestation) != attester) revert BadSignature();

        uint96 amount = c.amount;
        uint96 fee = c.fee;
        c.status = CLAIMED;
        totalLocked -= amount + fee;

        token.safeTransfer(recipient, amount);
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
        emit ClaimClaimed(id, recipient, amount, fee);
    }

    function reclaim(bytes32 id) external nonReentrant {
        Claim storage c = claims[id];
        if (c.status != OPEN) revert NotOpen();
        if (c.sender != msg.sender) revert NotSender();
        _beforeReclaim(id);
        uint96 back = c.amount + c.fee;
        c.status = RECLAIMED;
        totalLocked -= back;
        token.safeTransfer(msg.sender, back);
        emit ClaimReclaimed(id, msg.sender, back);
    }

    function _beforeReclaim(bytes32) internal view virtual {}

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit Paused(value);
    }

    function setAttester(address value) external onlyOwner {
        if (value == address(0)) revert ZeroAddress();
        attester = value;
        emit AttesterChanged(value);
    }

    function setFeeRecipient(address value) external onlyOwner {
        if (value == address(0)) revert ZeroAddress();
        feeRecipient = value;
        emit FeeRecipientChanged(value);
    }

    function setFee(uint16 bps, uint96 minFee_) external onlyOwner {
        if (bps > MAX_FEE_BPS || minFee_ > MAX_MIN_FEE) revert FeeTooHigh();
        feeBps = bps;
        minFee = minFee_;
        emit FeeChanged(bps, minFee_);
    }

    function setCaps(uint96 perClaim, uint96 perSenderDay, uint96 globalLocked) external onlyOwner {
        if (perClaim < minAmount) revert BadAmount();
        perClaimCap = perClaim;
        perSenderDayCap = perSenderDay;
        globalCap = globalLocked;
        emit CapsChanged(perClaim, perSenderDay, globalLocked);
    }

    function setUpgradeDelay(uint64 value) external onlyOwner {
        if (value > MAX_UPGRADE_DELAY) revert DelayTooLong();
        if (value < upgradeDelay) revert DelayCannotShrink();
        upgradeDelay = value;
        emit UpgradeDelayChanged(value);
    }

    function scheduleUpgrade(address implementation, bytes calldata data) external onlyOwner {
        if (implementation == address(0)) revert ZeroAddress();
        uint64 readyAt = uint64(block.timestamp) + upgradeDelay;
        pendingImplementation = implementation;
        pendingCallHash = keccak256(data);
        upgradeReadyAt = readyAt;
        emit UpgradeScheduled(implementation, pendingCallHash, readyAt);
    }

    function cancelUpgrade() external onlyOwner {
        address implementation = pendingImplementation;
        if (implementation == address(0)) revert UpgradeNotScheduled();
        delete pendingImplementation;
        delete pendingCallHash;
        delete upgradeReadyAt;
        emit UpgradeCancelled(implementation);
    }

    function upgradeToAndCall(address newImplementation, bytes memory data) public payable override onlyProxy {
        if (msg.value != 0) revert NoValue();
        if (pendingImplementation == address(0)) revert UpgradeNotScheduled();
        if (pendingImplementation != newImplementation || pendingCallHash != keccak256(data)) revert UpgradeMismatch();
        super.upgradeToAndCall(newImplementation, data);
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {
        if (block.timestamp < upgradeReadyAt) revert UpgradeNotReady();
        delete pendingImplementation;
        delete pendingCallHash;
        delete upgradeReadyAt;
    }
}
