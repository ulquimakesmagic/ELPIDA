// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

interface IV4Token {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice Model 11 PROTOTYPE: Model 10's curve inside one Uniswap v4 pool, with the liquidity locked from the first
/// trade. NOT AUDITED. Local chain only; never deployed. See docs/LOCKED_FROM_LAUNCH_V4_FEASIBILITY.md.
/// @dev currency0 is always the quote (ETH as address 0, or an approved ERC-20 such as USDC; the factory deploys the
/// token at an address above the quote's to keep that order) and currency1 the launched token, so the v4 price is
/// tokens per quote unit and a buy is zeroForOne. At launch the hook owns two positions for ever:
///  - sale:  [lowerTick, upperTick] with liquidity L, all tokens (the launch price is upperTick);
///  - upper: [MIN_USABLE_TICK, lowerTick] with L' = L (1 - 1/sqrt(r)), the 240M tokens above 10x.
/// lowerTick = upperTick - 23,030 ticks, a 10.003x price move. When a buy first takes the price to lowerTick the sale
/// position holds only quote; the hook moves it to [lowerTick, MAX_USABLE_TICK] (the milestone). With the upper position that is
/// the full-range pool Model 10 graduates into, in the same pool. The pool's LP fee is 0: the hook charges Model 10's
/// fee in the quote on every swap (1.25%, anti-snipe from 90% over 60 s; 1% after the milestone) and splits it like
/// Model 10. Third-party liquidity is refused until the treasury opens it for a token, which it can do only after the
/// token's milestone, once and for good (decision of 2 November 2026: an opt-in feature for selected tokens).
contract ElpidaV4Hook is BaseHook, IUnlockCallback {
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    /// Model 10's virtual token reserve, 1B x 10/9; sets the launch price from the virtual quote.
    uint256 public constant VIRTUAL_TOKEN = 1_111_111_111_111_111 * 1e12;
    /// 1.0001^23030 = 10.003: the sale ends at 10x the launch price (0.03% over; 23,027 ticks is exact but not a multiple of 10).
    int24 public constant SALE_TICKS = 23_030;
    /// Spacing 10 keeps a full-curve swap to about nine tick-bitmap words (spacing 1 would need about ninety).
    int24 public constant TICK_SPACING = 10;
    int24 public constant MIN_USABLE_TICK = -887_270;
    int24 public constant MAX_USABLE_TICK = 887_270;
    uint256 public constant FEE_BPS = 125;
    uint256 public constant SNIPE_START_BPS = 9000;
    uint256 public constant SNIPE_WINDOW = 60;
    /// After the milestone: the 1% of today's graduated Uniswap v3 pools, charged by the hook in the quote.
    uint256 public constant POOL_FEE_BPS = 100;
    uint256 public constant MODEL_VERSION = 11;
    address public constant DEAD = address(0xdead);
    uint256 private constant Q96 = 0x1000000000000000000000000;
    // Transient slots: the fee taken in beforeSwap, read back in afterSwap.
    bytes32 private constant FEE_SLOT = keccak256("elpida.v4.fee");
    bytes32 private constant BASE_SLOT = keccak256("elpida.v4.base");
    bytes32 private constant BPS_SLOT = keccak256("elpida.v4.bps");

    struct Launch {
        /// The quote asset (address 0 for the native coin); always the pool's currency0.
        address quote;
        /// Set once by the treasury, after the milestone: third parties may then add liquidity to this pool.
        bool liquidityOpen;
        address creatorVault;
        uint64 launchedAt;
        uint16 buybackBps;
        bool graduated;
        int24 upperTick;
        int24 lowerTick;
        uint128 saleLiquidity;
        uint128 upperLiquidity;
        uint128 milestoneLiquidity;
        uint256 creatorFees;
        uint256 protocolFees;
        /// Anti-snipe surplus above the base fee. Added to the locked liquidity at the milestone; never paid out.
        uint256 liquidityBonus;
        uint256 buybackBurned;
        uint256 buybackQuoteSpent;
    }

    address public immutable factory;
    address public immutable protocolTreasury;
    mapping(address token => Launch) public launches;
    /// Per quote asset: the sum of every launch's ledgers; equals the claims (ERC-6909) this hook holds in the PoolManager.
    mapping(address quote => uint256) public totalOwed;
    bool private entered;

    enum Action { Launch, Payout }

    event LiquidityOpened(address indexed token);
    event Launched(address indexed token, address indexed quote, address indexed creatorVault, int24 upperTick, int24 lowerTick, uint128 saleLiquidity, uint128 upperLiquidity, uint256 dustBurned);
    /// Every fee the hook takes. The PoolManager's Swap event does not include it; indexers add it from here.
    event Fee(address indexed token, address indexed trader, bool buy, uint256 feeBps, uint256 fee, uint256 lockedBonus);
    event BuybackBurned(address indexed token, uint256 quoteIn, uint256 tokensBurned);
    event Milestone(address indexed token, uint256 saleQuote, uint256 bonus, uint128 liquidity, uint256 dust);
    event FeesWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event FeePayoutFailed(address indexed token, address indexed recipient, uint256 amount);

    error OnlyElpida();
    error NotLaunched();
    error LiquidityLocked();
    error AboveLaunchPrice();

    modifier nonReentrant() { require(!entered, "reentrancy"); entered = true; _; entered = false; }

    constructor(IPoolManager manager, address factory_, address treasury_) BaseHook(manager) {
        require(factory_ != address(0) && treasury_ != address(0), "zero address");
        factory = factory_; protocolTreasury = treasury_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true; p.beforeAddLiquidity = true; p.beforeSwap = true; p.afterSwap = true;
        p.beforeSwapReturnDelta = true; p.afterSwapReturnDelta = true;
    }

    // ---- views ----

    function poolKey(address token) public view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(launches[token].quote), Currency.wrap(token), 0, TICK_SPACING, IHooks(address(this)));
    }

    function currentFeeBps(address token) public view returns (uint256) {
        Launch storage l = launches[token];
        if (l.launchedAt == 0) revert NotLaunched();
        return _feeBps(l);
    }

    /// Sale tokens still in the sale position (0 after the milestone).
    function saleRemaining(address token) external view returns (uint256) {
        Launch storage l = launches[token];
        if (l.launchedAt == 0) revert NotLaunched();
        if (l.graduated) return 0;
        (uint160 price,,,) = poolManager.getSlot0(poolKey(token).toId());
        uint160 lower = TickMath.getSqrtPriceAtTick(l.lowerTick);
        return price <= lower ? 0 : SqrtPriceMath.getAmount1Delta(lower, price, l.saleLiquidity, false);
    }

    function _feeBps(Launch storage l) private view returns (uint256) {
        if (l.graduated) return POOL_FEE_BPS;
        uint256 elapsed = block.timestamp - l.launchedAt;
        if (elapsed >= SNIPE_WINDOW) return FEE_BPS;
        return FEE_BPS + (SNIPE_START_BPS - FEE_BPS) * (SNIPE_WINDOW - elapsed) / SNIPE_WINDOW;
    }

    // ---- launch ----

    /// Called by the factory after it minted the whole supply to this hook and, for an ERC-20 quote, sent it the
    /// creator's first buy (`firstBuy`; for the native coin it is `msg.value`). The first buy pays only the base fee,
    /// as in Model 10. `virtualQuote` is in the quote's raw units.
    function launch(address token, address quote, address creatorVault, address buyer, uint256 virtualQuote, uint16 buybackBps, uint256 firstBuy, uint256 minOut) external payable nonReentrant returns (uint256 bought) {
        if (msg.sender != factory) revert OnlyElpida();
        require(creatorVault != address(0) && buyer != address(0) && virtualQuote > 0, "launch terms");
        require(uint160(quote) < uint160(token), "quote order");
        if (quote == address(0)) require(msg.value == firstBuy, "native value");
        else require(msg.value == 0 && IV4Token(quote).balanceOf(address(this)) >= firstBuy, "quote funding");
        require(buybackBps == 0 || buybackBps == 1000 || buybackBps == 2000, "buyback share");
        require(launches[token].launchedAt == 0 && IV4Token(token).balanceOf(address(this)) == TOKEN_SUPPLY, "token");
        // Launch price: Model 10's vT / vQ tokens per quote unit, rounded down to the tick spacing (a price at most 0.1% higher).
        uint160 start = uint160(_sqrt(FullMath.mulDiv(VIRTUAL_TOKEN, Q96, virtualQuote)) << 48);
        int24 upper = TickMath.getTickAtSqrtPrice(start);
        int24 rem = upper % TICK_SPACING; if (rem < 0) rem += TICK_SPACING; upper -= rem;
        int24 lower = upper - SALE_TICKS;
        require(lower > MIN_USABLE_TICK + 1000 && upper < MAX_USABLE_TICK - 1000, "launch price");
        uint160 sqrtU = TickMath.getSqrtPriceAtTick(upper);
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(lower);
        // Size L so that both positions together hold the whole supply (less a few wei for rounding):
        // tokens = L (sqrtU - sqrtL) + L' (sqrtL - sqrtMin), with L' = L (sqrtU - sqrtL) / sqrtU.
        uint256 a = sqrtU - sqrtL;
        uint256 b = FullMath.mulDiv(a, sqrtL - TickMath.getSqrtPriceAtTick(MIN_USABLE_TICK), sqrtU);
        uint128 saleL = FullMath.mulDiv(TOKEN_SUPPLY - 8, Q96, a + b).toUint128();
        uint128 upperL = FullMath.mulDiv(saleL, a, sqrtU).toUint128();
        Launch storage l = launches[token];
        l.quote = quote; l.creatorVault = creatorVault; l.launchedAt = uint64(block.timestamp); l.buybackBps = buybackBps;
        l.upperTick = upper; l.lowerTick = lower; l.saleLiquidity = saleL; l.upperLiquidity = upperL;
        poolManager.initialize(poolKey(token), sqrtU);
        bought = abi.decode(poolManager.unlock(abi.encode(Action.Launch, token, buyer, firstBuy, minOut)), (uint256));
        uint256 dust = IV4Token(token).balanceOf(address(this));
        if (dust > 0) require(IV4Token(token).transfer(DEAD, dust), "dust burn");
        emit Launched(token, quote, creatorVault, upper, lower, saleL, upperL, dust);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        Action action = abi.decode(data, (Action));
        if (action == Action.Payout) {
            (, address asset, address recipient, uint256 amount) = abi.decode(data, (Action, address, address, uint256));
            try this.payoutStep(asset, recipient, amount) { return abi.encode(true); } catch { return abi.encode(false); }
        }
        (, address token, address buyer, uint256 gross, uint256 minOut) = abi.decode(data, (Action, address, address, uint256, uint256));
        Launch storage l = launches[token];
        PoolKey memory key = poolKey(token);
        (BalanceDelta s,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(l.lowerTick, l.upperTick, int256(uint256(l.saleLiquidity)), 0), "");
        (BalanceDelta u,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(MIN_USABLE_TICK, l.lowerTick, int256(uint256(l.upperLiquidity)), 0), "");
        uint256 owed = uint256(int256(-s.amount1())) + uint256(int256(-u.amount1()));
        poolManager.sync(key.currency1);
        require(IV4Token(token).transfer(address(poolManager), owed), "seed");
        poolManager.settle();
        if (gross == 0) { require(minOut == 0, "empty first buy"); return abi.encode(uint256(0)); }
        // The creator's first buy: base fee only, no anti-snipe, not capped (it may reach the milestone).
        uint256 fee = gross * FEE_BPS / 10000;
        if (l.quote == address(0)) poolManager.settle{value: gross}();
        else {
            poolManager.sync(key.currency0);
            require(IV4Token(l.quote).transfer(address(poolManager), gross), "first buy");
            poolManager.settle();
        }
        poolManager.mint(address(this), _id(key), fee);
        BalanceDelta d = poolManager.swap(key, SwapParams(true, -int256(gross - fee), TickMath.MIN_SQRT_PRICE + 1), "");
        uint256 out = uint256(int256(d.amount1()));
        require(out >= minOut, "slippage");
        poolManager.take(key.currency1, buyer, out);
        emit Fee(token, buyer, true, FEE_BPS, fee, 0);
        _afterTrade(key, token, l, fee, fee, buyer);
        return abi.encode(out);
    }

    // ---- hook callbacks ----

    function _beforeInitialize(address, PoolKey calldata, uint160) internal pure override returns (bytes4) {
        // Only the hook itself creates pools for it (self-calls skip this check).
        revert OnlyElpida();
    }

    function _beforeAddLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata) internal view override returns (bytes4) {
        // Before the milestone only the hook's own positions exist, so nobody can change the curve. After it, only a
        // token the treasury has opened accepts third-party liquidity.
        Launch storage l = launches[Currency.unwrap(key.currency1)];
        if (!l.graduated || !l.liquidityOpen) revert LiquidityLocked();
        return this.beforeAddLiquidity.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        bool exactIn = params.amountSpecified < 0;
        if (params.zeroForOne != exactIn) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        // The specified amount is the quote: a buy with the quote paid in (gross), or a sell with the quote received (net).
        Launch storage l = launches[Currency.unwrap(key.currency1)];
        uint256 bps = _feeBps(l);
        uint256 amount = uint256(exactIn ? -params.amountSpecified : params.amountSpecified);
        uint256 fee = exactIn ? amount * bps / 10000 : _feeOnNet(amount, bps);
        uint256 base = _base(exactIn ? amount : amount + fee, fee, l.graduated);
        if (fee > 0) poolManager.mint(address(this), _id(key), fee);
        _tstore(FEE_SLOT, fee); _tstore(BASE_SLOT, base); _tstore(BPS_SLOT, bps);
        return (this.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
    }

    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata) internal override returns (bytes4, int128) {
        address token = Currency.unwrap(key.currency1);
        Launch storage l = launches[token];
        bool exactIn = params.amountSpecified < 0;
        uint256 fee; uint256 base; uint256 bps; int128 taken;
        if (params.zeroForOne == exactIn) {
            fee = _tload(FEE_SLOT); base = _tload(BASE_SLOT); bps = _tload(BPS_SLOT);
            _tstore(FEE_SLOT, 0); _tstore(BASE_SLOT, 0); _tstore(BPS_SLOT, 0);
        } else {
            // The quote side is unspecified: a sell's gross proceeds, or the net quote an exact-output buy paid.
            bps = _feeBps(l);
            int128 q = delta.amount0();
            uint256 amount = uint256(int256(q < 0 ? -q : q));
            fee = exactIn ? amount * bps / 10000 : _feeOnNet(amount, bps);
            base = _base(exactIn ? amount : amount + fee, fee, l.graduated);
            if (fee > 0) poolManager.mint(address(this), _id(key), fee);
            taken = fee.toInt128();
        }
        if (!l.graduated) {
            (uint160 price,,,) = poolManager.getSlot0(key.toId());
            if (price > TickMath.getSqrtPriceAtTick(l.upperTick)) revert AboveLaunchPrice();
        }
        if (fee > 0) emit Fee(token, sender, params.zeroForOne, bps, fee, fee - base);
        _afterTrade(key, token, l, fee, base, sender);
        return (this.afterSwap.selector, taken);
    }

    // ---- accounting ----

    /// Fee on a gross amount when only the net is known, rounded up: net x bps / (10000 - bps).
    function _feeOnNet(uint256 net, uint256 bps) private pure returns (uint256) {
        return FullMath.mulDivRoundingUp(net, bps, 10000 - bps);
    }

    function _base(uint256 gross, uint256 fee, bool graduated) private pure returns (uint256 base) {
        if (graduated) return fee;
        base = gross * FEE_BPS / 10000;
        if (base > fee) base = fee;
    }

    /// Model 10's split: creator 50% (with the odd wei), burn `buybackBps` of the base fee from the protocol's half,
    /// protocol the rest, anti-snipe surplus to the liquidity bonus. Then the burn, then the milestone if reached.
    function _afterTrade(PoolKey memory key, address token, Launch storage l, uint256 fee, uint256 base, address) private {
        uint256 burn;
        if (fee > 0) {
            uint256 creatorPart = base - base / 2;
            burn = base * l.buybackBps / 10000;
            l.creatorFees += creatorPart; l.protocolFees += base - creatorPart - burn;
            l.liquidityBonus += fee - base;
            totalOwed[l.quote] += fee;
        }
        (uint160 price,,,) = poolManager.getSlot0(key.toId());
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(l.lowerTick);
        if (!l.graduated && price <= sqrtL) {
            l.liquidityBonus += burn;
            _milestone(key, token, l, sqrtL);
        } else if (burn > 0) {
            _buyback(key, token, l, burn, price, sqrtL);
        }
    }

    /// Buys the token with `amount` of the fee, with no fee, and sends it to the dead address. Before the milestone it
    /// never reaches it: a burn that would, adds its quote to the liquidity bonus instead (as Model 10's curve does).
    function _buyback(PoolKey memory key, address token, Launch storage l, uint256 amount, uint160 price, uint160 sqrtL) private {
        if (!l.graduated && amount >= SqrtPriceMath.getAmount0Delta(sqrtL, price, l.saleLiquidity, true)) {
            l.liquidityBonus += amount; return;
        }
        BalanceDelta d = poolManager.swap(key, SwapParams(true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1), "");
        uint256 spent = uint256(int256(-d.amount0()));
        uint256 out = uint256(int256(d.amount1()));
        poolManager.burn(address(this), _id(key), spent);
        totalOwed[l.quote] -= spent;
        if (spent < amount) l.protocolFees += amount - spent;
        if (out > 0) poolManager.take(key.currency1, DEAD, out);
        l.buybackBurned += out; l.buybackQuoteSpent += spent;
        emit BuybackBurned(token, spent, out);
    }

    /// The sale position now holds only quote. Move it, with the liquidity bonus, to [lowerTick, MAX_USABLE_TICK].
    function _milestone(PoolKey memory key, address token, Launch storage l, uint160 sqrtL) private {
        l.graduated = true;
        (BalanceDelta removed,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(l.lowerTick, l.upperTick, -int256(uint256(l.saleLiquidity)), 0), "");
        uint256 q = uint256(int256(removed.amount0()));
        // Anyone may donate to the pool; donated tokens come out with the sale position. Burn them, so a donation can
        // never leave the milestone unsettled (and block it). Donated quote simply joins the locked liquidity.
        int128 donatedTokens = removed.amount1();
        if (donatedTokens > 0) poolManager.take(key.currency1, DEAD, uint256(int256(donatedTokens)));
        uint256 bonus = l.liquidityBonus;
        uint160 sqrtMax = TickMath.getSqrtPriceAtTick(MAX_USABLE_TICK);
        // Liquidity for a quote-only range: amount0 x sqrtA x sqrtB / (sqrtB - sqrtA); 2 wei kept for rounding.
        uint128 liquidity = FullMath.mulDiv(q + bonus - 2, FullMath.mulDiv(sqrtL, sqrtMax, Q96), sqrtMax - sqrtL).toUint128();
        (BalanceDelta added,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(l.lowerTick, MAX_USABLE_TICK, int256(uint256(liquidity)), 0), "");
        uint256 used = uint256(int256(-added.amount0()));
        require(used <= q + bonus, "milestone rounding");
        uint256 dust = q + bonus - used;
        // Claims: +dust from the sale, -bonus moved into the position.
        if (dust > bonus) poolManager.mint(address(this), _id(key), dust - bonus);
        else if (bonus > dust) poolManager.burn(address(this), _id(key), bonus - dust);
        totalOwed[l.quote] = totalOwed[l.quote] + dust - bonus;
        l.liquidityBonus = 0; l.protocolFees += dust; l.milestoneLiquidity = liquidity;
        emit Milestone(token, q, bonus, liquidity, dust);
    }

    // ---- fee payouts ----

    /// Pays one recipient (the creator vault or the protocol treasury) its fees for `token`, in the quote. A recipient that
    /// cannot receive keeps its balance and never blocks the other.
    function claimFees(address token, address recipient) public nonReentrant returns (bool paid) {
        Launch storage l = launches[token];
        if (l.launchedAt == 0) revert NotLaunched();
        bool protocolSide = recipient == protocolTreasury;
        require(protocolSide || recipient == l.creatorVault, "fee recipient");
        uint256 creatorPart = recipient == l.creatorVault ? l.creatorFees : 0;
        uint256 protocolPart = protocolSide ? l.protocolFees : 0;
        uint256 amount = creatorPart + protocolPart;
        if (amount == 0) return true;
        l.creatorFees -= creatorPart; l.protocolFees -= protocolPart; totalOwed[l.quote] -= amount;
        paid = abi.decode(poolManager.unlock(abi.encode(Action.Payout, l.quote, recipient, amount)), (bool));
        if (paid) { emit FeesWithdrawn(token, recipient, amount); return true; }
        l.creatorFees += creatorPart; l.protocolFees += protocolPart; totalOwed[l.quote] += amount;
        emit FeePayoutFailed(token, recipient, amount);
    }

    function withdrawFees(address token) external {
        claimFees(token, protocolTreasury);
        if (launches[token].creatorVault != protocolTreasury) claimFees(token, launches[token].creatorVault);
    }

    /// Runs inside the payout unlock as an external self-call, so a failed transfer reverts only this step.
    function payoutStep(address asset, address recipient, uint256 amount) external {
        require(msg.sender == address(this), "self only");
        poolManager.burn(address(this), uint256(uint160(asset)), amount);
        poolManager.take(Currency.wrap(asset), recipient, amount);
    }

    /// Treasury only, after the token's milestone, once: lets third parties add liquidity to this token's pool. The
    /// hook's own positions stay locked; the pool's LP fee stays 0 (the hook keeps charging the 1%).
    function openLiquidity(address token) external {
        Launch storage l = launches[token];
        require(msg.sender == protocolTreasury, "owner only");
        require(l.graduated && !l.liquidityOpen, "milestone first/already open");
        l.liquidityOpen = true;
        emit LiquidityOpened(token);
    }

    // ---- helpers ----

    /// The ERC-6909 id of the pool's quote (currency0) in the PoolManager.
    function _id(PoolKey memory key) private pure returns (uint256) { return uint256(uint160(Currency.unwrap(key.currency0))); }

    function _tstore(bytes32 slot, uint256 value) private { assembly { tstore(slot, value) } }
    function _tload(bytes32 slot) private view returns (uint256 value) { assembly { value := tload(slot) } }

    function _sqrt(uint256 x) private pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x; uint256 y = (x >> 1) + 1;
        while (y < z) { z = y; y = (x / y + y) >> 1; }
    }
}
