// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {DoviClaimUpgradeable} from "../src/DoviClaimUpgradeable.sol";
import {DoviClaimV2} from "../src/DoviClaimV2.sol";
import {DoviClaimV3} from "../src/DoviClaimV3.sol";
import {DoviClaimV4} from "../src/DoviClaimV4.sol";

contract MockToken is ERC20 {
    uint8 private immutable _d;
    constructor(string memory n, uint8 d) ERC20(n, n) { _d = d; }
    function decimals() public view override returns (uint8) { return _d; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract FeeToken is ERC20 {
    constructor() ERC20("FEE", "FEE") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) { super._update(from, address(0), value / 10); super._update(from, to, value - value / 10); } else { super._update(from, to, value); }
    }
}

contract DoviClaimV4Test is Test {
    MockToken usdc;
    MockToken vibes;
    DoviClaimV4 c;
    uint256 attesterPk = 0xA11CE;
    address attester;
    address owner = makeAddr("owner");
    address feeTo = makeAddr("feeTo");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");

    function setUp() public {
        attester = vm.addr(attesterPk);
        usdc = new MockToken("USDC", 6);
        vibes = new MockToken("VIBES", 18);
        DoviClaimUpgradeable v1 = new DoviClaimUpgradeable();
        DoviClaimUpgradeable p = DoviClaimUpgradeable(address(new ERC1967Proxy(address(v1), abi.encodeCall(DoviClaimUpgradeable.initialize, (owner, IERC20(address(usdc)), attester, feeTo, 100, 100_000, 1_000_000, 1_000_000_000, 5_000_000_000, 50_000_000_000, 0)))));
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(p), type(uint256).max);
        vm.prank(alice);
        p.createClaim(bytes32(uint256(999)), keccak256("pre"), 5_000_000, uint64(block.timestamp + 7 days));
        address[3] memory impls = [address(new DoviClaimV2()), address(new DoviClaimV3()), address(new DoviClaimV4())];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(owner);
            p.scheduleUpgrade(impls[i], "");
            vm.prank(owner);
            p.upgradeToAndCall(impls[i], "");
        }
        c = DoviClaimV4(address(p));
        vm.prank(owner);
        c.setToken(address(vibes), true, 1e18, 1_000e18, 10_000e18);
        vibes.mint(alice, 5_000e18);
        vm.prank(alice);
        vibes.approve(address(c), type(uint256).max);
    }

    function _sig(bytes32 id, address recipient, uint64 deadline) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", c.domainSeparator(), keccak256(abi.encode(c.ATTEST_TYPEHASH(), id, recipient, deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_version_and_old_claim_survive() public view {
        assertEq(c.implementationVersion(), 4);
        (address s,, , , uint8 st,) = c.claims(bytes32(uint256(999)));
        assertEq(s, alice);
        assertEq(st, 1);
    }

    function test_create_claim_token_roundtrip() public {
        bytes32 id = bytes32(uint256(1));
        vm.prank(alice);
        c.createTokenClaim(address(vibes), id, keccak256("bob"), 10e18, uint64(block.timestamp + 7 days));
        assertEq(vibes.balanceOf(address(c)), 10e18);
        (,,,,uint96 locked) = c.tokens(address(vibes));
        assertEq(locked, 10e18);
        bytes memory sig = _sig(id, bob, uint64(block.timestamp + 1 hours));
        c.claimToken(id, bob, uint64(block.timestamp + 1 hours), sig);
        assertEq(vibes.balanceOf(bob), 10e18);
        (,,,,locked) = c.tokens(address(vibes));
        assertEq(locked, 0);
        vm.expectRevert(DoviClaimUpgradeable.NotOpen.selector);
        c.claimToken(id, bob, uint64(block.timestamp + 1 hours), sig);
    }

    function test_reclaim_token() public {
        bytes32 id = bytes32(uint256(2));
        vm.prank(alice);
        c.createTokenClaim(address(vibes), id, keccak256("bob"), 20e18, uint64(block.timestamp + 7 days));
        vm.prank(mallory);
        vm.expectRevert(DoviClaimUpgradeable.NotSender.selector);
        c.reclaimToken(id);
        uint256 before = vibes.balanceOf(alice);
        vm.prank(alice);
        c.reclaimToken(id);
        assertEq(vibes.balanceOf(alice), before + 20e18);
    }

    function test_main_claim_path_cannot_touch_token_claim() public {
        bytes32 id = bytes32(uint256(3));
        vm.prank(alice);
        c.createTokenClaim(address(vibes), id, keccak256("bob"), 10e18, uint64(block.timestamp + 7 days));
        bytes memory sig = _sig(id, bob, uint64(block.timestamp + 1 hours));
        vm.expectRevert(DoviClaimUpgradeable.NotOpen.selector);
        c.claim(id, bob, uint64(block.timestamp + 1 hours), sig);
        vm.prank(alice);
        vm.expectRevert(DoviClaimUpgradeable.NotOpen.selector);
        c.reclaim(id);
    }

    function test_limits_and_switches() public {
        uint64 exp = uint64(block.timestamp + 7 days);
        vibes.mint(alice, 10_000e18);
        vm.startPrank(alice);
        vm.expectRevert(DoviClaimUpgradeable.BadAmount.selector);
        c.createTokenClaim(address(vibes), bytes32(uint256(4)), keccak256("x"), 0.5e18, exp);
        vm.expectRevert(DoviClaimUpgradeable.BadAmount.selector);
        c.createTokenClaim(address(vibes), bytes32(uint256(4)), keccak256("x"), 2_000e18, exp);
        vm.expectRevert(DoviClaimUpgradeable.BadRecipient.selector);
        c.createTokenClaim(address(vibes), bytes32(uint256(4)), bytes32(0), 5e18, exp);
        vm.expectRevert(DoviClaimUpgradeable.BadExpiry.selector);
        c.createTokenClaim(address(vibes), bytes32(uint256(4)), keccak256("x"), 5e18, uint64(block.timestamp + 31 days));
        vm.expectRevert(DoviClaimV4.TokenNotEnabled.selector);
        c.createTokenClaim(address(usdc), bytes32(uint256(4)), keccak256("x"), 5e18, exp);
        for (uint256 i = 0; i < 10; i++) c.createTokenClaim(address(vibes), bytes32(uint256(100 + i)), keccak256("x"), 1_000e18, exp);
        vm.expectRevert(DoviClaimUpgradeable.CapExceeded.selector);
        c.createTokenClaim(address(vibes), bytes32(uint256(200)), keccak256("x"), 5e18, exp);
        vm.stopPrank();
        vm.prank(owner);
        c.setToken(address(vibes), false, 1e18, 1_000e18, 10_000e18);
        vm.prank(alice);
        vm.expectRevert(DoviClaimV4.TokenNotEnabled.selector);
        c.createTokenClaim(address(vibes), bytes32(uint256(300)), keccak256("x"), 5e18, exp);
    }

    function test_only_owner_and_main_token_refused() public {
        vm.prank(mallory);
        vm.expectRevert();
        c.setToken(address(vibes), true, 1e18, 1e18, 1e18);
        vm.prank(owner);
        vm.expectRevert(DoviClaimV4.BadToken.selector);
        c.setToken(address(usdc), true, 1e6, 1e6, 1e6);
    }

    function test_pause_and_duplicate_ids() public {
        bytes32 id = bytes32(uint256(5));
        vm.prank(alice);
        c.createTokenClaim(address(vibes), id, keccak256("x"), 5e18, uint64(block.timestamp + 7 days));
        vm.prank(alice);
        vm.expectRevert(DoviClaimUpgradeable.Exists.selector);
        c.createTokenClaim(address(vibes), id, keccak256("x"), 5e18, uint64(block.timestamp + 7 days));
        vm.prank(alice);
        vm.expectRevert(DoviClaimUpgradeable.Exists.selector);
        c.createTokenClaim(address(vibes), bytes32(uint256(999)), keccak256("x"), 5e18, uint64(block.timestamp + 7 days));
        vm.prank(owner);
        c.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(DoviClaimUpgradeable.PausedError.selector);
        c.createTokenClaim(address(vibes), bytes32(uint256(6)), keccak256("x"), 5e18, uint64(block.timestamp + 7 days));
    }

    function test_fee_on_transfer_token_refused() public {
        FeeToken ft = new FeeToken();
        vm.prank(owner);
        c.setToken(address(ft), true, 1, 1_000e18, 10_000e18);
        ft.mint(alice, 100e18);
        vm.startPrank(alice);
        ft.approve(address(c), type(uint256).max);
        vm.expectRevert(DoviClaimV4.TransferShort.selector);
        c.createTokenClaim(address(ft), bytes32(uint256(7)), keccak256("x"), 10e18, uint64(block.timestamp + 7 days));
        vm.stopPrank();
    }

    function test_bad_signature_and_expiry() public {
        bytes32 id = bytes32(uint256(8));
        vm.prank(alice);
        c.createTokenClaim(address(vibes), id, keccak256("x"), 5e18, uint64(block.timestamp + 1 days));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, keccak256("nope"));
        vm.expectRevert(DoviClaimUpgradeable.BadSignature.selector);
        c.claimToken(id, bob, uint64(block.timestamp + 1 hours), abi.encodePacked(r, s, v));
        bytes memory sig = _sig(id, bob, uint64(block.timestamp + 3 days));
        skip(2 days);
        vm.expectRevert(DoviClaimUpgradeable.Expired.selector);
        c.claimToken(id, bob, uint64(block.timestamp + 1 hours), sig);
        vm.prank(alice);
        c.reclaimToken(id);
    }
}
