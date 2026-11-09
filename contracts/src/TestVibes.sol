// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// A test token for the Base Sepolia test network. It has no value. Anyone can take 100 once an hour from their own address.
/// The owner can mint more to stock the test swap pool.
contract TestVibes is ERC20 {
    uint256 public constant DRIP = 100e18;
    uint256 public constant COOLDOWN = 1 hours;

    address public immutable owner;
    mapping(address => uint256) public lastDrip;

    error TooSoon();
    error NotOwner();

    constructor(address owner_) ERC20("Vibes (test)", "VIBES") { owner = owner_; }

    function faucet() external {
        if (block.timestamp < lastDrip[msg.sender] + COOLDOWN) revert TooSoon();
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, DRIP);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _mint(to, amount);
    }
}
