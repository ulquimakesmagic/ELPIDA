// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IElpidaV4Hook {
    function poolKey(address token) external view returns (PoolKey memory);
    function currentFeeBps(address token) external view returns (uint256);
}

interface IV4RouterToken {
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @notice Model 11 PROTOTYPE router: buys and sells one Elpida v4 launch at a time, exact input, through the
/// PoolManager. NOT AUDITED; test networks only. A v4 launch has no curve contract of its own to call, so the site
/// trades through this router: one transaction, one approval of this router for an ERC-20 input (no Permit2), and a
/// `Swapped` event that names the real trader (the hook's Fee event can only see the router).
/// @dev Holds nothing between transactions. A native buy refunds any value the swap did not use.
contract ElpidaV4Router is IUnlockCallback {
    IPoolManager public immutable poolManager;
    IElpidaV4Hook public immutable hook;
    uint256 public constant ROUTER_VERSION = 1;

    event Swapped(address indexed token, address indexed trader, address indexed recipient, bool buy, uint256 quoteAmount, uint256 tokenAmount);

    error Expired();
    error Slippage(uint256 out, uint256 minimum);
    /// Carries a simulated swap's result out of `quote`; never seen by a caller.
    error QuoteResult(uint256 paid, uint256 out);

    bool private entered;
    modifier nonReentrant() { require(!entered, "reentrancy"); entered = true; _; entered = false; }

    constructor(IPoolManager manager, IElpidaV4Hook hook_) {
        require(address(manager) != address(0) && address(hook_) != address(0), "zero address");
        poolManager = manager; hook = hook_;
    }

    /// Spends `quoteIn` of the token's quote (ETH as msg.value, or an ERC-20 this router may pull) on the token.
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) external payable nonReentrant returns (uint256 tokensOut) {
        PoolKey memory key = _key(token);
        bool native = Currency.unwrap(key.currency0) == address(0);
        require(native ? msg.value == quoteIn : msg.value == 0, "value");
        uint256 paid;
        (paid, tokensOut) = _trade(token, key, true, quoteIn, minTokensOut, recipient, deadline);
        if (native && paid < quoteIn) {
            (bool ok,) = msg.sender.call{value: quoteIn - paid}("");
            require(ok, "refund");
        }
    }

    /// Sells `tokensIn` of the token (pulled from the caller, who approved this router) for its quote.
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline) external nonReentrant returns (uint256 quoteOut) {
        PoolKey memory key = _key(token);
        (, quoteOut) = _trade(token, key, false, tokensIn, minQuoteOut, recipient, deadline);
    }

    /// The exact result of a buy or sell of `amountIn` now, fees included: what was paid and what would come out.
    /// Not a view (it runs the swap and undoes it); call it with eth_call.
    function quote(address token, bool isBuy, uint256 amountIn) external returns (uint256 paid, uint256 out) {
        PoolKey memory key = _key(token);
        try poolManager.unlock(abi.encode(true, address(0), address(0), key, isBuy, amountIn)) {
            revert("quote");
        } catch (bytes memory reason) {
            if (reason.length != 68 || bytes4(reason) != QuoteResult.selector) assembly { revert(add(reason, 32), mload(reason)) }
            assembly { paid := mload(add(reason, 36)) out := mload(add(reason, 68)) }
        }
    }

    function _trade(address token, PoolKey memory key, bool isBuy, uint256 amountIn, uint256 minOut, address recipient, uint256 deadline) private returns (uint256 paid, uint256 out) {
        if (block.timestamp > deadline) revert Expired();
        require(amountIn > 0 && amountIn <= uint256(type(int256).max) && recipient != address(0), "trade terms");
        (paid, out) = abi.decode(poolManager.unlock(abi.encode(false, msg.sender, recipient, key, isBuy, amountIn)), (uint256, uint256));
        if (out < minOut) revert Slippage(out, minOut);
        emit Swapped(token, msg.sender, recipient, isBuy, isBuy ? paid : out, isBuy ? out : paid);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "pool manager only");
        (bool quoting, address payer, address recipient, PoolKey memory key, bool isBuy, uint256 amountIn) = abi.decode(data, (bool, address, address, PoolKey, bool, uint256));
        BalanceDelta d = poolManager.swap(key, SwapParams(isBuy, -int256(amountIn), isBuy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), "");
        // Deltas are the router's: negative is owed to the pool, positive is due to the router.
        int128 a0 = d.amount0(); int128 a1 = d.amount1();
        uint256 paid = uint256(int256(isBuy ? -a0 : -a1));
        uint256 out = uint256(int256(isBuy ? a1 : a0));
        if (quoting) revert QuoteResult(paid, out);
        Currency input = isBuy ? key.currency0 : key.currency1;
        if (Currency.unwrap(input) == address(0)) poolManager.settle{value: paid}();
        else {
            poolManager.sync(input);
            require(IV4RouterToken(Currency.unwrap(input)).transferFrom(payer, address(poolManager), paid), "payment");
            poolManager.settle();
        }
        if (out > 0) poolManager.take(isBuy ? key.currency1 : key.currency0, recipient, out);
        return abi.encode(paid, out);
    }

    /// The token's pool, or a revert if the hook never launched it.
    function _key(address token) private view returns (PoolKey memory key) {
        hook.currentFeeBps(token);
        key = hook.poolKey(token);
    }
}
