// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaLockedPool.sol";
import "./ElpidaV3MigrationAdapter.sol";

/// @notice Model 10 native/ERC-20 virtual curve with anti-snipe fees, failure-isolated fee payouts,
/// a graduation escape hatch and V2 graduation for transfer-tax tokens. NOT AUDITED.
/// @dev Zero address quote means native currency. Curve shape: virtualToken = 1B x 10/9 and
/// SALE_CAP = 1B x sqrt(10)/(sqrt(10)+1), so the price ends at 10x the start (identical to the Solana program).
interface ITaxActivation {function activatePair(address) external;}
contract ElpidaTaxCurve {
    uint16 public immutable buyTaxBps;
    uint16 public immutable sellTaxBps;
    IERC20Minimal public immutable quote;
    IERC20Minimal public immutable token;
    address public immutable factory;
    address public immutable protocolTreasury;
    address public immutable creatorRewardVault;
    uint256 public immutable virtualQuote;
    uint256 public immutable virtualToken;
    /// Seconds a completed curve may wait for graduation before anyone can reopen trading.
    uint256 public immutable graduationGrace;
    /// Launch time; the anti-snipe fee decays from this timestamp.
    uint256 public immutable launchedAt;
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant SALE_CAP = 759_746_926_647_958 * 1e12;
    uint256 public constant FEE_BPS = 125;
    uint256 public constant SNIPE_START_BPS = 9000;
    uint256 public constant SNIPE_WINDOW = 60;
    uint256 public constant MODEL_VERSION = 10;
    uint256 public sold;
    uint256 public realReserve;
    uint256 public protocolFees;
    uint256 public creatorFees;
    /// Anti-snipe surplus above the base fee. Locked into graduation liquidity; never paid out.
    uint256 public liquidityBonus;
    bool public complete;
    uint256 public completedAt;
    address public pool;
    ElpidaV3MigrationAdapter public immutable migrationAdapter;
    address public locker;
    address public feeSplitter;
    uint256 public positionId;
    uint256 public quoteDust;
    bool private entered;
    bool private firstBuyDone;
    bool public immutable automaticGraduation;
    event Bought(address indexed payer, address indexed recipient, uint256 quoteIn, uint256 tokensOut);
    event Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    event FeePayoutFailed(address indexed recipient, uint256 amount);
    event AntiSnipeFee(address indexed trader, uint256 feeBps, uint256 lockedAmount);
    event CurveCompleted(uint256 realQuote);
    event CurveReopened(uint256 completedAt, uint256 reopenedAt);
    event Graduated(address indexed pool, uint256 quoteLiquidity, uint256 tokenLiquidity, uint256 burned);
    modifier nonReentrant() { require(!entered, "reentrancy"); entered = true; _; entered = false; }
    struct Domain {address quote;address token;address factory;address treasury;address reward;uint256 virtualQuote;uint256 virtualToken;address adapter;uint256 grace;uint16 buyTax;uint16 sellTax;}
    constructor(Domain memory d) {
        require(d.buyTax<=1000 && d.sellTax<=1000,"tax exceeds 10%");
        buyTaxBps=d.buyTax;sellTaxBps=d.sellTax;
        require(d.token != address(0) && d.factory != address(0) && d.treasury != address(0) && d.reward != address(0), "zero address");
        require(d.virtualQuote > 0 && d.virtualToken > SALE_CAP, "virtual reserves");
        require(d.adapter.code.length > 0, "adapter");
        require(d.grace >= 60 && d.grace <= 7 days, "grace");
        migrationAdapter = ElpidaV3MigrationAdapter(d.adapter);
        quote = IERC20Minimal(d.quote); token = IERC20Minimal(d.token); factory = d.factory;
        protocolTreasury = d.treasury; creatorRewardVault = d.reward; virtualQuote = d.virtualQuote; virtualToken = d.virtualToken;
        graduationGrace = d.grace; launchedAt = block.timestamp;
        (bool ok, bytes memory data) = d.factory.staticcall(abi.encodeWithSignature("automaticGraduation()"));
        automaticGraduation = ok && data.length == 32 && abi.decode(data, (bool));
    }
    /// Mirrors the Solana program's `current_fee_bps`: linear decay from 90% to the base fee over 60 s.
    function currentFeeBps() public view returns (uint256) {
        uint256 elapsed = block.timestamp - launchedAt;
        if (elapsed >= SNIPE_WINDOW) return FEE_BPS + buyTaxBps;
        return FEE_BPS + buyTaxBps + (SNIPE_START_BPS - FEE_BPS) * (SNIPE_WINDOW - elapsed) / SNIPE_WINDOW;
    }
    function _fees(uint256 gross, uint256 feeBps) private pure returns (uint256 fee, uint256 base) {
        fee = gross * feeBps / 10000;
        base = gross * FEE_BPS / 10000;
        if (base > fee) base = fee;
    }
    function _completionQuote(uint256 feeBps) private view returns (uint256 gross) {
        require(!complete, "curve complete");
        uint256 remaining = SALE_CAP - sold;
        uint256 denominator = virtualToken - SALE_CAP;
        uint256 net = ((virtualQuote + realReserve) * remaining + denominator - 1) / denominator;
        require(feeBps<10000,"fee window");
        gross = (net - 1) * 10000 / (10000 - feeBps) + 1;
    }
    /// Gross quote needed to buy out the rest of the curve at the current fee.
    // At the launch timestamp, 90% protection plus a 10% tax leaves no
    // executable buy. Keep read-only market snapshots available during it.
    function completionQuote() public view returns (uint256) { uint256 fee=currentFeeBps();return fee>=10000?0:_completionQuote(fee); }
    /// What finishing the curve costs at the 1.25% base fee, i.e. once the anti-snipe minute is over (for display).
    function remainingAtBaseFee() external view returns (uint256) { return _completionQuote(FEE_BPS+buyTaxBps); }
    /// The final buy is partially filled, like the Solana program: it takes exactly the remaining curve supply and
    /// charges only the quote needed for it. `spent` is the gross amount actually used.
    function _quoteBuy(uint256 gross, uint256 feeBps) private view returns (uint256 out, uint256 fee, uint256 base, uint256 spent) {
        require(!complete && gross > 0, "complete/positive buy");
        uint256 cap = _completionQuote(feeBps);
        spent = gross > cap ? cap : gross;
        (fee, base) = _fees(spent, feeBps);
        uint256 net = spent - fee;
        out = (virtualToken - sold) * net / (virtualQuote + realReserve + net);
        if (spent == cap || out > SALE_CAP - sold) out = SALE_CAP - sold;
        require(out > 0, "buy dust");
    }
    /// `fee` is the full fee charged, including any anti-snipe amount locked into liquidity.
    function quoteBuy(uint256 gross) public view returns (uint256 out, uint256 fee) { (out, fee,,) = _quoteBuy(gross, currentFeeBps()); }
    /// Full buy preview for interfaces: tokens out, total fee, gross actually spent and the fee rate applied.
    function previewBuy(uint256 gross) external view returns (uint256 out, uint256 fee, uint256 spent, uint256 feeBps) {
        feeBps = currentFeeBps(); (out, fee,, spent) = _quoteBuy(gross, feeBps);
    }
    function buy(uint256 gross, uint256 minOut) external payable nonReentrant returns (uint256) { return _buy(msg.sender, msg.sender, gross, minOut, currentFeeBps()); }
    /// The creator's atomic first buy pays only the base fee and is not capped.
    function initialBuy(address recipient, uint256 gross, uint256 minOut) external payable nonReentrant returns (uint256) {
        require(msg.sender == factory && !firstBuyDone, "factory/first buy"); firstBuyDone = true;
        if (gross == 0) { require(minOut == 0 && msg.value == 0, "empty first buy"); return 0; }
        return _buy(factory, recipient, gross, minOut, FEE_BPS+buyTaxBps);
    }
    function _buy(address payer, address recipient, uint256 gross, uint256 minOut, uint256 feeBps) private returns (uint256 out) {
        uint256 fee; uint256 base; uint256 spent; (out, fee, base, spent) = _quoteBuy(gross, feeBps); require(out >= minOut, "slippage");
        if (address(quote) == address(0)) require(msg.value == gross, "native value");
        else {
            require(msg.value == 0, "native value"); uint256 balance = quote.balanceOf(address(this));
            require(quote.transferFrom(payer, address(this), spent), "quote transfer");
            require(quote.balanceOf(address(this)) - balance == spent, "unsupported quote");
        }
        realReserve += spent - fee; sold += out; _accrue(fee, base, payer == factory ? recipient : payer, feeBps,spent,buyTaxBps);
        require(token.transfer(recipient, out), "token transfer"); emit Bought(payer, recipient, spent, out);
        if (sold == SALE_CAP) { complete = true; completedAt = block.timestamp; emit CurveCompleted(realReserve); }
        // Unused native value from a partially filled final buy goes back to the buyer.
        if (address(quote) == address(0) && gross > spent) _pay(recipient, gross - spent);
        if (complete && automaticGraduation) _graduate();
    }
    function _accrue(uint256 fee,uint256 base,address trader,uint256 feeBps,uint256 gross,uint256 taxBps) private {
        uint256 tax=gross*taxBps/10000;
        uint256 protocolTax=tax*3000/10000;
        protocolFees+=base/2+protocolTax;creatorFees+=base-base/2+tax-protocolTax;
        uint256 bonus=fee-base-tax;
        if(bonus>0){liquidityBonus+=bonus;emit AntiSnipeFee(trader,feeBps,bonus);}
    }
    function currentSellFeeBps() public view returns(uint256){return currentFeeBps()-buyTaxBps+sellTaxBps;}
    function quoteSell(uint256 input) public view returns (uint256 out, uint256 fee) {
        (out, fee,) = _quoteSell(input, currentSellFeeBps());
    }
    function _quoteSell(uint256 input, uint256 feeBps) private view returns (uint256 out, uint256 fee, uint256 base) {
        require(!complete && input > 0 && input <= sold, "complete/invalid sell");
        uint256 gross = (virtualQuote + realReserve) * input / (virtualToken - sold + input);
        require(gross <= realReserve, "insufficient real reserve");
        (fee, base) = _fees(gross, feeBps); out = gross - fee; require(out > 0, "sell dust");
    }
    function sell(uint256 input, uint256 minOut) external nonReentrant returns (uint256 out) {
        uint256 feeBps = currentSellFeeBps(); uint256 fee; uint256 base; (out, fee, base) = _quoteSell(input, feeBps); require(out >= minOut, "slippage");
        require(token.transferFrom(msg.sender, address(this), input), "token transfer");
        sold -= input; realReserve -= out + fee; _accrue(fee, base, msg.sender, feeBps,out+fee,sellTaxBps);
        _pay(msg.sender, out); emit Sold(msg.sender, input, out);
    }
    /// Pays one fixed recipient its owed base fees. A failing recipient never blocks the other.
    function claimFees(address recipient) public nonReentrant returns (bool paid) { paid = _claim(recipient); }
    /// Convenience: attempts both payouts. Never reverts because one recipient cannot receive.
    function withdrawFees() external nonReentrant { _claim(protocolTreasury); _claim(creatorRewardVault); }
    function _claim(address recipient) private returns (bool paid) {
        bool protocolSide = recipient == protocolTreasury;
        require(protocolSide || recipient == creatorRewardVault, "fee recipient");
        // One wallet can be both beneficiaries; pay both ledgers together.
        if (protocolSide && recipient == creatorRewardVault) {
            uint256 protocolAmount = protocolFees;
            uint256 creatorAmount = creatorFees;
            uint256 combined = protocolAmount + creatorAmount;
            if (combined == 0) return true;
            protocolFees = 0;
            creatorFees = 0;
            paid = _trySend(recipient, combined);
            if (paid) emit FeesWithdrawn(recipient, combined);
            else {
                protocolFees = protocolAmount;
                creatorFees = creatorAmount;
                emit FeePayoutFailed(recipient, combined);
            }
            return paid;
        }
        uint256 amount = protocolSide ? protocolFees : creatorFees;
        if (amount == 0) return true;
        if (protocolSide) protocolFees = 0; else creatorFees = 0;
        paid = _trySend(recipient, amount);
        if (paid) emit FeesWithdrawn(recipient, amount);
        else { if (protocolSide) protocolFees = amount; else creatorFees = amount; emit FeePayoutFailed(recipient, amount); }
    }
    /// Permissionless escape hatch: if graduation has not succeeded within the grace period, trading resumes.
    function reopen() external nonReentrant {
        require(complete && pool == address(0) && block.timestamp >= completedAt + graduationGrace, "not reopenable");
        complete = false; emit CurveReopened(completedAt, block.timestamp); completedAt = 0;
    }
    function graduate() external nonReentrant returns (address) {
        return _graduate();
    }
    function _graduate() private returns (address) {
        require(complete && pool == address(0), "not complete/already migrated");
        uint256 q = realReserve; uint256 bonus = liquidityBonus; uint256 total = q + bonus;
        // Tokens priced at the curve's terminal marginal price using REAL funds, not its virtual quote offset.
        // The anti-snipe bonus is added on top, so the pool opens at or above the terminal price.
        uint256 lpTokens = q * (virtualToken - sold) / (virtualQuote + q);
        uint256 remaining = TOKEN_SUPPLY - SALE_CAP;
        // The terminal quote rounds up, so the matched allocation can slightly exceed the inventory.
        if (lpTokens > remaining) {
            require(lpTokens - remaining <= remaining / 1_000_000, "migration rounding");
            lpTokens = remaining;
        }
        require(lpTokens > 0 && lpTokens <= remaining, "migration allocation");
        realReserve = 0; liquidityBonus = 0;
        require(token.approve(address(migrationAdapter), lpTokens), "adapter approval");
        if (address(quote) != address(0)) require(quote.approve(address(migrationAdapter), total), "quote approval");
        ElpidaV3MigrationAdapter.Result memory result = migrationAdapter.migrate{value: address(quote) == address(0) ? total : 0}(ElpidaV3MigrationAdapter.Request(address(token), address(quote), lpTokens, total, protocolTreasury, creatorRewardVault));
        require(token.approve(address(migrationAdapter), 0), "approval cleanup");
        if (address(quote) != address(0)) require(quote.approve(address(migrationAdapter), 0), "quote cleanup");
        ITaxActivation(address(token)).activatePair(result.pool);
        pool = result.pool; locker = result.locker; feeSplitter = result.splitter; positionId = result.positionId;
        uint256 burned = token.balanceOf(address(this));
        if (burned > 0) require(token.transfer(address(0xdead), burned), "dust burn");
        // Native migration refunds are wrapped ETH. Retain separate dust accounting; never label it trading reserve.
        quoteDust = total - result.quoteUsed;
        emit Graduated(pool, result.quoteUsed, result.tokenUsed, burned); return pool;
    }
    function _pay(address recipient, uint256 value) private {
        if (address(quote) == address(0)) { (bool ok,) = recipient.call{value: value}(""); require(ok, "native payout"); }
        else require(quote.transfer(recipient, value), "quote payout");
    }
    function _trySend(address recipient, uint256 value) private returns (bool ok) {
        if (address(quote) == address(0)) { (ok,) = recipient.call{value: value}(""); return ok; }
        bytes memory data;
        (ok, data) = address(quote).call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, recipient, value));
        ok = ok && (data.length == 0 || abi.decode(data, (bool)));
    }
}
