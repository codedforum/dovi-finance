// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// A constant product pool for two tokens. A 0.3 percent fee on each swap stays in the pool. Only the owner adds or removes
/// liquidity; anyone can swap. Reserves are kept in the pool's own accounting so tokens sent in directly are not priced.
contract DoviPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 30;

    IERC20 public immutable tokenA;
    IERC20 public immutable tokenB;
    address public immutable owner;
    uint256 public reserveA;
    uint256 public reserveB;

    event LiquidityAdded(uint256 amountA, uint256 amountB);
    event LiquidityRemoved(address indexed to, uint256 amountA, uint256 amountB);
    event Swap(address indexed trader, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    error NotOwner();
    error BadToken();
    error ZeroAmount();
    error NoLiquidity();
    error Slippage();
    error ZeroAddress();

    constructor(IERC20 a, IERC20 b, address owner_) {
        if (address(a) == address(0) || address(b) == address(0) || owner_ == address(0) || a == b) revert ZeroAddress();
        tokenA = a;
        tokenB = b;
        owner = owner_;
    }

    function addLiquidity(uint256 amountA, uint256 amountB) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        if (amountA == 0 || amountB == 0) revert ZeroAmount();
        uint256 beforeA = tokenA.balanceOf(address(this));
        uint256 beforeB = tokenB.balanceOf(address(this));
        tokenA.safeTransferFrom(msg.sender, address(this), amountA);
        tokenB.safeTransferFrom(msg.sender, address(this), amountB);
        if (tokenA.balanceOf(address(this)) - beforeA != amountA || tokenB.balanceOf(address(this)) - beforeB != amountB) revert BadToken();
        reserveA += amountA;
        reserveB += amountB;
        emit LiquidityAdded(amountA, amountB);
    }

    function removeLiquidity(address to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        uint256 a = tokenA.balanceOf(address(this));
        uint256 b = tokenB.balanceOf(address(this));
        reserveA = 0;
        reserveB = 0;
        tokenA.safeTransfer(to, a);
        tokenB.safeTransfer(to, b);
        emit LiquidityRemoved(to, a, b);
    }

    function quote(address tokenIn, uint256 amountIn) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = _reserves(tokenIn);
        if (rIn == 0 || rOut == 0) revert NoLiquidity();
        uint256 inWithFee = amountIn * (10_000 - FEE_BPS);
        return (inWithFee * rOut) / (rIn * 10_000 + inWithFee);
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minOut, address to) external nonReentrant returns (uint256 out) {
        if (amountIn == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        out = quote(tokenIn, amountIn);
        if (out == 0 || out < minOut) revert Slippage();
        bool aIn = tokenIn == address(tokenA);
        IERC20 tin = aIn ? tokenA : tokenB;
        IERC20 tout = aIn ? tokenB : tokenA;
        uint256 before = tin.balanceOf(address(this));
        tin.safeTransferFrom(msg.sender, address(this), amountIn);
        if (tin.balanceOf(address(this)) - before != amountIn) revert BadToken();
        if (aIn) { reserveA += amountIn; reserveB -= out; } else { reserveB += amountIn; reserveA -= out; }
        tout.safeTransfer(to, out);
        emit Swap(msg.sender, tokenIn, amountIn, out);
    }

    function _reserves(address tokenIn) internal view returns (uint256 rIn, uint256 rOut) {
        if (tokenIn == address(tokenA)) return (reserveA, reserveB);
        if (tokenIn == address(tokenB)) return (reserveB, reserveA);
        revert BadToken();
    }
}
