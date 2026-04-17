# Solana DEX Arbitrage — 全検証レポート

> **$3から始めるDEX間アービトラージは可能か？** 75,000+パターンを検証した結論と、構築した全ツールの公開。

## TL;DR

**不可能。** DEX-DEXアービトラージ、Pump.funスナイパー、コピートレード、Hyperliquid funding rate — 全方向を検証して壁に当たった記録。ただし構築した技術（Raydium/Orca直接swap命令、atomic transaction、リアルタイム監視システム）は再利用価値がある。

---

## 検証結果サマリー

| 戦略 | 検証規模 | 結果 | 詳細 |
|------|---------|------|------|
| DEX-DEX Arb (quoter) | 75,000+パターン | ❌ 利益ゼロ | Arbitrum, Solana, Polygon全チェーン |
| DEX-DEX Arb (Jupiter API) | 全サイズ全方向 | ❌ 全赤字 | 実約定価格で検証 |
| DEX-DEX Arb (直接命令) | Orca×Orca atomic sim | ❌ -0.45%赤字 | 最低fee pool同士でも赤字 |
| WebSocket + Atomic Sim | 2,132チェック/17分 | ❌ 利益 < ガス代 | quote利益$0.0003 vs ガス$0.0007 |
| Jito Bundle (ガス代ゼロ) | 192件分析 | ❌ 上限¥452/週 | サイズ拡大不可 |
| Pump.fun Sniper | 5トークンdry-run | ❌ 4/5赤字 | completion 52%でも-83% |
| HL Funding Rate | 7日間データ分析 | △ 週$10 | 入金にKYC必要で断念 |
| Copy-Trade | dry-run構築 | △ データ不足 | ターゲット発見済みだが検証不十分 |

## なぜ不可能か（構造的理由）

```
DEX-DEXアービトラージの損益構造:

  利益 = pool間価格差 - 往復手数料 - ガス代 - slippage - price impact
       = ~0.03%       - ~0.05%     - ~0.01% - ~0.2%    - ~0.2%
       = -0.43% (常に赤字)

quote価格で見える「利益」は、実行すると消える。
```

**3つの壁:**
1. **AMMの構造:** buy価格 > sell価格が常に成立。手数料がそうさせる
2. **実行コスト:** quote価格と実行価格は別物。slippage + price impactで0.4%消える
3. **資本の壁:** $3で取引すると利益は数十lamports。ガス代(5,000+)を超えない

---

## 構築したツール

このプロジェクトで構築した技術は、arb以外の用途（DEX bot開発、Solanaプログラム分析など）に再利用できる。

### 1. Raydium AMM V4 直接Swap

Jupiter不要でRaydium AMM V4のSwapBaseIn命令を直接構築・実行する。

```
// Pool account parsing (18 accounts)
offset 336: coinVault
offset 368: pcVault
offset 496: openOrders
offset 528: serumMarket
offset 560: serumProgram
offset 592: targetOrders

// AMM authority PDA
seeds: ["amm authority"]
program: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8

// SwapBaseIn instruction
index: 9
data: [9, amountIn(u64), minAmountOut(u64)]
```

→ [`src/executor.js`](src/executor.js)

### 2. Orca Whirlpool 直接Swap

Whirlpoolのaccount layout完全解析とtick array PDA導出。

```
// Whirlpool account layout
offset  81: tickCurrentIndex (i32)
offset 101: tokenMintA (Pubkey)
offset 133: tokenVaultA (Pubkey)
offset 165: feeGrowthGlobalA (u128)
offset 181: tokenMintB (Pubkey)
offset 213: tokenVaultB (Pubkey)

// Tick array PDA — 重要: seedはstring形式
findProgramAddressSync(
  ["tick_array", pool.toBuffer(), Buffer.from(startIndex.toString())],
  whirlpoolProgram
)

// Swap instruction discriminator
swap:   f8c69e91e17587c8 (11 accounts)
swapV2: e00a104585c17670 (15 accounts)
```

→ [`src/sim-arb.js`](src/sim-arb.js)

### 3. SOL/USDC Whirlpool 全Pool一覧

同じペアで7つのfee tierが存在する：

