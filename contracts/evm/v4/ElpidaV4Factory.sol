// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../src/ElpidaToken.sol";
import {ElpidaV4Hook} from "./ElpidaV4Hook.sol";

/// @notice Model 11 PROTOTYPE launchpad: creates a token and its locked-from-launch Uniswap v4 pool in one
/// transaction. NOT AUDITED. Local chain only; never deployed. The virtual quote (starting FDV) and the launch fee are
/// fixed at deployment here; a deployable version would reuse ElpidaUsdPricing as Model 10 does.
contract ElpidaV4Factory {
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MODEL_VERSION = 11;
    address public immutable treasury;
    uint256 public immutable virtualQuote;
    uint256 public immutable launchFee;
    ElpidaV4Hook public hook;
    mapping(address => bool) public isElpidaToken;
    /// Early-partner tiers, as in Model 10: 1000 or 2000 of the base fee buys back and burns, from Elpida's half.
    struct Partner { uint16 buybackBps; uint64 expiresAt; }
    mapping(address => Partner) public partners;
    uint64 public constant MAX_PARTNER_WINDOW = 180 days;
    bool private entered;

    event HookSet(address indexed hook);
    event PartnerSet(address indexed creator, uint16 buybackBps, uint64 expiresAt);
    event Launched(address indexed creator, address indexed token, uint256 firstBuy, uint256 bought);

    constructor(address treasury_, uint256 virtualQuote_, uint256 launchFee_) {
        require(treasury_ != address(0) && virtualQuote_ > 0, "config");
        treasury = treasury_; virtualQuote = virtualQuote_; launchFee = launchFee_;
    }

    /// Once: the hook is deployed separately at an address whose low bits carry its permissions.
    function setHook(address hook_) external {
        require(msg.sender == treasury && address(hook) == address(0), "owner only/set");
        require(ElpidaV4Hook(hook_).factory() == address(this) && ElpidaV4Hook(hook_).protocolTreasury() == treasury, "hook");
        hook = ElpidaV4Hook(hook_); emit HookSet(hook_);
    }

    function setPartner(address creator, uint16 buybackBps, uint64 expiresAt) external {
        require(msg.sender == treasury, "owner only");
        require(creator != address(0), "partner");
        if (buybackBps == 0) { require(expiresAt == 0, "partner terms"); delete partners[creator]; }
        else {
            require((buybackBps == 1000 || buybackBps == 2000) && expiresAt > block.timestamp && expiresAt <= block.timestamp + MAX_PARTNER_WINDOW, "partner terms");
            partners[creator] = Partner(buybackBps, expiresAt);
        }
        emit PartnerSet(creator, buybackBps, expiresAt);
    }

    function buybackShareOf(address creator) public view returns (uint16) {
        Partner memory p = partners[creator];
        return p.buybackBps != 0 && block.timestamp <= p.expiresAt ? p.buybackBps : 0;
    }

    /// msg.value = launch fee + first buy. The first buy pays only the 1.25% base fee.
    function launch(string calldata name_, string calldata symbol_, uint256 firstBuy, uint256 minOut, address reward) external payable returns (address token, uint256 bought) {
        require(!entered, "reentrancy"); entered = true;
        require(address(hook) != address(0) && reward != address(0), "hook/reward");
        require(msg.value == launchFee + firstBuy, "native value");
        if (launchFee > 0) { (bool ok,) = treasury.call{value: launchFee}(""); require(ok, "launch fee"); }
        token = address(new ElpidaToken(name_, symbol_, TOKEN_SUPPLY, address(hook)));
        bought = hook.launch{value: firstBuy}(token, reward, msg.sender, virtualQuote, buybackShareOf(msg.sender), minOut);
        isElpidaToken[token] = true;
        emit Launched(msg.sender, token, firstBuy, bought);
        entered = false;
    }
}

/// @notice Minimal CREATE2 deployer, used to place the hook at a mined address (prototype tooling).
contract ElpidaCreate2Deployer {
    event Deployed(address indexed at, bytes32 salt);
    function deploy(bytes calldata initCode, bytes32 salt) external returns (address at) {
        bytes memory code = initCode;
        assembly { at := create2(0, add(code, 0x20), mload(code), salt) }
        require(at != address(0), "create2");
        emit Deployed(at, salt);
    }
}
