// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ILoanPool {
    function contribute() external payable;
    function withdraw() external;
}

/// Test-only lender that refuses plain ETH transfers until armed, to exercise
/// the hybrid settlement's pull-fallback path.
contract RejectingReceiver {
    bool public accept;

    function setAccept(bool accept_) external {
        accept = accept_;
    }

    function contributeTo(address loan) external payable {
        ILoanPool(loan).contribute{value: msg.value}();
    }

    function withdrawFrom(address loan) external {
        ILoanPool(loan).withdraw();
    }

    receive() external payable {
        require(accept, "RejectingReceiver: refusing");
    }
}
