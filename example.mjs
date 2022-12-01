import { ZigZagSwapper } from "./zigzag.mjs";

(async () => {
    const wallet = {
        private_key: "PRIVATE_KEY",
        address: "ADDRESS_KEY",
    };

    const zigzag = new ZigZagSwapper({ wallet, rpc: "ETH_RPC", to_swap: 4, timeout: 20 });
    await zigzag.onOpen();
})();
