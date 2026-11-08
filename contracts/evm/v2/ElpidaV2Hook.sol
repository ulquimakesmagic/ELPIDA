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
    function totalSupply() external view returns (uint256);
}

/// @notice ELPIDA V2.0 launch hook (PROTOTYPE, NOT AUDITED, local chain only). Built from Model 11
/// (contracts/evm/v4/ElpidaV4Hook.sol): the curve lives inside one Uniswap v4 pool whose liquidity the hook owns for
/// ever, from the first trade. V2.0 changes (docs/V2_0_AUDIT.md, decisions of 8 November 2026):
///  - start $20,000 FDV, milestone (graduation) at $100,000: virtual token 1.25B, sale range 16,100 ticks (x5.002);
///  - each token's fee is chosen at launch (minFeeBps..4%) and never changes; it applies before AND after the
///    milestone (anti-snipe still starts at 90% and falls to it over 60 s; the surplus joins the locked liquidity);
///  - every fee splits five ways: creator 30%, trader airdrop 30%, flywheel 10%, holder rewards 10%, treasury 20%
///    (the remainder, so the parts always sum to the fee);
///  - the creator's first buy is capped at 3% of supply;
///  - no partner tiers; rounding dust and donated tokens are burned with the token's own `burn` (supply falls).
/// @dev currency0 is always the quote, currency1 the token: a buy is zeroForOne. Positions at launch, both the hook's:
///  sale [lowerTick, upperTick] with L, upper [MIN_USABLE_TICK, lowerTick] with L' = L (sqrtU - sqrtL) / sqrtU.
contract ElpidaV2Hook is BaseHook, IUnlockCallback {
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    /// r x S / (r - 1) with r = 5: the curve ends at 5x its start price with price continuity into the locked pool.
    uint256 public constant VIRTUAL_TOKEN = 1_250_000_000 ether;
    /// 1.0001^16100 = 5.002: the smallest multiple of the spacing at or above 5x (never cheaper than the spec).
    int24 public constant SALE_TICKS = 16_100;
    int24 public constant TICK_SPACING = 10;
    int24 public constant MIN_USABLE_TICK = -887_270;
    int24 public constant MAX_USABLE_TICK = 887_270;
    uint256 public constant DEFAULT_FEE_BPS = 125;
    uint256 public constant MAX_FEE_BPS = 400;
    uint256 public constant SNIPE_START_BPS = 9000;
    uint256 public constant SNIPE_WINDOW = 60;
    /// 3% of supply: the most the creator's first buy may receive.
    uint256 public constant FIRST_BUY_CAP = TOKEN_SUPPLY * 300 / 10_000;
    uint256 public constant CREATOR_SHARE_BPS = 3000;
    uint256 public constant AIRDROP_SHARE_BPS = 3000;
    uint256 public constant FLYWHEEL_SHARE_BPS = 1000;
    uint256 public constant HOLDER_SHARE_BPS = 1000;
    uint256 public constant LAUNCHPAD_VERSION = 2;
    uint256 private constant Q96 = 0x1000000000000000000000000;
    bytes32 private constant FEE_SLOT = keccak256("elpida.v2.fee");
    bytes32 private constant BASE_SLOT = keccak256("elpida.v2.base");
    bytes32 private constant BPS_SLOT = keccak256("elpida.v2.bps");

    /// The five fee ledgers of one token, in its quote.
    struct Ledgers { uint256 creator; uint256 airdrop; uint256 flywheel; uint256 holders; uint256 treasury; }

    struct Launch {
        address quote;
        bool liquidityOpen;
        bool graduated;
        uint16 feeBps;
        uint64 launchedAt;
        address creatorVault;
        int24 upperTick;
        int24 lowerTick;
        uint128 saleLiquidity;
        uint128 upperLiquidity;
        uint128 milestoneLiquidity;
        /// Anti-snipe surplus above the token's fee. Joins the locked liquidity at the milestone; never paid out.
        uint256 liquidityBonus;
        uint256 burned;
    }

    address public immutable factory;
    address public immutable protocolTreasury;
    address public immutable traderAirdropVault;
    address public immutable flywheelVault;
    address public immutable holderRewardVault;
    /// The lowest fee a creator may choose. Set per deployment until the V2.0 minimum is approved (spec §25.1).
    uint256 public immutable minFeeBps;
    mapping(address token => Launch) public launches;
    mapping(address token => Ledgers) public ledgers;
    /// Per quote asset: the sum of every launch's ledgers and bonuses; equals the claims this hook holds in the PoolManager.
    mapping(address quote => uint256) public totalOwed;
    bool private entered;

    enum Action { Launch, Payout }

    event LiquidityOpened(address indexed token);
    event Launched(address indexed token, address indexed quote, address indexed creatorVault, uint256 feeBps, int24 upperTick, int24 lowerTick, uint128 saleLiquidity, uint128 upperLiquidity, uint256 dustBurned);
    event Fee(address indexed token, address indexed trader, bool buy, uint256 feeBps, uint256 fee, uint256 lockedBonus);
    /// The five-way split of one trade's fee (the base part; the anti-snipe surplus is `lockedBonus` in `Fee`).
    event FeeSplit(address indexed token, uint256 creator, uint256 airdrop, uint256 flywheel, uint256 holders, uint256 treasury);
    event Milestone(address indexed token, uint256 saleQuote, uint256 bonus, uint128 liquidity, uint256 dust);
    event Burned(address indexed token, uint256 amount, uint256 newTotalSupply);
    event FeesWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event FeePayoutFailed(address indexed token, address indexed recipient, uint256 amount);

    error OnlyElpida();
    error NotLaunched();
    error LiquidityLocked();
    error AboveLaunchPrice();

    modifier nonReentrant() { require(!entered, "reentrancy"); entered = true; _; entered = false; }

    constructor(IPoolManager manager, address factory_, address treasury_, address airdropVault_, address flywheelVault_, address holderVault_, uint256 minFeeBps_) BaseHook(manager) {
        require(factory_ != address(0) && treasury_ != address(0) && airdropVault_ != address(0) && flywheelVault_ != address(0) && holderVault_ != address(0), "zero address");
        require(minFeeBps_ >= 1 && minFeeBps_ <= DEFAULT_FEE_BPS, "min fee");
        factory = factory_; protocolTreasury = treasury_; traderAirdropVault = airdropVault_;
        flywheelVault = flywheelVault_; holderRewardVault = holderVault_; minFeeBps = minFeeBps_;
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

    function saleRemaining(address token) external view returns (uint256) {
        Launch storage l = launches[token];
        if (l.launchedAt == 0) revert NotLaunched();
        if (l.graduated) return 0;
        (uint160 price,,,) = poolManager.getSlot0(poolKey(token).toId());
        uint160 lower = TickMath.getSqrtPriceAtTick(l.lowerTick);
        return price <= lower ? 0 : SqrtPriceMath.getAmount1Delta(lower, price, l.saleLiquidity, false);
    }

    /// What `recipient` may claim for `token`: the sum of every ledger it is the recipient of.
    function owedTo(address token, address recipient) public view returns (uint256 amount) {
        Ledgers storage g = ledgers[token];
        if (recipient == launches[token].creatorVault) amount += g.creator;
        if (recipient == traderAirdropVault) amount += g.airdrop;
        if (recipient == flywheelVault) amount += g.flywheel;
        if (recipient == holderRewardVault) amount += g.holders;
        if (recipient == protocolTreasury) amount += g.treasury;
    }

    function _feeBps(Launch storage l) private view returns (uint256) {
        uint256 fee = l.feeBps;
        if (l.graduated) return fee;
        uint256 elapsed = block.timestamp - l.launchedAt;
        if (elapsed >= SNIPE_WINDOW) return fee;
        return fee + (SNIPE_START_BPS - fee) * (SNIPE_WINDOW - elapsed) / SNIPE_WINDOW;
    }

    // ---- launch ----

    /// Called by the factory after it minted the whole supply to this hook and, for an ERC-20 quote, sent it the
    /// creator's first buy (for the native coin it is `msg.value`). The first buy pays the token's fee, no anti-snipe.
    function launch(address token, address quote, address creatorVault, address buyer, uint256 virtualQuote, uint16 feeBps, uint256 firstBuy, uint256 minOut) external payable nonReentrant returns (uint256 bought) {
        if (msg.sender != factory) revert OnlyElpida();
        require(creatorVault != address(0) && buyer != address(0) && virtualQuote > 0, "launch terms");
        require(feeBps >= minFeeBps && feeBps <= MAX_FEE_BPS, "fee range");
        require(uint160(quote) < uint160(token), "quote order");
        if (quote == address(0)) require(msg.value == firstBuy, "native value");
        else require(msg.value == 0 && IV2Token(quote).balanceOf(address(this)) >= firstBuy, "quote funding");
        require(launches[token].launchedAt == 0 && IV2Token(token).balanceOf(address(this)) == TOKEN_SUPPLY, "token");
        uint160 start = uint160(_sqrt(FullMath.mulDiv(VIRTUAL_TOKEN, Q96, virtualQuote)) << 48);
        int24 upper = TickMath.getTickAtSqrtPrice(start);
        int24 rem = upper % TICK_SPACING; if (rem < 0) rem += TICK_SPACING; upper -= rem;
        int24 lower = upper - SALE_TICKS;
        require(lower > MIN_USABLE_TICK + 1000 && upper < MAX_USABLE_TICK - 1000, "launch price");
        uint160 sqrtU = TickMath.getSqrtPriceAtTick(upper);
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(lower);
        uint256 a = sqrtU - sqrtL;
        uint256 b = FullMath.mulDiv(a, sqrtL - TickMath.getSqrtPriceAtTick(MIN_USABLE_TICK), sqrtU);
        uint128 saleL = FullMath.mulDiv(TOKEN_SUPPLY - 8, Q96, a + b).toUint128();
        uint128 upperL = FullMath.mulDiv(saleL, a, sqrtU).toUint128();
        Launch storage l = launches[token];
        l.quote = quote; l.creatorVault = creatorVault; l.launchedAt = uint64(block.timestamp); l.feeBps = feeBps;
        l.upperTick = upper; l.lowerTick = lower; l.saleLiquidity = saleL; l.upperLiquidity = upperL;
        poolManager.initialize(poolKey(token), sqrtU);
        bought = abi.decode(poolManager.unlock(abi.encode(Action.Launch, token, buyer, firstBuy, minOut)), (uint256));
        uint256 dust = IV2Token(token).balanceOf(address(this));
        if (dust > 0) _burn(token, l, dust);
        emit Launched(token, quote, creatorVault, feeBps, upper, lower, saleL, upperL, dust);
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
        require(IV2Token(token).transfer(address(poolManager), owed), "seed");
        poolManager.settle();
        if (gross == 0) { require(minOut == 0, "empty first buy"); return abi.encode(uint256(0)); }
        uint256 fee = gross * l.feeBps / 10000;
        if (l.quote == address(0)) poolManager.settle{value: gross}();
        else {
            poolManager.sync(key.currency0);
            require(IV2Token(l.quote).transfer(address(poolManager), gross), "first buy");
            poolManager.settle();
        }
        poolManager.mint(address(this), _id(key), fee);
        BalanceDelta d = poolManager.swap(key, SwapParams(true, -int256(gross - fee), TickMath.MIN_SQRT_PRICE + 1), "");
        uint256 out = uint256(int256(d.amount1()));
        require(out >= minOut, "slippage");
        require(out <= FIRST_BUY_CAP, "first buy cap");
        poolManager.take(key.currency1, buyer, out);
        emit Fee(token, buyer, true, l.feeBps, fee, 0);
        _afterTrade(key, token, l, fee, fee);
        return abi.encode(out);
    }

    // ---- hook callbacks ----

    function _beforeInitialize(address, PoolKey calldata, uint160) internal pure override returns (bytes4) {
        revert OnlyElpida();
    }

    function _beforeAddLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata) internal view override returns (bytes4) {
        Launch storage l = launches[Currency.unwrap(key.currency1)];
        if (!l.graduated || !l.liquidityOpen) revert LiquidityLocked();
        return this.beforeAddLiquidity.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        bool exactIn = params.amountSpecified < 0;
        if (params.zeroForOne != exactIn) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
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

    function _feeOnNet(uint256 net, uint256 bps) private pure returns (uint256) {
        return FullMath.mulDivRoundingUp(net, bps, 10000 - bps);
    }

    /// The part of `fee` at the token's own rate; anything above it is the anti-snipe surplus.
    function _base(uint256 gross, uint256 fee, Launch storage l) private view returns (uint256 base) {
        if (l.graduated) return fee;
        base = gross * l.feeBps / 10000;
        if (base > fee) base = fee;
    }

    /// Splits the base fee five ways (treasury takes the remainder), keeps the surplus for the locked liquidity,
    /// then runs the milestone if this trade reached it.
    function _afterTrade(PoolKey memory key, address token, Launch storage l, uint256 fee, uint256 base) private {
        if (fee > 0) {
            Ledgers storage g = ledgers[token];
            uint256 c = base * CREATOR_SHARE_BPS / 10000;
            uint256 a = base * AIRDROP_SHARE_BPS / 10000;
            uint256 f = base * FLYWHEEL_SHARE_BPS / 10000;
            uint256 h = base * HOLDER_SHARE_BPS / 10000;
            uint256 t = base - c - a - f - h;
            g.creator += c; g.airdrop += a; g.flywheel += f; g.holders += h; g.treasury += t;
            l.liquidityBonus += fee - base;
            totalOwed[l.quote] += fee;
            emit FeeSplit(token, c, a, f, h, t);
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
        // Donated tokens come out with the sale position: take them and burn them, so a donation can never leave the
        // milestone unsettled. Donated quote joins the locked liquidity.
        int128 donatedTokens = removed.amount1();
        if (donatedTokens > 0) {
            poolManager.take(key.currency1, address(this), uint256(int256(donatedTokens)));
            _burn(token, l, uint256(int256(donatedTokens)));
        }
        uint256 bonus = l.liquidityBonus;
        uint160 sqrtMax = TickMath.getSqrtPriceAtTick(MAX_USABLE_TICK);
        uint128 liquidity = FullMath.mulDiv(q + bonus - 2, FullMath.mulDiv(sqrtL, sqrtMax, Q96), sqrtMax - sqrtL).toUint128();
        (BalanceDelta added,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(l.lowerTick, MAX_USABLE_TICK, int256(uint256(liquidity)), 0), "");
        uint256 used = uint256(int256(-added.amount0()));
        require(used <= q + bonus, "milestone rounding");
        uint256 dust = q + bonus - used;
        if (dust > bonus) poolManager.mint(address(this), _id(key), dust - bonus);
        else if (bonus > dust) poolManager.burn(address(this), _id(key), bonus - dust);
        totalOwed[l.quote] = totalOwed[l.quote] + dust - bonus;
        // Quote rounding dust (a few wei) goes to the treasury ledger.
        ledgers[token].treasury += dust;
        l.liquidityBonus = 0; l.milestoneLiquidity = liquidity;
        emit Milestone(token, q, bonus, liquidity, dust);
    }

    function _burn(address token, Launch storage l, uint256 amount) private {
        IV2Token(token).burn(amount);
        l.burned += amount;
        emit Burned(token, amount, IV2Token(token).totalSupply());
    }

    // ---- fee payouts ----

    /// Pays `recipient` every ledger of `token` it is the recipient of, in the token's quote. Permissionless: the
    /// destination is fixed. A recipient that cannot receive keeps its balance and never blocks the others.
    function claimFees(address token, address recipient) public nonReentrant returns (bool paid) {
        Launch storage l = launches[token];
        if (l.launchedAt == 0) revert NotLaunched();
        Ledgers storage g = ledgers[token];
        Ledgers memory before = g;
        uint256 amount = owedTo(token, recipient);
        require(amount > 0 || _isRecipient(l, recipient), "fee recipient");
        if (amount == 0) return true;
        if (recipient == l.creatorVault) g.creator = 0;
        if (recipient == traderAirdropVault) g.airdrop = 0;
        if (recipient == flywheelVault) g.flywheel = 0;
        if (recipient == holderRewardVault) g.holders = 0;
        if (recipient == protocolTreasury) g.treasury = 0;
        totalOwed[l.quote] -= amount;
        paid = abi.decode(poolManager.unlock(abi.encode(Action.Payout, l.quote, recipient, amount)), (bool));
        if (paid) { emit FeesWithdrawn(token, recipient, amount); return true; }
        ledgers[token] = before; totalOwed[l.quote] += amount;
        emit FeePayoutFailed(token, recipient, amount);
    }

    /// Pays all five recipients of `token`.
    function withdrawFees(address token) external {
        address c = launches[token].creatorVault;
        address[5] memory r = [c, traderAirdropVault, flywheelVault, holderRewardVault, protocolTreasury];
        for (uint256 i = 0; i < 5; i++) {
            bool seen;
            for (uint256 j = 0; j < i; j++) if (r[j] == r[i]) seen = true;
            if (!seen) claimFees(token, r[i]);
        }
    }

    function payoutStep(address asset, address recipient, uint256 amount) external {
        require(msg.sender == address(this), "self only");
        poolManager.burn(address(this), uint256(uint160(asset)), amount);
        poolManager.take(Currency.wrap(asset), recipient, amount);
    }

    /// Treasury only, after the token's milestone, once: lets third parties add liquidity to this token's pool.
    function openLiquidity(address token) external {
        Launch storage l = launches[token];
        require(msg.sender == protocolTreasury, "owner only");
        require(l.graduated && !l.liquidityOpen, "milestone first/already open");
        l.liquidityOpen = true;
        emit LiquidityOpened(token);
    }

    // ---- helpers ----

    function _isRecipient(Launch storage l, address r) private view returns (bool) {
        return r == l.creatorVault || r == traderAirdropVault || r == flywheelVault || r == holderRewardVault || r == protocolTreasury;
    }

    function _id(PoolKey memory key) private pure returns (uint256) { return uint256(uint160(Currency.unwrap(key.currency0))); }
    function _tstore(bytes32 slot, uint256 value) private { assembly { tstore(slot, value) } }
    function _tload(bytes32 slot) private view returns (uint256 value) { assembly { value := tload(slot) } }

    function _sqrt(uint256 x) private pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x; uint256 y = (x >> 1) + 1;
        while (y < z) { z = y; y = (x / y + y) >> 1; }
    }
}
