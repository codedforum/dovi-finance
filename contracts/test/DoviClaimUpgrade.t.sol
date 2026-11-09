// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";
import {DoviClaimUpgradeable} from "../src/DoviClaimUpgradeable.sol";

contract DoviClaimV2Mock is DoviClaimUpgradeable {
    uint256 public extraValue;

    function implementationVersion() external pure override returns (uint16) {
        return 2;
    }

    function setExtra(uint256 v) external onlyOwner {
        extraValue = v;
    }

    function initializeV2(uint256 v) external reinitializer(2) {
        extraValue = v;
    }
}

contract NotUups {
    function ping() external pure returns (uint256) {
        return 1;
    }
}

contract DoviClaimUpgradeTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    DoviClaimUpgradeable c;
    DoviClaimUpgradeable impl;
    uint256 attesterPk = 0xA11CE;
    address attester;
    address owner = makeAddr("owner");
    address feeTo = makeAddr("feeTo");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");
    bytes32 hashA = keccak256("dovi:v1:x:123");

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        attester = vm.addr(attesterPk);
        impl = new DoviClaimUpgradeable();
        c = DoviClaimUpgradeable(address(new ERC1967Proxy(address(impl), abi.encodeCall(DoviClaimUpgradeable.initialize, (owner, IERC20(USDC), attester, feeTo, 100, 100_000, 1_000_000, 10_000_000, 50_000_000, 500_000_000, 1 days)))));
        deal(USDC, alice, 1_000e6);
        vm.prank(alice);
        IERC20(USDC).approve(address(c), type(uint256).max);
    }

    function _sig(bytes32 id, address recipient, uint64 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(c.ATTEST_TYPEHASH(), id, recipient, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", c.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _create(bytes32 id, uint96 amount) internal {
        vm.prank(alice);
        c.createClaim(id, hashA, amount, uint64(block.timestamp + 7 days));
    }

    function _schedule(address to, bytes memory data) internal {
        vm.prank(owner);
        c.scheduleUpgrade(to, data);
    }

    function test_implementationCannotBeInitializedAndProxyCannotBeReinitialized() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(owner, IERC20(USDC), attester, feeTo, 100, 100_000, 1_000_000, 10_000_000, 50_000_000, 500_000_000, 0);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        c.initialize(mallory, IERC20(USDC), attester, feeTo, 100, 100_000, 1_000_000, 10_000_000, 50_000_000, 500_000_000, 0);
        assertEq(c.owner(), owner);
    }

    function test_initializeRejectsZeroAddressesAndLongDelay() public {
        bytes memory bad = abi.encodeCall(DoviClaimUpgradeable.initialize, (address(0), IERC20(USDC), attester, feeTo, 100, 100_000, 1_000_000, 10_000_000, 50_000_000, 500_000_000, 0));
        vm.expectRevert(DoviClaimUpgradeable.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), bad);
        bytes memory longDelay = abi.encodeCall(DoviClaimUpgradeable.initialize, (owner, IERC20(USDC), attester, feeTo, 100, 100_000, 1_000_000, 10_000_000, 50_000_000, 500_000_000, 15 days));
        vm.expectRevert(DoviClaimUpgradeable.DelayTooLong.selector);
        new ERC1967Proxy(address(impl), longDelay);
    }

    function test_domainUsesProxyAddress() public view {
        bytes32 expected = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("DoviClaim"), keccak256("1"), block.chainid, address(c)));
        assertEq(c.domainSeparator(), expected);
    }

    function test_onlyOwnerSchedulesAndCancels() public {
        DoviClaimV2Mock v2 = new DoviClaimV2Mock();
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, mallory));
        c.scheduleUpgrade(address(v2), "");
        _schedule(address(v2), "");
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, mallory));
        c.cancelUpgrade();
        vm.prank(owner);
        c.cancelUpgrade();
        assertEq(c.pendingImplementation(), address(0));
        vm.prank(owner);
        vm.expectRevert(DoviClaimUpgradeable.UpgradeNotScheduled.selector);
        c.cancelUpgrade();
    }

    function test_upgradeRequiresScheduleThenDelay() public {
        DoviClaimV2Mock v2 = new DoviClaimV2Mock();
        vm.prank(owner);
        vm.expectRevert(DoviClaimUpgradeable.UpgradeNotScheduled.selector);
        c.upgradeToAndCall(address(v2), "");
        _schedule(address(v2), "");
        vm.prank(owner);
        vm.expectRevert(DoviClaimUpgradeable.UpgradeNotReady.selector);
        c.upgradeToAndCall(address(v2), "");
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(owner);
        vm.expectRevert(DoviClaimUpgradeable.UpgradeNotReady.selector);
        c.upgradeToAndCall(address(v2), "");
        vm.warp(block.timestamp + 1);
        vm.prank(owner);
        c.upgradeToAndCall(address(v2), "");
        assertEq(c.implementationVersion(), 2);
        assertEq(c.pendingImplementation(), address(0));
    }

    function test_nonOwnerCannotUpgradeEvenWhenScheduled() public {
        DoviClaimV2Mock v2 = new DoviClaimV2Mock();
        _schedule(address(v2), "");
        vm.warp(block.timestamp + 1 days);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, mallory));
        c.upgradeToAndCall(address(v2), "");
    }

    function test_upgradeMustMatchScheduledImplementationAndCalldata() public {
        DoviClaimV2Mock v2 = new DoviClaimV2Mock();
        DoviClaimV2Mock other = new DoviClaimV2Mock();
        bytes memory data = abi.encodeCall(DoviClaimV2Mock.initializeV2, (7));
        _schedule(address(v2), data);
        vm.warp(block.timestamp + 1 days);
        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        vm.expectRevert(DoviClaimUpgradeable.UpgradeMismatch.selector);
        c.upgradeToAndCall(address(other), data);
        vm.expectRevert(DoviClaimUpgradeable.UpgradeMismatch.selector);
        c.upgradeToAndCall(address(v2), abi.encodeCall(DoviClaimV2Mock.initializeV2, (8)));
        vm.expectRevert(DoviClaimUpgradeable.NoValue.selector);
        c.upgradeToAndCall{value: 1}(address(v2), data);
        c.upgradeToAndCall(address(v2), data);
        vm.stopPrank();
        assertEq(DoviClaimV2Mock(address(c)).extraValue(), 7);
    }

    function test_cancelledUpgradeCannotBeExecuted() public {
        DoviClaimV2Mock v2 = new DoviClaimV2Mock();
        _schedule(address(v2), "");
        vm.prank(owner);
        c.cancelUpgrade();
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        vm.expectRevert(DoviClaimUpgradeable.UpgradeNotScheduled.selector);
        c.upgradeToAndCall(address(v2), "");
    }

    function test_upgradeToImplementationWithoutUupsIsRejected() public {
        NotUups bad = new NotUups();
        _schedule(address(bad), "");
        vm.warp(block.timestamp + 1 days);
        vm.prank(owner);
        vm.expectRevert();
        c.upgradeToAndCall(address(bad), "");
        assertEq(c.implementationVersion(), 1);
    }

    function test_implementationCannotBeUpgradedDirectly() public {
        DoviClaimV2Mock v2 = new DoviClaimV2Mock();
        vm.expectRevert();
        impl.upgradeToAndCall(address(v2), "");
    }

    function test_statePersistsAcrossUpgradeAndOpenClaimStillWorks() public {
        _create(bytes32(uint256(1)), 5_000_000);
        _create(bytes32(uint256(2)), 3_000_000);
        uint96 lockedBefore = c.totalLocked();
        bytes32 domainBefore = c.domainSeparator();
        DoviClaimV2Mock v2 = new DoviClaimV2Mock();
        _schedule(address(v2), "");
        vm.warp(block.timestamp + 1 days);
        vm.prank(owner);
        c.upgradeToAndCall(address(v2), "");
        assertEq(c.totalLocked(), lockedBefore);
        assertEq(c.domainSeparator(), domainBefore);
        assertEq(c.owner(), owner);
        assertEq(c.attester(), attester);
        assertEq(address(c.token()), USDC);
        assertEq(c.feeBps(), 100);
        assertEq(c.upgradeDelay(), 1 days);
        uint64 dl = uint64(block.timestamp + 1 hours);
        uint256 b0 = IERC20(USDC).balanceOf(bob);
        c.claim(bytes32(uint256(1)), bob, dl, _sig(bytes32(uint256(1)), bob, dl));
        assertEq(IERC20(USDC).balanceOf(bob) - b0, 5_000_000);
        vm.prank(alice);
        c.reclaim(bytes32(uint256(2)));
        assertEq(c.totalLocked(), 0);
        assertEq(IERC20(USDC).balanceOf(address(c)), 0);
    }

    function test_reclaimAlwaysWorksWhilePausedAndWhileUpgradePending() public {
        _create(bytes32(uint256(1)), 5_000_000);
        DoviClaimV2Mock v2 = new DoviClaimV2Mock();
        _schedule(address(v2), "");
        vm.prank(owner);
        c.setPaused(true);
        vm.prank(alice);
        c.reclaim(bytes32(uint256(1)));
        assertEq(c.totalLocked(), 0);
    }

    function test_upgradeDelayCanOnlyGrowAndIsCapped() public {
        vm.startPrank(owner);
        vm.expectRevert(DoviClaimUpgradeable.DelayCannotShrink.selector);
        c.setUpgradeDelay(1 hours);
        vm.expectRevert(DoviClaimUpgradeable.DelayTooLong.selector);
        c.setUpgradeDelay(15 days);
        c.setUpgradeDelay(3 days);
        vm.stopPrank();
        assertEq(c.upgradeDelay(), 3 days);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, mallory));
        c.setUpgradeDelay(4 days);
    }

    function test_renounceOwnershipIsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(DoviClaimUpgradeable.RenounceDisabled.selector);
        c.renounceOwnership();
        assertEq(c.owner(), owner);
    }

    function test_proxyImplementationSlotPointsAtImplementation() public view {
        bytes32 slot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        assertEq(address(uint160(uint256(vm.load(address(c), slot)))), address(impl));
    }
}
