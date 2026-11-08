// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

interface IV2Token {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function burn(uint256) external;
}

/// @notice ELPIDA V2.0 launch hook (NOT AUDITED; local chains and test networks only). Built on Model 11: the launch curve
/// and the locked pool are one Uniswap v4 pool whose liquidity this hook owns for ever. V2 economics (spec §§4–11,
/// packages/core/v2-economics.mjs):
///  - start at the factory's starting market cap, graduate (the milestone) at ×5: $20,000 → $100,000 on mainnet;
///  - each token's fee is chosen at launch, from `minFeeBps` to 4.00% (1.25% default), and never changes, before or
///    after graduation (decision C5, 8 November 2026);
///  - every fee is split 30% creator / 30% trader airdrops / 10% flywheel / 10% holder rewards / 20% treasury, paid in
///    the quote. A trade adds its fee to one running total per token (`accrued`); each recipient is owed its share of
///    that total, rounded down, less what it has been paid. One storage write per trade instead of five, the split
///    exact, and the rounding remainder (at most 4 base units per token, ever) kept by the hook for good;
///  - the creator's optional first buy may receive at most 3% of the supply;
///  - no partner tiers (decision C4); tokens are burned with `burn()`, never sent to a dead address.
/// @dev currency0 is the quote (address 0 for the native coin) and currency1 the token, so a buy is zeroForOne. At launch
/// the hook owns two positions: sale [lowerTick, upperTick] and upper [MIN_USABLE_TICK, lowerTick] with
/// L' = L (1 - 1/sqrt(5)); lowerTick = upperTick - 16,100 ticks (×5.002). When a buy first reaches lowerTick the sale
/// position holds only quote and moves to [lowerTick, MAX_USABLE_TICK]. Anti-snipe: the fee starts at 90% and falls to
/// the token's own fee over 60 seconds; the surplus over the token's fee is added to the locked liquidity, never paid.
/// A quote asset whose issuer pauses transfers (an Ondo stock, spec §17) stops its pools' trading and payouts by itself;
/// a payout that cannot be made stays owed (FeePayoutFailed) and is paid once transfers resume. Nothing is swapped for
/// another asset.
contract ElpidaV2Hook is BaseHook, IUnlockCallback {
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    /// vT = r·S/(r−1) for r = 5: the launch price is vT / vQ tokens per quote unit.
    uint256 public constant VIRTUAL_TOKEN = 1_250_000_000 ether;
    /// 1.0001^16100 = 5.002: the sale ends at ×5 the launch price (16,094 ticks is exact but not a multiple of 10).
    int24 public constant SALE_TICKS = 16_100;
    int24 public constant TICK_SPACING = 10;
    int24 public constant MIN_USABLE_TICK = -887_270;
    int24 public constant MAX_USABLE_TICK = 887_270;
    uint256 public constant DEFAULT_FEE_BPS = 125;
    uint256 public constant MAX_FEE_BPS = 400;
    uint256 public constant SNIPE_START_BPS = 9000;
    uint256 public constant SNIPE_WINDOW = 60;
    uint256 public constant FIRST_BUY_CAP = TOKEN_SUPPLY * 300 / 10000;
    uint256 public constant CREATOR_BPS = 3000;
    uint256 public constant AIRDROP_BPS = 3000;
    uint256 public constant FLYWHEEL_BPS = 1000;
    uint256 public constant HOLDER_BPS = 1000;
    uint256 public constant TREASURY_BPS = 2000;
    uint256 public constant MODEL_VERSION = 20;
    uint256 private constant Q96 = 0x1000000000000000000000000;
    bytes32 private constant FEE_SLOT = keccak256("elpida.v2.fee");
    bytes32 private constant BASE_SLOT = keccak256("elpida.v2.base");
    bytes32 private constant BPS_SLOT = keccak256("elpida.v2.bps");

    /// The five fee recipients. The creator vault is per token; the other four are fixed for this launchpad.
    enum Recipient { Creator, TraderAirdrop, Flywheel, HolderRewards, Treasury }

    struct Launch {
        address quote;
        uint64 launchedAt;
        /// The token's own fee, chosen at launch; immutable.
        uint16 feeBps;
        bool graduated;
        address creatorVault;
        int24 upperTick;
        int24 lowerTick;
        uint128 saleLiquidity;
        uint128 upperLiquidity;
        /// Every fee at the token's own rate so far, in the quote: the five shares are worked out from this.
        uint128 accrued;
        /// Anti-snipe surplus over the token's fee. Added to the locked liquidity at the milestone; never paid out.
        uint128 liquidityBonus;
        uint128 milestoneLiquidity;
        /// Rounding dust from the milestone, the treasury's alone.
        uint128 treasuryExtra;
        /// Paid so far, in the quote, by Recipient.
        uint128[5] paid;
    }

    address public immutable factory;
    address public immutable protocolTreasury;
    address public immutable traderAirdropVault;
    address public immutable flywheelVault;
    address public immutable holderRewardVault;
    /// The lowest fee a creator may choose on this launchpad (spec §25.1: not decided; fixed per deployment).
    uint256 public immutable minFeeBps;
    mapping(address token => Launch) internal launches;
    /// Per quote asset: every launch's unpaid fees (with the rounding remainder) plus pre-milestone liquidity bonus;
    /// equals the hook's ERC-6909 claims.
    mapping(address quote => uint256) public totalOwed;
    bool private entered;

    enum Action { Launch, Payout }

    event Launched(address indexed token, address indexed quote, address indexed creatorVault, uint256 feeBps, int24 upperTick, int24 lowerTick, uint128 saleLiquidity, uint128 upperLiquidity, uint256 dustBurned);
    /// Every fee the hook takes, and its five shares. `lockedBonus` is the anti-snipe surplus added to the liquidity.
    event Fee(address indexed token, address indexed trader, bool buy, uint256 feeBps, uint256 fee, uint256 lockedBonus);
    event Milestone(address indexed token, uint256 saleQuote, uint256 bonus, uint128 liquidity, uint256 dust, uint256 tokensBurned);
    event FeesWithdrawn(address indexed token, Recipient indexed recipient, address to, uint256 amount);
    event FeePayoutFailed(address indexed token, Recipient indexed recipient, address to, uint256 amount);

    error OnlyElpida();
    error NotLaunched();
    error LiquidityLocked();
    error AboveLaunchPrice();
    error FeeOutOfRange();
    error FirstBuyAboveCap();
    error Slippage();
    error Reentrancy();
    error BadTerms();

    modifier nonReentrant() { if (entered) revert Reentrancy(); entered = true; _; entered = false; }

    constructor(IPoolManager manager, address factory_, address treasury_, address airdrop_, address flywheel_, address holder_, uint256 minFeeBps_) BaseHook(manager) {
        if (factory_ == address(0) || treasury_ == address(0) || airdrop_ == address(0) || flywheel_ == address(0) || holder_ == address(0)) revert BadTerms();
        if (minFeeBps_ < 1 || minFeeBps_ > DEFAULT_FEE_BPS) revert FeeOutOfRange();
        factory = factory_; protocolTreasury = treasury_; traderAirdropVault = airdrop_; flywheelVault = flywheel_; holderRewardVault = holder_;
        minFeeBps = minFeeBps_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true; p.beforeAddLiquidity = true; p.beforeSwap = true; p.afterSwap = true;
        p.beforeSwapReturnDelta = true; p.afterSwapReturnDelta = true;
    }

    // ---- views ----

    function poolKey(address token) public view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(launches[token].quote), Currency.wrap(token), 0, TICK_SPACING, IHooks(address(this)));
    }

    function launchOf(address token) external view returns (address quote, address creatorVault, uint64 launchedAt, uint16 feeBps, bool graduated, int24 upperTick, int24 lowerTick, uint128 liquidityBonus, uint128 accrued) {
        Launch storage l = launches[token];
        return (l.quote, l.creatorVault, l.launchedAt, l.feeBps, l.graduated, l.upperTick, l.lowerTick, l.liquidityBonus, l.accrued);
    }

    /// The hook's positions in `token`'s pool: the sale range, the upper range and, after the milestone, the locked range.
    function liquidityOf(address token) external view returns (uint128 sale, uint128 upper, uint128 milestone) {
        Launch storage l = launches[token];
        return (l.saleLiquidity, l.upperLiquidity, l.milestoneLiquidity);
    }

    /// The five ledgers of `token`: owed now and paid so far, in the quote, in Recipient order.
    function ledgers(address token) external view returns (uint256[5] memory owed, uint128[5] memory paid) {
        Launch storage l = launches[token];
        for (uint256 i = 0; i < 5; i++) owed[i] = _entitled(l, i) - l.paid[i];
        paid = l.paid;
    }

    /// What recipient `i` has earned from `token` so far: its share of every fee, rounded down (plus the milestone dust
    /// for the treasury). Never decreases, so it is never below what was paid.
    function _entitled(Launch storage l, uint256 i) private view returns (uint256) {
        uint256 bps = i == 0 ? CREATOR_BPS : i == 1 ? AIRDROP_BPS : i == 2 ? FLYWHEEL_BPS : i == 3 ? HOLDER_BPS : TREASURY_BPS;
        return uint256(l.accrued) * bps / 10000 + (i == 4 ? l.treasuryExtra : 0);
    }

    function feeBpsOf(address token) external view returns (uint256) {
        Launch storage l = launches[token];
        if (l.launchedAt == 0) revert NotLaunched();
        return l.feeBps;
    }

    function currentFeeBps(address token) public view returns (uint256) {
        Launch storage l = launches[token];
        if (l.launchedAt == 0) revert NotLaunched();
        return _feeBps(l);
    }

    function recipientOf(address token, Recipient r) public view returns (address) {
        if (r == Recipient.Creator) return launches[token].creatorVault;
        if (r == Recipient.TraderAirdrop) return traderAirdropVault;
        if (r == Recipient.Flywheel) return flywheelVault;
        if (r == Recipient.HolderRewards) return holderRewardVault;
        return protocolTreasury;
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
        uint256 own = l.feeBps;
        if (l.graduated) return own;
        uint256 elapsed = block.timestamp - l.launchedAt;
        if (elapsed >= SNIPE_WINDOW) return own;
        return own + (SNIPE_START_BPS - own) * (SNIPE_WINDOW - elapsed) / SNIPE_WINDOW;
    }

    // ---- launch ----

    /// Called by the factory after it minted the whole supply to this hook and, for an ERC-20 quote, sent it the
    /// creator's first buy (`firstBuy`; for the native coin it is `msg.value`). The first buy pays the token's own fee,
    /// without anti-snipe, and may receive at most 3% of the supply. `virtualQuote` is in the quote's raw units.
    function launch(address token, address quote, address creatorVault, address buyer, uint256 virtualQuote, uint256 feeBps, uint256 firstBuy, uint256 minOut) external payable nonReentrant returns (uint256 bought) {
        if (msg.sender != factory) revert OnlyElpida();
        if (feeBps < minFeeBps || feeBps > MAX_FEE_BPS) revert FeeOutOfRange();
        if (creatorVault == address(0) || buyer == address(0) || virtualQuote == 0 || uint160(quote) >= uint160(token)) revert BadTerms();
        if (quote == address(0) ? msg.value != firstBuy : (msg.value != 0 || IV2Token(quote).balanceOf(address(this)) < firstBuy)) revert BadTerms();
        if (launches[token].launchedAt != 0 || IV2Token(token).balanceOf(address(this)) != TOKEN_SUPPLY) revert BadTerms();
        // Launch price: vT / vQ tokens per quote unit, rounded down to the tick spacing (a price at most 0.1% higher).
        uint160 start = uint160(_sqrt(FullMath.mulDiv(VIRTUAL_TOKEN, Q96, virtualQuote)) << 48);
        int24 upper = TickMath.getTickAtSqrtPrice(start);
        int24 rem = upper % TICK_SPACING; if (rem < 0) rem += TICK_SPACING; upper -= rem;
        int24 lower = upper - SALE_TICKS;
        if (lower <= MIN_USABLE_TICK + 1000 || upper >= MAX_USABLE_TICK - 1000) revert BadTerms();
        uint160 sqrtU = TickMath.getSqrtPriceAtTick(upper);
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(lower);
        // Both positions together hold the whole supply (less a few wei for rounding):
        // tokens = L (sqrtU - sqrtL) + L' (sqrtL - sqrtMin), with L' = L (sqrtU - sqrtL) / sqrtU.
        uint256 a = sqrtU - sqrtL;
        uint256 b = FullMath.mulDiv(a, sqrtL - TickMath.getSqrtPriceAtTick(MIN_USABLE_TICK), sqrtU);
        uint128 saleL = FullMath.mulDiv(TOKEN_SUPPLY - 8, Q96, a + b).toUint128();
        uint128 upperL = FullMath.mulDiv(saleL, a, sqrtU).toUint128();
        Launch storage l = launches[token];
        l.quote = quote; l.creatorVault = creatorVault; l.launchedAt = uint64(block.timestamp); l.feeBps = uint16(feeBps);
        l.upperTick = upper; l.lowerTick = lower; l.saleLiquidity = saleL; l.upperLiquidity = upperL;
        poolManager.initialize(poolKey(token), sqrtU);
        bought = abi.decode(poolManager.unlock(abi.encode(Action.Launch, token, buyer, firstBuy, minOut)), (uint256));
        uint256 dust = IV2Token(token).balanceOf(address(this));
        if (dust > 0) IV2Token(token).burn(dust);
        emit Launched(token, quote, creatorVault, feeBps, upper, lower, saleL, upperL, dust);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        Action action = abi.decode(data, (Action));
        if (action == Action.Payout) {
            (, address asset, address to, uint256 amount) = abi.decode(data, (Action, address, address, uint256));
            try this.payoutStep(asset, to, amount) { return abi.encode(true); } catch { return abi.encode(false); }
        }
        (, address token, address buyer, uint256 gross, uint256 minOut) = abi.decode(data, (Action, address, address, uint256, uint256));
        Launch storage l = launches[token];
        PoolKey memory key = poolKey(token);
        (BalanceDelta s,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(l.lowerTick, l.upperTick, int256(uint256(l.saleLiquidity)), 0), "");
        (BalanceDelta u,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(MIN_USABLE_TICK, l.lowerTick, int256(uint256(l.upperLiquidity)), 0), "");
        uint256 owed = uint256(int256(-s.amount1())) + uint256(int256(-u.amount1()));
        poolManager.sync(key.currency1);
        if (!IV2Token(token).transfer(address(poolManager), owed)) revert BadTerms();
        poolManager.settle();
        if (gross == 0) { if (minOut != 0) revert BadTerms(); return abi.encode(uint256(0)); }
        uint256 fee = gross * l.feeBps / 10000;
        if (l.quote == address(0)) poolManager.settle{value: gross}();
        else {
            poolManager.sync(key.currency0);
            if (!IV2Token(l.quote).transfer(address(poolManager), gross)) revert BadTerms();
            poolManager.settle();
        }
        if (fee > 0) poolManager.mint(address(this), _id(key), fee);
        BalanceDelta d = poolManager.swap(key, SwapParams(true, -int256(gross - fee), TickMath.MIN_SQRT_PRICE + 1), "");
        uint256 out = uint256(int256(d.amount1()));
        if (out > FIRST_BUY_CAP) revert FirstBuyAboveCap();
        if (out < minOut) revert Slippage();
        poolManager.take(key.currency1, buyer, out);
        if (fee > 0) emit Fee(token, buyer, true, l.feeBps, fee, 0);
        _afterTrade(key, token, l, fee, fee);
        return abi.encode(out);
    }

    // ---- hook callbacks ----

    function _beforeInitialize(address, PoolKey calldata, uint160) internal pure override returns (bytes4) {
        // Only the hook itself creates pools for it (self-calls skip this check).
        revert OnlyElpida();
    }

    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) internal pure override returns (bytes4) {
        // Only the hook's own positions ever exist (self-calls skip this check): the liquidity is locked for good.
        revert LiquidityLocked();
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        bool exactIn = params.amountSpecified < 0;
        if (params.zeroForOne != exactIn) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        // The specified amount is the quote: a buy with the quote paid in (gross), or a sell with the quote received (net).
        Launch storage l = launches[Currency.unwrap(key.currency1)];
        uint256 bps = _feeBps(l);
        uint256 amount = uint256(exactIn ? -params.amountSpecified : params.amountSpecified);
        uint256 fee = exactIn ? amount * bps / 10000 : _feeOnNet(amount, bps);
        uint256 base = _base(exactIn ? amount : amount + fee, fee, l);
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
            base = _base(exactIn ? amount : amount + fee, fee, l);
            if (fee > 0) poolManager.mint(address(this), _id(key), fee);
            taken = fee.toInt128();
        }
        if (!l.graduated) {
            (uint160 price,,,) = poolManager.getSlot0(key.toId());
            if (price > TickMath.getSqrtPriceAtTick(l.upperTick)) revert AboveLaunchPrice();
        }
        if (fee > 0) emit Fee(token, sender, params.zeroForOne, bps, fee, fee - base);
        _afterTrade(key, token, l, fee, base);
        return (this.afterSwap.selector, taken);
    }

    // ---- accounting ----

    /// Fee on a gross amount when only the net is known, rounded up: net x bps / (10000 - bps).
    function _feeOnNet(uint256 net, uint256 bps) private pure returns (uint256) {
        return FullMath.mulDivRoundingUp(net, bps, 10000 - bps);
    }

    /// The part of `fee` at the token's own rate; the rest is anti-snipe surplus.
    function _base(uint256 gross, uint256 fee, Launch storage l) private view returns (uint256 base) {
        if (l.graduated) return fee;
        base = gross * l.feeBps / 10000;
        if (base > fee) base = fee;
    }

    /// Adds the fee at the token's rate to the running total (one slot with the bonus), locks the anti-snipe surplus,
    /// then moves the sale position at the milestone if this trade reached it.
    function _afterTrade(PoolKey memory key, address token, Launch storage l, uint256 fee, uint256 base) private {
        if (fee > 0) {
            l.accrued += base.toUint128();
            if (fee > base) l.liquidityBonus += (fee - base).toUint128();
            totalOwed[l.quote] += fee;
        }
        if (!l.graduated) {
            (uint160 price,,,) = poolManager.getSlot0(key.toId());
            uint160 sqrtL = TickMath.getSqrtPriceAtTick(l.lowerTick);
            if (price <= sqrtL) _milestone(key, token, l, sqrtL);
        }
    }

    /// The sale position now holds only quote. Move it, with the liquidity bonus, to [lowerTick, MAX_USABLE_TICK].
    function _milestone(PoolKey memory key, address token, Launch storage l, uint160 sqrtL) private {
        l.graduated = true;
        (BalanceDelta removed,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(l.lowerTick, l.upperTick, -int256(uint256(l.saleLiquidity)), 0), "");
        uint256 q = uint256(int256(removed.amount0()));
        // Anyone may donate to the pool; donated tokens come out with the sale position. Burn them, so a donation can
        // never leave the milestone unsettled (and block it). Donated quote simply joins the locked liquidity.
        uint256 donated = removed.amount1() > 0 ? uint256(int256(removed.amount1())) : 0;
        if (donated > 0) { poolManager.take(key.currency1, address(this), donated); IV2Token(token).burn(donated); }
        uint256 bonus = l.liquidityBonus;
        uint160 sqrtMax = TickMath.getSqrtPriceAtTick(MAX_USABLE_TICK);
        // Liquidity for a quote-only range: amount0 x sqrtA x sqrtB / (sqrtB - sqrtA); 2 wei kept for rounding.
        uint128 liquidity = FullMath.mulDiv(q + bonus - 2, FullMath.mulDiv(sqrtL, sqrtMax, Q96), sqrtMax - sqrtL).toUint128();
        (BalanceDelta added,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(l.lowerTick, MAX_USABLE_TICK, int256(uint256(liquidity)), 0), "");
        uint256 used = uint256(int256(-added.amount0()));
        uint256 dust = q + bonus - used;
        // Claims: +dust from the sale, -bonus moved into the position. The dust goes to the treasury.
        if (dust > bonus) poolManager.mint(address(this), _id(key), dust - bonus);
        else if (bonus > dust) poolManager.burn(address(this), _id(key), bonus - dust);
        totalOwed[l.quote] = totalOwed[l.quote] + dust - bonus;
        l.liquidityBonus = 0; l.treasuryExtra += dust.toUint128(); l.milestoneLiquidity = liquidity;
        emit Milestone(token, q, bonus, liquidity, dust, donated);
    }

    // ---- fee payouts ----

    /// Pays one of `token`'s five recipients what it is owed, in the quote. Anyone may call. A recipient that cannot
    /// receive (or a quote whose transfers are paused) keeps its balance and never blocks the others.
    function claim(address token, Recipient r) public nonReentrant returns (bool ok) {
        Launch storage l = launches[token];
        if (l.launchedAt == 0) revert NotLaunched();
        uint256 i = uint256(r);
        uint256 amount = _entitled(l, i) - l.paid[i];
        if (amount == 0) return true;
        address to = recipientOf(token, r);
        l.paid[i] += amount.toUint128(); totalOwed[l.quote] -= amount;
        ok = abi.decode(poolManager.unlock(abi.encode(Action.Payout, l.quote, to, amount)), (bool));
        if (ok) { emit FeesWithdrawn(token, r, to, amount); return true; }
        l.paid[i] -= uint128(amount); totalOwed[l.quote] += amount;
        emit FeePayoutFailed(token, r, to, amount);
    }

    /// Pays all five recipients of `token`.
    function withdrawFees(address token) external {
        for (uint256 i = 0; i < 5; i++) claim(token, Recipient(i));
    }

    /// Runs inside the payout unlock as an external self-call, so a failed transfer reverts only this step.
    function payoutStep(address asset, address to, uint256 amount) external {
        if (msg.sender != address(this)) revert OnlyElpida();
        poolManager.burn(address(this), uint256(uint160(asset)), amount);
        poolManager.take(Currency.wrap(asset), to, amount);
    }

    // ---- helpers ----

    /// The ERC-6909 id of the pool's quote (currency0) in the PoolManager.
    function _id(PoolKey memory key) private pure returns (uint256) { return uint256(uint160(Currency.unwrap(key.currency0))); }

    function _tstore(bytes32 slot, uint256 value) private { assembly ("memory-safe") { tstore(slot, value) } }
    function _tload(bytes32 slot) private view returns (uint256 value) { assembly ("memory-safe") { value := tload(slot) } }

    function _sqrt(uint256 x) private pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x; uint256 y = (x >> 1) + 1;
        while (y < z) { z = y; y = (x / y + y) >> 1; }
    }
}
