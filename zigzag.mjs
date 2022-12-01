import WebSocket from "ws";
import * as zksync from "zksync";
import ethers from "ethers";

export class ZigZagSwapper {
    constructor({ wallet, rpc, to_swap = 2, timeout = 20 }) {
        this.wallet = wallet;
        this.rpc = rpc;
        this.ws = new WebSocket("wss://zigzag-exchange.herokuapp.com/");
        this.TRADING_STATE = false;
        this.ETH_USDC = 0.0;
        this.USDC_ETH = 0.0;
        this.SWAP_STATS = {
            ETH_BEFORE: 0.0,
            ETH_AFTER: 0.0,
        };
        this.swaps = 0;
        this.to_swap = to_swap;
        this.timeout = timeout;
        this.state = "ETH-USDC";
        this.syncProvider = "";
        this.walletWithProvider = "";
        this.ethersProvider = "";
        this.syncWallet = "";
        this.account_unlocked = false;
        this.swaping = false;
        this.interval = "";
        this.order_state = {
            order_id: 0,
            trade_action: "",
            valid_until_user: 0,
            valid_until_order: 0,
        };
    }

    onOpen() {
        return new Promise((resolve) => {
            this.ws.on("open", () => {
                this.logging(`CONNECTION WITH ZIGZAG WAS INITIATED :: WAITING FOR THE ETH PRICE`);
                this.onWsOpen();
            });
            this.ws.on("close", () => {
                clearInterval(this.interval);
                this.logging(`CLOSING CONNECTION ${this.state} :: PRICE ${this.ETH_USDC}`);
                resolve();
            });
            this.ws.on("error", () => {
                clearInterval(this.interval);
                resolve();
            });
        });
    }

    async checkTradeStatus() {
        let account = "";
        try {
            account = await this.syncWallet.getAccountState();
        } catch {
            //
        }

        if (account) {
            const USDC = account.committed.balances["USDC"];
            if (USDC && parseInt(USDC) >= 10000000 && this.state === "ETH-USDC") {
                this.swaps += 1;
                this.logging(`SWAPPING COMPLETED(${this.swaps}) ${this.state} :: PRICE ${this.ETH_USDC}`);
                this.state = "USDC-ETH";
                clearInterval(this.interval);
                this.swapThatShit(2);
            }

            if (!USDC && this.state === "USDC-ETH") {
                this.swaps += 1;
                this.logging(`SWAPPING COMPLETED(${this.swaps}) ${this.state} :: PRICE ${this.USDC_ETH}`);
                this.state = "ETH-USDC";
                this.SWAP_STATS.ETH_AFTER = parseFloat(ethers.utils.formatEther(account.committed.balances["ETH"]));
                clearInterval(this.interval);
                if (this.swaps >= this.to_swap) {
                    this.logging(`TASK COMPLETED :: TOTAL ETH SPENT ${this.SWAP_STATS.ETH_BEFORE - this.SWAP_STATS.ETH_AFTER}`);
                    this.ws.close();
                } else {
                    this.swapThatShit(3);
                }
            }
        }
    }

    onWsOpen() {
        this.ws.on("message", async (data) => {
            const message = JSON.parse(data);
            switch (message.op) {
                case "lastprice":
                    if (data.indexOf(`{"op":"lastprice","args":[[["ETH-USDC"`) > -1) {
                        this.ETH_USDC = message.args[0][0][1] - 1.5;
                        this.USDC_ETH = message.args[0][0][1] + 2.5;
                        if (!this.TRADING_STATE) {
                            await this.swapThatShit(1);
                        }
                    }
                    break;
                case "userorderack":
                    const order_id = message.args[1];
                    if (order_id !== this.order_state.order_id) {
                        this.order_state = {
                            ...this.order_state,
                            order_id: message.args[1],
                            trade_action: message.args[3],
                            valid_until_order: message.args[8],
                        };
                        await this.checkTradeStatus();
                        this.interval = setInterval(async () => {
                            await this.checkTradeStatus();
                        }, 5000);
                    }
                    break;
                case "orderstatus":
                    if (message.args[0][0]) {
                        const order_id = message.args[0][0][1];
                        const order_status = message.args[0][0][2];
                        if (this.order_state.order_id === order_id && order_status === "e") {
                            this.logging(`SWAPPING EXPIRED ${this.state} :: LETS TRY AGAIN`);
                            clearInterval(this.interval);
                            await this.swapThatShit(4);
                        }
                    }
                    break;
                default:
                    break;
            }
        });
    }