| Tick Spacing | Fee | Pool Address | TVL |
|-------------|-----|-------------|-----|
| 1 | 0.01% | `83v8iPyZ...` | 76 SOL |
| 2 | 0.02% | `FpCMFDFG...` | 972 SOL |
| 4 | 0.04% | `Czfq3xZZ...` | 174,489 SOL |
| 8 | 0.05% | `7qbRF6Ys...` | 1,128 SOL |
| 16 | 0.16% | `21gTfxAn...` | - |
| 64 | 0.30% | `HJPjoWUr...` | 698 SOL |
| 128 | 1.28% | `DFVTutNY...` | - |

### 4. Atomic 2-Leg Transaction

2つのOrcaプールを1つのトランザクションで往復swap。1,010 bytes（制限1,232以内）。

→ [`src/sim-arb.js`](src/sim-arb.js)

### 5. リアルタイムSpread Monitor

WebSocketでpool状態変化を検知し、全pool間のスプレッドをリアルタイム計測。

→ [`src/spread-monitor.js`](src/spread-monitor.js)

### 6. Pump.fun Sniper Bot

新トークンのbonding curve進捗率を監視し、閾値超えで自動購入するbot。

フィルタシグナル分析結果：
- `real_sol_reserves / 85 SOL * 100` = bonding curve completion %
- completion > 40% のトークンが比較的安定（ただし-83%の例あり）
- 画像あり / twitter / repliesは全トークン共通で差別化にならない

→ [`src/pump-sniper.js`](src/pump-sniper.js)

### 7. Copy-Trade Bot

利益walletの取引をリアルタイム監視・自動コピーするbot。

→ [`src/copy-trade.js`](src/copy-trade.js)

### 8. Hyperliquid Funding Rate Bot

KYCなしで使えるHyperliquidのfunding rateを自動収穫するbot。

→ [`src/hl-funding.js`](src/hl-funding.js)

---

## 重要な教訓

### 検証で学んだ事実

1. **sim利益 ≠ real利益** — `simulateTransaction`はガス代を引かない
2. **quote価格差 ≠ 実行可能利益** — 実行するとslippage + price impactで消える
3. **一時的バースト ≠ 安定収益** — 2分間のデータを外挿しない
4. **技術的成功 ≠ 経済的成功** — txが動くことと利益が出ることは別
5. **pool間価格差はfee差に起因する** — 低fee poolは高く、高fee poolは安く見える。これは裁定機会ではなくfee構造の反映
6. **Pump.funのcompletion率は安全指標にならない** — 52%到達後に-83%崩壊する事例を確認

### $0検証の方法論

全てsimulateTransactionで$0検証した。手順：

```
1. Pool state読み取り（getAccountInfo）
2. Swap命令構築（直接instruction）
3. simulateTransaction（sigVerify:false, replaceRecentBlockhash:true）
4. 結果のaccount stateから残高変化を計算
5. ガス代を差し引いて純利益を計算
```

この方法で**実際にお金を使わずに**正確な損益を測定できる。

---

## プロジェクト構成

```
├── src/
│   ├── sim-arb.js          # Orca×Orca atomic arb simulator
│   ├── spread-monitor.js   # リアルタイムスプレッド監視
│   ├── pump-sniper.js      # Pump.fun sniper bot
│   ├── copy-trade.js       # Copy-trade bot
│   ├── hl-funding.js       # Hyperliquid funding rate bot
│   ├── live.js             # Jupiter arb bot (WebSocket)
│   ├── executor.js         # Raydium/Orca直接swap
│   ├── pools.js            # Pool state直接読み取り
│   └── ... (28ファイル)
├── results/                 # 全検証データ (59ファイル)
│   ├── spread-monitor.jsonl # 2,132チェック分のスプレッドデータ
│   ├── sim-arb.jsonl        # atomic sim結果
│   ├── pump-sniper.jsonl    # sniper dry-run結果
│   └── ...
├── dashboard.html           # 監視UI
├── dashboard-server.js      # ダッシュボードサーバー
└── data/                    # 分析データ
    └── FINDINGS.md          # 詳細な検証結果
```

## セットアップ

```bash
npm install @solana/web3.js @solana/spl-token ws ethers dotenv
```

```env
# .env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
DRY_RUN=true
```

## 免責事項

- このプロジェクトは教育・研究目的で公開しています
- 暗号通貨取引にはリスクが伴います。このコードを使用して損失が発生しても責任を負いません
- 実際の取引を行う場合は自己責任で、少額からテストしてください
- Helius APIキーやウォレットの秘密鍵は必ず自分のものに置き換えてください

## ライセンス

MIT
