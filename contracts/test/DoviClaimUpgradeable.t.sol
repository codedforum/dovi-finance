// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DoviClaimUpgradeable as DoviClaim} from "../src/DoviClaimUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract DoviClaimUpgradeableTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    DoviClaim c;
    DoviClaim impl;
    uint256 attesterPk = 0xA11CE;
    address attester;
    address owner = makeAddr("owner");
    address feeTo = makeAddr("feeTo");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    bytes32 hashA = keccak256("dovi:v1:x:123");

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        attester = vm.addr(attesterPk);
        impl = new DoviClaim();
        c = DoviClaim(address(new ERC1967Proxy(address(impl), abi.encodeCall(DoviClaim.initialize, (owner, IERC20(USDC), attester, feeTo, 100, 100_000, 1_000_000, 10_000_000, 50_000_000, 500_000_000, 1 days)))));
        for (uint256 i = 0; i < 3; i++) {
            address who = i == 0 ? alice : i == 1 ? bob : carol;
            deal(USDC, who, 1_000e6);
            vm.prank(who);
            IERC20(USDC).approve(address(c), type(uint256).max);
        }
    }

    function _create(address who, bytes32 id, uint96 amount) internal {
        vm.prank(who);
        c.createClaim(id, hashA, amount, uint64(block.timestamp + 7 days));
    }

    function _sig(bytes32 id, address recipient, uint64 deadline, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(c.ATTEST_TYPEHASH(), id, recipient, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", c.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _claim(bytes32 id, address to) internal {
        uint64 dl = uint64(block.timestamp + 1 hours);
        c.claim(id, to, dl, _sig(id, to, dl, attesterPk));
    }

    function test_createLocksAmountPlusFeeAndEmits() public {
        uint256 before = IERC20(USDC).balanceOf(alice);
        vm.expectEmit(true, true, false, true);
        emit DoviClaim.ClaimCreated(bytes32(uint256(1)), alice, hashA, 5_000_000, 100_000, uint64(block.timestamp + 7 days));
        _create(alice, bytes32(uint256(1)), 5_000_000);
        assertEq(before - IERC20(USDC).balanceOf(alice), 5_100_000);
        assertEq(IERC20(USDC).balanceOf(address(c)), 5_100_000);
        assertEq(c.totalLocked(), 5_100_000);
    }

    function test_feeIsOnePercentWithMinimumAndMax() public view {
        assertEq(c.quoteFee(1_000_000), 100_000);
        assertEq(c.quoteFee(10_000_000), 100_000);
        assertEq(c.quoteFee(50_000_000), 500_000);
        assertEq(c.MAX_FEE_BPS(), 150);
    }

    function test_claimPaysRecipientAmountAndFeeRecipientFee() public {
        _create(alice, bytes32(uint256(1)), 5_000_000);
        uint256 r0 = IERC20(USDC).balanceOf(bob);
        _claim(bytes32(uint256(1)), bob);
        assertEq(IERC20(USDC).balanceOf(bob) - r0, 5_000_000);
        assertEq(IERC20(USDC).balanceOf(feeTo), 100_000);
        assertEq(c.totalLocked(), 0);
        assertEq(IERC20(USDC).balanceOf(address(c)), 0);
    }

    function test_reclaimReturnsAmountPlusFeeAndPaysNoFee() public {
        uint256 before = IERC20(USDC).balanceOf(alice);
        _create(alice, bytes32(uint256(1)), 5_000_000);
        vm.prank(alice);
        c.reclaim(bytes32(uint256(1)));
        assertEq(IERC20(USDC).balanceOf(alice), before);
        assertEq(IERC20(USDC).balanceOf(feeTo), 0);
        assertEq(c.totalLocked(), 0);
    }

    function test_doubleClaimReverts() public {
        _create(alice, bytes32(uint256(1)), 5_000_000);
        _claim(bytes32(uint256(1)), bob);
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sig(bytes32(uint256(1)), bob, dl, attesterPk);
        vm.expectRevert(DoviClaim.NotOpen.selector);
        c.claim(bytes32(uint256(1)), bob, dl, sig);
    }

    function test_claimAfterExpiryReverts() public {
        _create(alice, bytes32(uint256(1)), 5_000_000);
        vm.warp(block.timestamp + 7 days + 1);
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sig(bytes32(uint256(1)), bob, dl, attesterPk);
        vm.expectRevert(DoviClaim.Expired.selector);
        c.claim(bytes32(uint256(1)), bob, dl, sig);
    }

    function test_claimExactlyAtExpiryStillWorks() public {
        _create(alice, bytes32(uint256(1)), 5_000_000);
        vm.warp(block.timestamp + 7 days);
        _claim(bytes32(uint256(1)), bob);
        assertEq(c.totalLocked(), 0);
    }

    function test_wrongSignerWrongRecipientExpiredDeadlineAndReplayRevert() public {
        _create(alice, bytes32(uint256(1)), 5_000_000);
        _create(alice, bytes32(uint256(2)), 5_000_000);
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory bad = _sig(bytes32(uint256(1)), bob, dl, 0xBEEF);
        vm.expectRevert(DoviClaim.BadSignature.selector);
        c.claim(bytes32(uint256(1)), bob, dl, bad);
        bytes memory forBob = _sig(bytes32(uint256(1)), bob, dl, attesterPk);
        vm.expectRevert(DoviClaim.BadSignature.selector);
        c.claim(bytes32(uint256(1)), carol, dl, forBob);
        bytes memory forClaim1 = _sig(bytes32(uint256(1)), bob, dl, attesterPk);
        vm.expectRevert(DoviClaim.BadSignature.selector);
        c.claim(bytes32(uint256(2)), bob, dl, forClaim1);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(DoviClaim.DeadlinePassed.selector);
        c.claim(bytes32(uint256(1)), bob, dl, forBob);
    }

    function test_claimAfterReclaimAndReclaimAfterClaimRevert() public {
        _create(alice, bytes32(uint256(1)), 5_000_000);
        _create(alice, bytes32(uint256(2)), 5_000_000);
        vm.prank(alice);
        c.reclaim(bytes32(uint256(1)));
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sig(bytes32(uint256(1)), bob, dl, attesterPk);
        vm.expectRevert(DoviClaim.NotOpen.selector);
        c.claim(bytes32(uint256(1)), bob, dl, sig);
        _claim(bytes32(uint256(2)), bob);
        vm.prank(alice);
        vm.expectRevert(DoviClaim.NotOpen.selector);
        c.reclaim(bytes32(uint256(2)));
    }

    function test_onlySenderCanReclaim() public {
        _create(alice, bytes32(uint256(1)), 5_000_000);
        vm.prank(bob);
        vm.expectRevert(DoviClaim.NotSender.selector);
        c.reclaim(bytes32(uint256(1)));
    }

    function test_capsAndMinimumRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(DoviClaim.BadAmount.selector);
        c.createClaim(bytes32(uint256(1)), hashA, 999_999, uint64(block.timestamp + 1 days));
        vm.expectRevert(DoviClaim.BadAmount.selector);
        c.createClaim(bytes32(uint256(1)), hashA, 10_000_001, uint64(block.timestamp + 1 days));
        vm.stopPrank();
        for (uint256 i = 1; i <= 5; i++) _create(alice, bytes32(i), 10_000_000);
        vm.startPrank(alice);
        vm.expectRevert(DoviClaim.CapExceeded.selector);
        c.createClaim(bytes32(uint256(6)), hashA, 1_000_000, uint64(block.timestamp + 1 days));
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
        _create(alice, bytes32(uint256(7)), 10_000_000);
    }

    function test_globalCapReverts() public {
        vm.prank(owner);
        c.setCaps(10_000_000, 50_000_000, 11_000_000);
        _create(alice, bytes32(uint256(1)), 10_000_000);
        vm.prank(bob);
        vm.expectRevert(DoviClaim.CapExceeded.selector);
        c.createClaim(bytes32(uint256(2)), hashA, 1_000_000, uint64(block.timestamp + 1 days));
    }

    function test_expiryBoundsAndDuplicateIdAndZeroHash() public {
        vm.startPrank(alice);
        vm.expectRevert(DoviClaim.BadExpiry.selector);
        c.createClaim(bytes32(uint256(1)), hashA, 1_000_000, uint64(block.timestamp));
        vm.expectRevert(DoviClaim.BadExpiry.selector);
        c.createClaim(bytes32(uint256(1)), hashA, 1_000_000, uint64(block.timestamp + 31 days));
        vm.expectRevert(DoviClaim.BadRecipient.selector);
        c.createClaim(bytes32(uint256(1)), bytes32(0), 1_000_000, uint64(block.timestamp + 1 days));
        c.createClaim(bytes32(uint256(1)), hashA, 1_000_000, uint64(block.timestamp + 1 days));
        vm.expectRevert(DoviClaim.Exists.selector);
        c.createClaim(bytes32(uint256(1)), hashA, 1_000_000, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function test_pauseBlocksCreateAndClaimButNotReclaim() public {
        _create(alice, bytes32(uint256(1)), 5_000_000);
        vm.prank(owner);
        c.setPaused(true);
        vm.prank(bob);
        vm.expectRevert(DoviClaim.PausedError.selector);
        c.createClaim(bytes32(uint256(2)), hashA, 1_000_000, uint64(block.timestamp + 1 days));
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sig(bytes32(uint256(1)), bob, dl, attesterPk);
        vm.expectRevert(DoviClaim.PausedError.selector);
        c.claim(bytes32(uint256(1)), bob, dl, sig);
        vm.prank(alice);
        c.reclaim(bytes32(uint256(1)));
        assertEq(c.totalLocked(), 0);
    }

    function test_feeCannotExceedHardMaximumAndOnlyOwnerCanAdminister() public {
        vm.prank(owner);
        vm.expectRevert(DoviClaim.FeeTooHigh.selector);
        c.setFee(151, 100_000);
        vm.prank(owner);
        vm.expectRevert(DoviClaim.FeeTooHigh.selector);
        c.setFee(100, 1_000_001);
        vm.prank(owner);
        c.setFee(150, 100_000);
        vm.prank(alice);
        vm.expectRevert();
        c.setFee(0, 0);
        vm.prank(alice);
        vm.expectRevert();
        c.setAttester(alice);
        vm.prank(alice);
        vm.expectRevert();
        c.setPaused(true);
        vm.prank(owner);
        vm.expectRevert(DoviClaim.ZeroAddress.selector);
        c.setAttester(address(0));
    }

    function test_ownerHasNoWayToMoveLockedFunds() public {
        _create(alice, bytes32(uint256(1)), 5_000_000);
        vm.prank(owner);
        c.setAttester(makeAddr("other"));
        vm.prank(owner);
        c.setFeeRecipient(makeAddr("newFee"));
        vm.prank(owner);
        c.setPaused(true);
        assertEq(IERC20(USDC).balanceOf(address(c)), 5_100_000);
        vm.prank(alice);
        c.reclaim(bytes32(uint256(1)));
        assertEq(IERC20(USDC).balanceOf(address(c)), 0);
    }

    function test_twoStepOwnershipTransfer() public {
        address next = makeAddr("next");
        vm.prank(owner);
        c.transferOwnership(next);
        assertEq(c.owner(), owner);
        vm.prank(next);
        c.acceptOwnership();
        assertEq(c.owner(), next);
    }

    function testFuzz_balanceAlwaysMatchesLocked(uint8 mask, uint96 a, uint96 b, uint96 d) public {
        uint96[3] memory amt = [uint96(bound(a, 1_000_000, 10_000_000)), uint96(bound(b, 1_000_000, 10_000_000)), uint96(bound(d, 1_000_000, 10_000_000))];
        address[3] memory who = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) _create(who[i], bytes32(i + 1), amt[i]);
        for (uint256 i = 0; i < 3; i++) {
            uint8 action = (mask >> (i * 2)) & 3;
            if (action == 1) _claim(bytes32(i + 1), makeAddr("rcpt"));
            if (action == 2) {
                vm.prank(who[i]);
                c.reclaim(bytes32(i + 1));
            }
        }
        assertEq(IERC20(USDC).balanceOf(address(c)), c.totalLocked());
    }
}
