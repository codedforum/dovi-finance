// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {DoviClaimUpgradeable} from "../src/DoviClaimUpgradeable.sol";
import {DoviClaimV2} from "../src/DoviClaimV2.sol";

contract DoviClaimV2Test is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    DoviClaimV2 c;
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
        DoviClaimUpgradeable p = DoviClaimUpgradeable(address(new ERC1967Proxy(address(v1), abi.encodeCall(DoviClaimUpgradeable.initialize, (owner, IERC20(USDC), attester, feeTo, 100, 100_000, 1_000_000, 10_000_000, 50_000_000, 500_000_000, 1 days)))));
        deal(USDC, alice, 1_000e6);
        vm.prank(alice);
        IERC20(USDC).approve(address(p), type(uint256).max);
        vm.prank(alice);
        p.createClaim(bytes32(uint256(999)), keccak256("pre"), 5_000_000, uint64(block.timestamp + 7 days));
        DoviClaimV2 v2 = new DoviClaimV2();
        vm.prank(owner);
        p.scheduleUpgrade(address(v2), "");
        vm.warp(block.timestamp + 1 days);
        vm.prank(owner);
        p.upgradeToAndCall(address(v2), "");
        c = DoviClaimV2(address(p));
        vm.prank(owner);
        c.setExecutor(exec, true);
    }

    function _ids(uint256 n, uint256 base) internal pure returns (bytes32[] memory ids, bytes32[] memory hs, uint96[] memory amts) {
        ids = new bytes32[](n); hs = new bytes32[](n); amts = new uint96[](n);
        for (uint256 i = 0; i < n; i++) { ids[i] = bytes32(base + i); hs[i] = keccak256(abi.encode("h", i)); amts[i] = 1_000_000; }
    }

    function _sig(bytes32 id, address recipient, uint64 deadline) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", c.domainSeparator(), keccak256(abi.encode(c.ATTEST_TYPEHASH(), id, recipient, deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_upgradePreservesV1StateAndVersion() public {
        assertEq(c.implementationVersion(), 2);
        assertEq(c.totalLocked(), 5_100_000);
        (address sender,,,,,) = c.claims(bytes32(uint256(999)));
        assertEq(sender, alice);
        uint64 dl = uint64(block.timestamp + 1 hours);
        c.claim(bytes32(uint256(999)), bob, dl, _sig(bytes32(uint256(999)), bob, dl));
        assertEq(IERC20(USDC).balanceOf(bob), 5_000_000);
    }

    function test_batchLocksSumOnceAndEmitsEach() public {
        (bytes32[] memory ids, bytes32[] memory hs, uint96[] memory a) = _ids(5, 100);
        uint256 before = IERC20(USDC).balanceOf(alice);
        uint64 exp = uint64(block.timestamp + 7 days);
        vm.expectEmit(true, true, false, true);
        emit DoviClaimUpgradeable.ClaimCreated(ids[0], alice, hs[0], 1_000_000, 100_000, exp);
        vm.prank(alice);
        c.createBatch(ids, hs, a, exp);
        assertEq(before - IERC20(USDC).balanceOf(alice), 5 * 1_100_000);
        assertEq(c.totalLocked(), 5_100_000 + 5 * 1_100_000);
        for (uint256 i = 0; i < 5; i++) { (address s, uint96 amt,,, uint8 st,) = c.claims(ids[i]); assertEq(s, alice); assertEq(amt, 1_000_000); assertEq(st, 1); }
    }

    function test_batchIsAtomic() public {
        (bytes32[] memory ids, bytes32[] memory hs, uint96[] memory a) = _ids(3, 200);
        a[2] = 99_000_000;
        uint256 before = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(DoviClaimUpgradeable.BadAmount.selector);
        c.createBatch(ids, hs, a, uint64(block.timestamp + 7 days));
        assertEq(IERC20(USDC).balanceOf(alice), before);
        (,,,, uint8 st,) = c.claims(ids[0]);
        assertEq(st, 0);
    }

    function test_batchRejectsBadShapes() public {
        (bytes32[] memory ids, bytes32[] memory hs, uint96[] memory a) = _ids(3, 300);
        uint64 exp = uint64(block.timestamp + 7 days);
        bytes32[] memory shortHs = new bytes32[](2);
        vm.startPrank(alice);
        vm.expectRevert(DoviClaimV2.LengthMismatch.selector);
        c.createBatch(ids, shortHs, a, exp);
        vm.expectRevert(DoviClaimV2.EmptyBatch.selector);
        c.createBatch(new bytes32[](0), new bytes32[](0), new uint96[](0), exp);
        (bytes32[] memory bi, bytes32[] memory bh, uint96[] memory ba) = _ids(101, 400);
        vm.expectRevert(DoviClaimV2.BatchTooLarge.selector);
        c.createBatch(bi, bh, ba, exp);
        ids[1] = ids[0];
        vm.expectRevert(DoviClaimUpgradeable.Exists.selector);
        c.createBatch(ids, hs, a, exp);
        vm.stopPrank();
    }

    function test_batchHonoursDailyAndGlobalCapsAndPause() public {
        (bytes32[] memory ids, bytes32[] memory hs, uint96[] memory a) = _ids(51, 500);
        vm.prank(alice);
        vm.expectRevert(DoviClaimUpgradeable.CapExceeded.selector);
        c.createBatch(ids, hs, a, uint64(block.timestamp + 7 days));
        vm.prank(owner);
        c.setPaused(true);
        (bytes32[] memory i2, bytes32[] memory h2, uint96[] memory a2) = _ids(2, 600);
        vm.prank(alice);
        vm.expectRevert(DoviClaimUpgradeable.PausedError.selector);
        c.createBatch(i2, h2, a2, uint64(block.timestamp + 7 days));
    }

    function test_batchClaimsReclaimIndividually() public {
        (bytes32[] memory ids, bytes32[] memory hs, uint96[] memory a) = _ids(3, 700);
        vm.prank(alice);
        c.createBatch(ids, hs, a, uint64(block.timestamp + 7 days));
        uint256 before = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        c.reclaim(ids[1]);
        assertEq(IERC20(USDC).balanceOf(alice) - before, 1_100_000);
        uint64 dl = uint64(block.timestamp + 1 hours);
        c.claim(ids[0], bob, dl, _sig(ids[0], bob, dl));
        assertEq(IERC20(USDC).balanceOf(bob), 1_000_000);
    }

    function test_executorNeedsOptInAndRespectsLimits() public {
        bytes32 id = bytes32(uint256(800));
        uint64 exp = uint64(block.timestamp + 7 days);
        vm.prank(exec);
        vm.expectRevert(DoviClaimV2.AutoPayNotAllowed.selector);
        c.createClaimFor(alice, id, keccak256("r"), 2_000_000, exp);
        vm.prank(alice);
        c.setAutoPay(3_000_000, 5_000_000);
        vm.prank(exec);
        vm.expectRevert(DoviClaimV2.AutoPayLimit.selector);
        c.createClaimFor(alice, id, keccak256("r"), 4_000_000, exp);
        vm.prank(exec);
        c.createClaimFor(alice, id, keccak256("r"), 3_000_000, exp);
        vm.prank(exec);
        vm.expectRevert(DoviClaimV2.AutoPayLimit.selector);
        c.createClaimFor(alice, bytes32(uint256(801)), keccak256("r"), 3_000_000, exp);
        (address s,,,, uint8 st,) = c.claims(id);
        assertEq(s, alice);
        assertEq(st, 1);
    }

    function test_executorCannotMoveFundsOrBeImpersonated() public {
        vm.prank(alice);
        c.setAutoPay(3_000_000, 5_000_000);
        vm.prank(mallory);
        vm.expectRevert(DoviClaimV2.NotExecutor.selector);
        c.createClaimFor(alice, bytes32(uint256(900)), keccak256("r"), 1_000_000, uint64(block.timestamp + 7 days));
        uint256 execBefore = IERC20(USDC).balanceOf(exec);
        vm.prank(exec);
        c.createClaimFor(alice, bytes32(uint256(901)), keccak256("r"), 1_000_000, uint64(block.timestamp + 7 days));
        assertEq(IERC20(USDC).balanceOf(exec), execBefore);
    }

    function test_payerCanReclaimRevokeAndExecutorNeedsAllowance() public {
        vm.prank(alice);
        c.setAutoPay(3_000_000, 5_000_000);
        vm.prank(exec);
        c.createClaimFor(alice, bytes32(uint256(1000)), keccak256("r"), 2_000_000, uint64(block.timestamp + 7 days));
        uint256 before = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        c.reclaim(bytes32(uint256(1000)));
        assertEq(IERC20(USDC).balanceOf(alice) - before, 2_100_000);
        vm.prank(alice);
        c.setAutoPay(0, 0);
        vm.prank(exec);
        vm.expectRevert(DoviClaimV2.AutoPayNotAllowed.selector);
        c.createClaimFor(alice, bytes32(uint256(1001)), keccak256("r"), 1_000_000, uint64(block.timestamp + 7 days));
        vm.prank(alice);
        c.setAutoPay(3_000_000, 5_000_000);
        vm.prank(alice);
        IERC20(USDC).approve(address(c), 0);
        vm.prank(exec);
        vm.expectRevert();
        c.createClaimFor(alice, bytes32(uint256(1002)), keccak256("r"), 1_000_000, uint64(block.timestamp + 7 days));
    }

    function test_onlyOwnerSetsExecutorsAndReclaimWorksWhilePaused() public {
        vm.prank(mallory);
        vm.expectRevert();
        c.setExecutor(mallory, true);
        vm.prank(owner);
        vm.expectRevert(DoviClaimUpgradeable.ZeroAddress.selector);
        c.setExecutor(address(0), true);
        (bytes32[] memory ids, bytes32[] memory hs, uint96[] memory a) = _ids(2, 1100);
        vm.prank(alice);
        c.createBatch(ids, hs, a, uint64(block.timestamp + 7 days));
        vm.prank(owner);
        c.setPaused(true);
        vm.prank(alice);
        c.reclaim(ids[0]);
    }

    function testFuzz_batchBalanceMatchesLocked(uint8 n, uint96 amt) public {
        uint256 count = bound(n, 1, 20);
        uint96 each = uint96(bound(amt, 1_000_000, 2_000_000));
        bytes32[] memory ids = new bytes32[](count); bytes32[] memory hs = new bytes32[](count); uint96[] memory a = new uint96[](count);
        for (uint256 i = 0; i < count; i++) { ids[i] = bytes32(2000 + i); hs[i] = keccak256(abi.encode(i)); a[i] = each; }
        vm.prank(alice);
        try c.createBatch(ids, hs, a, uint64(block.timestamp + 7 days)) {} catch {}
        assertEq(IERC20(USDC).balanceOf(address(c)), c.totalLocked());
    }
}
