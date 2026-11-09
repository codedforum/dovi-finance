// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestVibes} from "../src/TestVibes.sol";

contract TestVibesTest is Test {
    TestVibes t;
    address alice = makeAddr("alice");
    address boss = makeAddr("boss");

    function setUp() public { t = new TestVibes(boss); vm.warp(1_000_000); }

    function test_faucet_gives_100_then_waits_an_hour() public {
        vm.prank(alice);
        t.faucet();
        assertEq(t.balanceOf(alice), 100e18);
        vm.prank(alice);
        vm.expectRevert(TestVibes.TooSoon.selector);
        t.faucet();
        skip(1 hours);
        vm.prank(alice);
        t.faucet();
        assertEq(t.balanceOf(alice), 200e18);
        assertEq(t.decimals(), 18);
    }

    function test_only_the_owner_mints() public {
        vm.prank(alice);
        vm.expectRevert(TestVibes.NotOwner.selector);
        t.mint(alice, 1e18);
        vm.prank(boss);
        t.mint(alice, 5e18);
        assertEq(t.balanceOf(alice), 5e18);
    }
}
