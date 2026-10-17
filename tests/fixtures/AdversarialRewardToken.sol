// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
/// @notice Test-only transfer tax and callback token. Never deploy with real funds.
contract AdversarialRewardToken is ERC20 {
    bool public taxed;
    address public callbackTarget;
    bool public callbackAttempted;
    bool public callbackSucceeded;
    constructor() ERC20("Adversarial reward", "ADV") {}
    function mint(address wallet,uint256 amount) external {_mint(wallet,amount);}
    function configure(bool tax,address target) external {taxed=tax;callbackTarget=target;}
    function _update(address from,address to,uint256 amount) internal override {
        if(from!=address(0)&&to!=address(0)) {
            if(callbackTarget!=address(0)) {
                callbackAttempted=true;
                (callbackSucceeded,)=callbackTarget.call(abi.encodeWithSignature("sync(address)",address(this)));
            }
            if(taxed) {
                uint256 fee=amount/10;
                super._update(from,address(0),fee);
                amount-=fee;
            }
        }
        super._update(from,to,amount);
    }
}
