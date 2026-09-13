# 密室每日戰情簡報

每天早上 08:30 自動寄一封信給你，內容是：

- **今日場況**：兩間店七個主題各幾場、幾點，和上週同一天比是增是減
- **明日預警**：明天哪些主題還完全沒訂位（還來得及做動作）
- **人力對應**：今日排班 vs 今日有場的主題，抓出「有場沒人 / 有人沒場」
- **今日重點**：Claude 用上面的數字寫 3-5 句話，含一個當天可執行的建議

信裡只有彙總數字與時段，**不會出現客戶姓名、電話、Email**。

先看長相：

```powershell
python tools\bgl-daily-brief\brief.py --demo
```

`--demo` 產生的是捏造的假資料，報表上方會有紅色「示範資料」標示。

---

## 現在還不能跑真實資料，卡在兩個設定（實測結果）

2026-09-13 從 GitHub Actions 實際打你的端點，結果如下：

| 端點 | 回應 | 意思 |
| --- | --- | --- |
| `bgl-backend-new.vercel.app/api/health` | 503 | 後端活著，但自我檢查沒過 |
| `…/api/bookings` | 500 `{"error":"APP_API_KEY 未設定，拒絕服務"}` | 後端照設計拒絕服務 |
| GAS `getTodayStatus` 等 | 403（Google 權限頁） | 不接受匿名呼叫 |

`/api/health` 還回報了：

```json
"config": { "SB_API_KEY": true, "DATABASE_URL": false,
            "APP_API_KEY": false, "SB_WEBHOOK_SECRET": false,
            "ALLOWED_ORIGIN": "*（未限制，建議上線後設定）" },
"simplybook": { "ok": false,
                "message": "SimplyBook 連線失敗：SimplyBook login error: {\"code\":-32…" }
```

所以要讓這支跑出真資料，要處理三件事：

### 1. Vercel 設 `APP_API_KEY`

到 Vercel 專案 → Settings → Environment Variables 新增 `APP_API_KEY`（自己想一組長字串），重新部署。
然後把同一組字串加進 GitHub repo 的 Secrets，名稱也叫 `APP_API_KEY`。

本工具會同時用 `x-api-key` 和 `Authorization: Bearer` 兩種標頭送出，
因為後端實際吃哪一種我沒看到原始碼、無法確定；等你設好跑一次 `--selftest` 就知道。
若兩種都不對，看後端程式碼確認標頭名稱後告訴我，一行就能改。

### 2. 修好 SimplyBook 連線

`SB_API_KEY` 有設定但登入失敗（JSON-RPC `code -32…`），通常是金鑰過期、被重新產生、
或 company login 不符。到 SimplyBook 後台重新產生 API key，更新 Vercel 的環境變數。
**這一項不修好，APP_API_KEY 設了也拿不到訂位資料。**

### 3. 排班資料（可選，不做也能跑）

GAS 對伺服器端呼叫回 403，所以「人力對應」那段目前拿不到資料——其他段落照常。
要開通的話有兩條路：

- **簡單但風險高**：Apps Script 重新部署，「誰可以存取」改成「所有人」。
  但你的 GAS 網址寫在 public repo 的 `src/App.jsx` 裡，等於公開給全世界呼叫，**不建議**。
- **建議做法**：在 GAS 裡加一個共享密鑰檢查（例如 payload 帶 `token`，比對 Script Property），
  再改成「所有人」可存取。這樣網址公開也沒關係，沒有 token 的呼叫會被擋。

第二條路我可以幫你寫 GAS 那段程式碼，你說一聲。

---

## 順便提醒兩個安全設定

這兩項跟本工具無關，是探測時順手看到的：

- `ALLOWED_ORIGIN` 目前是 `*`（後端自己也標註「建議上線後設定」）。
  建議改成你的前端網域，避免任何網站都能打你的 API。
- 你的 repo 是 **public**，`src/App.jsx` 裡的 GAS 網址與後端網址都看得到。
  目前 GAS 擋掉匿名呼叫、後端也有 APP_API_KEY 保護，所以沒有立即外洩問題，
  但**改 GAS 權限時務必連同 token 一起做**，否則就真的門戶大開了。

---

## 設定好之後怎麼用

```powershell
# 確認端點通不通（只印欄位名與筆數，不印客戶資料）
python tools\bgl-daily-brief\brief.py --selftest

# 看今天的報表，不寄信
python tools\bgl-daily-brief\brief.py --dry-run

# 正式寄出
python tools\bgl-daily-brief\brief.py
```

| 參數 | 說明 |
| --- | --- |
| `--demo` | 用假資料看報表長相 |
| `--selftest` | 探測 API 結構 |
| `--dry-run` | 不寄信 |
| `--date 2026-09-14` | 指定日期 |
| `--no-ai` | 跳過 AI 摘要 |
| `--out out` | 另存 HTML |

| 環境變數 | 用途 |
| --- | --- |
| `APP_API_KEY` | 後端的存取金鑰（同 Vercel 那組） |
| `SMTP_USER` / `SMTP_PASS` / `MAIL_TO` | Gmail 帳號＋應用程式密碼＋收件者 |
| `ANTHROPIC_API_KEY` | 有設才做 AI 摘要，沒設其他照跑 |
| `BGL_BACKEND_URL` / `BGL_GAS_URL` | 換端點時才需要 |

### 自動排程

`.github/workflows/bgl-daily-brief.yml` 已設定每天台北時間 08:30 執行。
要真的每天跑，**必須把這個分支合併回 main**（GitHub 排程只執行預設分支上的 workflow），
並在 repo Secrets 補上 `APP_API_KEY`、`SMTP_USER`、`SMTP_PASS`、`MAIL_TO`、`ANTHROPIC_API_KEY`。

---

## 已知限制

- 目前只統計「已成立的訂位場次」，沒有營收與人數——SimplyBook 回傳裡有沒有這些欄位，
  要等真的連得上才知道，有的話可以加。
- 「明日沒訂位的主題」是用**訂位數為零**判斷，不等於該時段真的開放可預約
  （開放時段要另外打 SimplyBook 的可預約時段 API）。
- 「有場沒人」依賴排班資料裡有主題欄位，GAS 通了才驗證得了。
- 取消的訂位只在資料明確標示 cancel 時才排除，避免把正常訂位誤判掉。