    logging(text) {
        console.log(`INFO ${this.wallet.address} :: ${text}`);
    }
    async swapThatShit(from) {
        this.swaping = true;
        this.TRADING_STATE = true;

        if (!this.syncProvider)
            this.syncProvider = await zksync.getDefaultProvider("mainnet", "HTTP", 0, this.wallet.proxy ? `http://${this.wallet.proxy}` : "");

        if (!this.ethersProvider) this.ethersProvider = ethers.getDefaultProvider(this.rpc);

        if (!this.walletWithProvider) this.walletWithProvider = new ethers.Wallet(this.wallet.private_key, this.ethersProvider);

        if (!this.syncWallet) this.syncWallet = await zksync.Wallet.fromEthSigner(this.walletWithProvider, this.syncProvider);

        if (!this.account_unlocked) {
            await this.unlockZkSyncAccount();
        }

        const account = await this.syncWallet.getAccountState();
        let USDC = account.committed.balances["USDC"];
        const ETH = account.committed.balances["ETH"];

        if (this.state === "ETH-USDC" && !this.SWAP_STATS.ETH_BEFORE) {
            this.SWAP_STATS.ETH_BEFORE = parseFloat(ethers.utils.formatEther(ETH));
        }

        if (USDC && parseInt(USDC) >= 10000000) {
            this.state = "USDC-ETH";
        } else {
            this.state = "ETH-USDC";
            USDC = 0;
        }

        this.logging(`SWAPPING STARTED ${this.state} :: PRICE ${this.ETH_USDC} ${from}`);
        const toTrade = USDC ? USDC : (parseFloat(ethers.utils.formatEther(ETH)) / 2).toFixed(5);

        const amount = USDC ? parseFloat(toTrade) / this.USDC_ETH : parseFloat(toTrade) * this.ETH_USDC;
        this.order_state.valid_until_user = Math.floor(Date.now() / 1000) + this.timeout;

        const order_settings = {
            tokenSell: USDC ? "USDC" : "ETH",
            tokenBuy: USDC ? "ETH" : "USDC",
            amount: USDC ? USDC : ethers.utils.parseEther(toTrade),
            ratio: zksync.utils.tokenRatio({
                ETH: USDC ? amount.toFixed(5) : toTrade,
                USDC: USDC ? toTrade : amount.toFixed(5),
            }),
            validUntil: this.order_state.valid_until_user,
        };
        try {
            // sign order
            const order = await this.syncWallet.signOrder(order_settings);
            const submit_order = {
                op: "submitorder2",
                args: [1, "ETH-USDC", { ...order }],
            };
            // submit order to zigzag ws
            this.ws.send(JSON.stringify(submit_order));
        } catch {
            //
        }
    }

    async unlockZkSyncAccount() {
        if (!(await this.syncWallet.isSigningKeySet())) {
            if ((await this.syncWallet.getAccountId()) == undefined) {
                throw new Error("Unknown account");
            }
            // As any other kind of transaction, `ChangePubKey` transaction requires fee.
            // User doesn't have (but can) to specify the fee amount. If omitted, library will query zkSync node for
            // the lowest possible amount.
            const changePubkey = await this.syncWallet.setSigningKey({
                feeToken: "ETH",
                ethAuthType: "ECDSA",
            });
            // Wait until the tx is committed
            await changePubkey.awaitReceipt();
        } else {
            this.account_unlocked = true;
        }
    }
}
