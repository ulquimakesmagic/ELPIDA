// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
/// @notice Test-only quote asset that calls back into the curve from inside a transfer.
/// @dev The launchpad only accepts quotes the treasury has approved, so this stands in for "the approved quote
/// asset turned hostile" - the case `AUDIT_SCOPE.md` calls guarded but never exercised. Never deploy with real funds.
contract ReentrantQuote is ERC20 {
    address public curve;
    bytes public payload;
    bool public attempted;
    bool public innerSucceeded;
    bytes public lastRevert;

    constructor() ERC20("Reentrant quote", "RQUOTE") {}

    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function arm(address curve_, bytes calldata payload_) external { curve = curve_; payload = payload_; }

    function _update(address from, address to, uint256 amount) internal override {
        address target = curve;
        if (target != address(0) && from != address(0) && to != address(0)) {
            curve = address(0); // one attempt, no recursion
            attempted = true;
            bytes memory data = payload;
            (bool ok, bytes memory returned) = target.call(data);
            innerSucceeded = ok;
            lastRevert = returned;
        }
        super._update(from, to, amount);
    }
}
