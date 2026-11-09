// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {DoviClaimUpgradeable} from "../src/DoviClaimUpgradeable.sol";
import {DoviClaimV2} from "../src/DoviClaimV2.sol";
import {DoviClaimV3} from "../src/DoviClaimV3.sol";

contract DoviClaimV3Test is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    DoviClaimV3 c;
    uint256 attesterPk = 0xA11CE;
    address attester;
    address owner = makeAddr("owner");
    address feeTo = makeAddr("feeTo");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address exec = makeAddr("exec");
    address mallory = makeAddr("mallory");

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        attester = vm.addr(attesterPk);
        DoviClaimUpgradeable v1 = new DoviClaimUpgradeable();
        DoviClaimUpgradeable p = DoviClaimUpgradeable(address(new ERC1967Proxy(address(v1), abi.encodeCall(DoviClaimUpgradeable.initialize, (owner, IERC20(USDC), attester, feeTo, 100, 100_000, 1_000_000, 1_000_000_000, 5_000_000_000, 50_000_000_000, 1 days)))));
        deal(USDC, alice, 1_000e6);
        vm.prank(alice);
        IERC20(USDC).approve(address(p), type(uint256).max);
        vm.prank(alice);
        p.createClaim(bytes32(uint256(999)), keccak256("pre"), 5_000_000, uint64(block.timestamp + 7 days));
        DoviClaimV2 v2 = new DoviClaimV2();
        vm.prank(owner);
        p.scheduleUpgrade(address(v2), "");
        skip(1 days);
        vm.prank(owner);
        p.upgradeToAndCall(address(v2), "");
        DoviClaimV3 v3 = new DoviClaimV3();
        vm.prank(owner);
        DoviClaimV2(address(p)).scheduleUpgrade(address(v3), "");
        skip(1 days);
        vm.prank(owner);
        DoviClaimV2(address(p)).upgradeToAndCall(address(v3), "");
        c = DoviClaimV3(address(p));
        vm.prank(owner);
        c.setExecutor(exec, true);
    }

    function _sig(bytes32 id, address recipient, uint64 deadline) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", c.domainSeparator(), keccak256(abi.encode(c.ATTEST_TYPEHASH(), id, recipient, deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _ids(uint256 n, uint256 base) internal pure returns (bytes32[] memory ids, bytes32[] memory hs, uint96[] memory amts) {
        ids = new bytes32[](n); hs = new bytes32[](n); amts = new uint96[](n);
        for (uint256 i = 0; i < n; i++) { ids[i] = bytes32(base + i); hs[i] = keccak256(abi.encode("h", i)); amts[i] = 1_000_000; }
    }

    function test_versionAndOlderStateSurviveBothUpgrades() public {
        assertEq(c.implementationVersion(), 3);
        assertEq(c.totalLocked(), 5_100_000);
        assertEq(c.reclaimAfter(bytes32(uint256(999))), 0);
        vm.prank(alice);
        c.reclaim(bytes32(uint256(999)));
        assertEq(c.totalLocked(), 0);
    }

    function test_lockedClaimCannotBeReclaimedUntilTheLockEnds() public {
        bytes32 id = bytes32(uint256(1));
        uint64 lockUntil = uint64(block.timestamp + 3 days);
        vm.prank(alice);
        c.createClaimLocked(id, keccak256("r"), 2_000_000, uint64(block.timestamp + 7 days), lockUntil);
        assertEq(c.reclaimAfter(id), lockUntil);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        vm.expectRevert(DoviClaimV3.Locked.selector);
        c.reclaim(id);
        vm.warp(lockUntil - 1);
        vm.prank(alice);
        vm.expectRevert(DoviClaimV3.Locked.selector);
        c.reclaim(id);
        vm.warp(lockUntil);
        uint256 before = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        c.reclaim(id);
        assertEq(IERC20(USDC).balanceOf(alice) - before, 2_000_000 + 100_000);
    }

    function test_theRecipientCanStillClaimWhileLocked() public {
        bytes32 id = bytes32(uint256(2));
        vm.prank(alice);
        c.createClaimLocked(id, keccak256("r"), 2_000_000, uint64(block.timestamp + 7 days), uint64(block.timestamp + 5 days));
        uint64 dl = uint64(block.timestamp + 1 hours);
        c.claim(id, bob, dl, _sig(id, bob, dl));
        assertEq(IERC20(USDC).balanceOf(bob), 2_000_000);
        vm.warp(block.timestamp + 6 days);
        vm.prank(alice);
        vm.expectRevert(DoviClaimUpgradeable.NotOpen.selector);
        c.reclaim(id);
    }

    function test_pauseDoesNotBreakTheLockOrTheRefundAfterIt() public {
        bytes32 id = bytes32(uint256(3));
        uint64 lockUntil = uint64(block.timestamp + 2 days);
        vm.prank(alice);
        c.createClaimLocked(id, keccak256("r"), 2_000_000, uint64(block.timestamp + 7 days), lockUntil);
        vm.prank(owner);
        c.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(DoviClaimV3.Locked.selector);
        c.reclaim(id);
        vm.warp(lockUntil);
        vm.prank(alice);
        c.reclaim(id);
        assertEq(c.totalLocked(), 5_100_000);
    }

    function test_badLocksAreRefused() public {
        uint64 exp = uint64(block.timestamp + 7 days);
        vm.startPrank(alice);
        vm.expectRevert(DoviClaimV3.BadLock.selector);
        c.createClaimLocked(bytes32(uint256(4)), keccak256("r"), 2_000_000, exp, 0);
        vm.expectRevert(DoviClaimV3.BadLock.selector);
        c.createClaimLocked(bytes32(uint256(4)), keccak256("r"), 2_000_000, exp, uint64(block.timestamp));
        vm.expectRevert(DoviClaimV3.BadLock.selector);
        c.createClaimLocked(bytes32(uint256(4)), keccak256("r"), 2_000_000, exp, exp + 1);
        c.createClaimLocked(bytes32(uint256(4)), keccak256("r"), 2_000_000, exp, exp);
        vm.stopPrank();
        assertEq(c.reclaimAfter(bytes32(uint256(4))), exp);
    }

    function test_lockedBatchLocksEveryRowAndMovesOneTransfer() public {
        (bytes32[] memory ids, bytes32[] memory hs, uint96[] memory amts) = _ids(3, 100);
        uint64 lockUntil = uint64(block.timestamp + 4 days);
        uint256 before = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        c.createBatchLocked(ids, hs, amts, uint64(block.timestamp + 10 days), lockUntil);
        assertEq(before - IERC20(USDC).balanceOf(alice), 3 * 1_100_000);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(c.reclaimAfter(ids[i]), lockUntil);
            vm.prank(alice);
            vm.expectRevert(DoviClaimV3.Locked.selector);
            c.reclaim(ids[i]);
        }
        vm.warp(lockUntil);
        for (uint256 i = 0; i < 3; i++) { vm.prank(alice); c.reclaim(ids[i]); }
    }

    function test_lockedBatchChecksSizeAndLengths() public {
        (bytes32[] memory ids, bytes32[] memory hs, uint96[] memory amts) = _ids(2, 200);
        bytes32[] memory few = new bytes32[](1);
        vm.startPrank(alice);
        vm.expectRevert(DoviClaimV2.LengthMismatch.selector);
        c.createBatchLocked(ids, few, amts, uint64(block.timestamp + 10 days), uint64(block.timestamp + 2 days));
        vm.expectRevert(DoviClaimV2.EmptyBatch.selector);
        c.createBatchLocked(new bytes32[](0), new bytes32[](0), new uint96[](0), uint64(block.timestamp + 10 days), uint64(block.timestamp + 2 days));
        vm.stopPrank();
        hs[0] = hs[0];
    }

    function test_unlockedClaimsKeepTheOldBehaviour() public {
        bytes32 id = bytes32(uint256(5));
        vm.prank(alice);
        c.createClaim(id, keccak256("r"), 2_000_000, uint64(block.timestamp + 7 days));
        assertEq(c.reclaimAfter(id), 0);
        vm.prank(alice);
        c.reclaim(id);
    }

    function test_pausedContractRefusesNewLockedClaims() public {
        vm.prank(owner);
        c.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(DoviClaimUpgradeable.PausedError.selector);
        c.createClaimLocked(bytes32(uint256(6)), keccak256("r"), 2_000_000, uint64(block.timestamp + 7 days), uint64(block.timestamp + 2 days));
    }

    function test_onlyTheSenderCanReclaimEvenAfterTheLock() public {
        bytes32 id = bytes32(uint256(7));
        uint64 lockUntil = uint64(block.timestamp + 1 days);
        vm.prank(alice);
        c.createClaimLocked(id, keccak256("r"), 2_000_000, uint64(block.timestamp + 7 days), lockUntil);
        vm.warp(lockUntil + 1);
        vm.prank(mallory);
        vm.expectRevert(DoviClaimUpgradeable.NotSender.selector);
        c.reclaim(id);
    }

    function testFuzz_lockNeverExceedsExpiry(uint64 lockOffset, uint64 expiryOffset) public {
        expiryOffset = uint64(bound(expiryOffset, 1 hours, 30 days));
        lockOffset = uint64(bound(lockOffset, 1, 60 days));
        uint64 exp = uint64(block.timestamp) + expiryOffset; uint64 lk = uint64(block.timestamp) + lockOffset;
        vm.prank(alice);
        if (lk > exp) vm.expectRevert(DoviClaimV3.BadLock.selector);
        c.createClaimLocked(bytes32(uint256(8)), keccak256("r"), 2_000_000, exp, lk);
    }
}
