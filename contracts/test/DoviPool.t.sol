// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DoviPool} from "../src/DoviPool.sol";

contract Tok is ERC20 {
    uint8 private immutable _d;
    constructor(string memory n, uint8 d) ERC20(n, n) { _d = d; }
    function decimals() public view override returns (uint8) { return _d; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract FeeTok is ERC20 {
    constructor() ERC20("F", "F") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) { super._update(from, address(0), v / 10); super._update(from, to, v - v / 10); } else super._update(from, to, v);
    }
}

contract DoviPoolTest is Test {
    Tok usdc; Tok vibes; DoviPool pool;
    address boss = makeAddr("boss"); address alice = makeAddr("alice");

    function setUp() public {
        usdc = new Tok("USDC", 6); vibes = new Tok("VIBES", 18);
        pool = new DoviPool(IERC20(address(usdc)), IERC20(address(vibes)), boss);
        usdc.mint(boss, 1_000_000e6); vibes.mint(boss, 10_000_000e18);
        vm.startPrank(boss);
        usdc.approve(address(pool), type(uint256).max); vibes.approve(address(pool), type(uint256).max);
        pool.addLiquidity(5_000e6, 50_000e18);
        vm.stopPrank();
        usdc.mint(alice, 1_000e6); vibes.mint(alice, 1_000e18);
        vm.startPrank(alice); usdc.approve(address(pool), type(uint256).max); vibes.approve(address(pool), type(uint256).max); vm.stopPrank();
    }

    function test_quote_matches_the_formula_and_a_swap_pays_it() public {
        uint256 q = pool.quote(address(usdc), 10e6);
        uint256 inFee = uint256(10e6) * 9970; uint256 expected = (inFee * 50_000e18) / (uint256(5_000e6) * 10_000 + inFee);
        assertEq(q, expected);
        vm.prank(alice);
        uint256 out = pool.swap(address(usdc), 10e6, q, alice);
        assertEq(out, q);
        assertEq(vibes.balanceOf(alice), 1_000e18 + q);
        assertEq(pool.reserveA(), 5_010e6);
        assertEq(pool.reserveB(), 50_000e18 - q);
    }

    function test_both_directions_and_the_fee_grows_the_pool() public {
        uint256 k0 = pool.reserveA() * pool.reserveB();
        vm.startPrank(alice);
        uint256 v = pool.swap(address(usdc), 100e6, 0, alice);
        pool.swap(address(vibes), v, 0, alice);
        vm.stopPrank();
        assertGt(pool.reserveA() * pool.reserveB(), k0);
        assertLt(usdc.balanceOf(alice), 1_000e6);
    }

    function test_slippage_protection() public {
        uint256 q = pool.quote(address(usdc), 10e6);
        vm.prank(alice);
        vm.expectRevert(DoviPool.Slippage.selector);
        pool.swap(address(usdc), 10e6, q + 1, alice);
    }

    function test_unknown_token_zero_amount_and_dust() public {
        vm.startPrank(alice);
        vm.expectRevert(DoviPool.BadToken.selector);
        pool.swap(address(0xBEEF), 1, 0, alice);
        vm.expectRevert(DoviPool.ZeroAmount.selector);
        pool.swap(address(usdc), 0, 0, alice);
        vm.expectRevert(DoviPool.Slippage.selector);
        pool.swap(address(vibes), 1, 0, alice);
        vm.stopPrank();
    }

    function test_only_the_owner_manages_liquidity_and_can_pull_it_out() public {
        vm.prank(alice);
        vm.expectRevert(DoviPool.NotOwner.selector);
        pool.addLiquidity(1e6, 1e18);
        vm.prank(alice);
        vm.expectRevert(DoviPool.NotOwner.selector);
        pool.removeLiquidity(alice);
        vm.prank(boss);
        pool.removeLiquidity(boss);
        assertEq(pool.reserveA(), 0);
        vm.expectRevert(DoviPool.NoLiquidity.selector);
        pool.quote(address(usdc), 1e6);
    }

    function test_a_token_that_takes_a_cut_is_refused() public {
        FeeTok ft = new FeeTok();
        DoviPool p2 = new DoviPool(IERC20(address(usdc)), IERC20(address(ft)), boss);
        ft.mint(boss, 1_000e18); usdc.mint(boss, 1_000e6);
        vm.startPrank(boss); usdc.approve(address(p2), type(uint256).max); ft.approve(address(p2), type(uint256).max);
        vm.expectRevert();
        p2.addLiquidity(100e6, 100e18);
        vm.stopPrank();
    }

    function testFuzz_a_swap_never_lowers_the_product(uint96 amt, bool dir) public {
        uint256 k0 = pool.reserveA() * pool.reserveB();
        if (dir) { amt = uint96(bound(amt, 1e5, 900e6)); vm.prank(alice); try pool.swap(address(usdc), amt, 0, alice) {} catch {} }
        else { amt = uint96(bound(amt, 1e17, 900e18)); vm.prank(alice); try pool.swap(address(vibes), amt, 0, alice) {} catch {} }
        assertGe(pool.reserveA() * pool.reserveB(), k0);
    }
}
