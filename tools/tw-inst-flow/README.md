# 台股三大法人資金流向 每日自動日報

每個交易日自動做三件事：

1. 抓證交所（上市）＋櫃買（上櫃）當日**三大法人買賣超**全市場明細
2. 算出排行榜與**連續買/賣超天數**
3. 丟給 Claude 寫一段資金流向解讀，然後**寄一封 mail 給自己**

只用 Python 標準函式庫，唯一的外部套件是 `anthropic`（只有 AI 分析那段需要，沒裝也能跑）。

---

## 快速開始（Windows PowerShell）

```powershell
# 1) 先確認資料源通不通，不寄信、不花錢
python tools\tw-inst-flow\scan.py --selftest

# 2) 看看報告長什麼樣（不寄信）
python tools\tw-inst-flow\scan.py --dry-run

# 3) 設好信箱後，正式寄一封
$env:SMTP_USER = "你的gmail@gmail.com"
$env:SMTP_PASS = "十六碼應用程式密碼"   # 不是 Gmail 登入密碼，見下方
$env:MAIL_TO   = "你的gmail@gmail.com"
python tools\tw-inst-flow\scan.py
```

要加 AI 分析段落：

```powershell
pip install anthropic
$env:ANTHROPIC_API_KEY = "sk-ant-..."
python tools\tw-inst-flow\scan.py --dry-run
```

## 參數

| 參數 | 說明 |
| --- | --- |
| `--selftest` | 只測資料源，印出交易所回傳的欄位結構 |
| `--dry-run` | 完整跑，報告印在畫面，不寄信 |
| `--date 20260911` | 指定日期；預設由今天往回找最近有資料的交易日 |
| `--days 6` | 連續天數統計往回取幾個交易日（預設 6） |
| `--top 15` | 每個排行取前幾名（預設 15） |
| `--no-ai` | 跳過 AI 分析 |
| `--out out` | 同時把報告存成 `.md` 和 `.html` |

## 環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `SMTP_HOST` | `smtp.gmail.com` | |
| `SMTP_PORT` | `465` | 465 走 SSL，587 走 STARTTLS |
| `SMTP_USER` / `SMTP_PASS` | — | Gmail 帳號 + **應用程式密碼** |
| `MAIL_TO` | 同 `SMTP_USER` | 收件者 |
| `ANTHROPIC_API_KEY` | — | 沒設就跳過 AI 分析，其他照跑 |
| `ANTHROPIC_MODEL` | `claude-opus-5` | |

### Gmail 應用程式密碼怎麼拿

Gmail 不接受一般登入密碼寄信。到 Google 帳戶 →「安全性」→ 開啟兩步驟驗證 →「應用程式密碼」→ 產生一組 16 碼，把那組填進 `SMTP_PASS`。

---

## 讓它每天自動跑（GitHub Actions）

倉庫裡已經有 `.github/workflows/tw-inst-flow.yml`，排程是**每週一到週五台北時間 18:00**。

1. 到 GitHub repo → Settings → Secrets and variables → Actions，新增：
   `SMTP_USER`、`SMTP_PASS`、`MAIL_TO`，需要 AI 分析再加 `ANTHROPIC_API_KEY`
2. **把這個分支合併回預設分支（main）**——GitHub 的排程只會執行預設分支上的 workflow，留在功能分支不會每天跑。
3. 想手動跑一次：Actions 頁面 → 選這個 workflow → Run workflow，模式選 `selftest` / `dry-run` / `send`。

## 費用

- 資料：證交所、櫃買公開資料，免費。
- GitHub Actions：公開 repo 免費；私有 repo 每月有免費額度，這支每次跑不到 1 分鐘。
- AI 分析：每天一次，輸入約 1 萬 token、輸出約 1 千 token，以 `claude-opus-5` 計約每天 US$0.08 上下（實際依當下價格）。不想花就不要設 `ANTHROPIC_API_KEY`。

---

## 幾件必須先講清楚的事

- **這支程式做的是「資訊整理」，不是「選股系統」，更不是保證獲利的東西。** 三大法人買賣超是落後資訊（收盤後才公布），外資買超也常常是避險、ETF 調整、借券還券造成的，跟看多看空沒有必然關係。
- 報告裡的「外資」= 外陸資（不含外資自營商）＋ 外資自營商，跟部分網站的口徑可能差一點點。
- 只統計 **4 碼普通股**，ETF、權證、特別股、興櫃都被濾掉了。
- 排行是用**張數**排，不是金額。張數大的常常是低價股，看的時候要自己換算。
- 交易所有流量限制，程式每個請求之間會停約 1.2 秒；`--days` 開太大跑很久。
- 遇到連假或交易所延後公布，程式會自動往前找最近一個有資料的交易日。

資料來源：臺灣證券交易所、證券櫃檯買賣中心公開資料。本工具僅整理公開資訊，不構成任何投資建議。
