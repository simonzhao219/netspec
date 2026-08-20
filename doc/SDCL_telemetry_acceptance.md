# NetSpec Telemetry — Merge 之後怎麼部署、怎麼驗收

這份文件回答兩個問題：

1. **PR merge 進 `develop` 之後，接下來要跑什麼？**
2. **怎麼證明我們真的達到 `doc/SDCL_telemetry.md` 的 Success Criteria？**

配套文件：
- `SDCL_telemetry_deployment.md` — **一次性**的 Unity Catalog 設定（建 schema、開 App telemetry、建 view）。第一次上線前要先做完那份。
- `SDCL_telemetry_events.md` — 事件字典，查「這個 event_name 是什麼意思」用。
- `sql/04_verify.sql` — 本文件第 4 節用到的所有查詢。

---

## 0. 先確認前置條件

**如果這是第一次部署 telemetry**，先做完 `SDCL_telemetry_deployment.md` 的第 1～3 節，否則資料無處可去。快速自檢：

```sql
-- 三個都要有回應，否則回去做 deployment runbook
SHOW TABLES IN ep_dev.netspec LIKE '*otel_logs*';   -- App telemetry 已啟用？
DESCRIBE TABLE ep_dev.netspec.app_events;            -- 01_setup.sql 跑過？
DESCRIBE ep_dev.netspec.v_app_events;                -- 03_views.sql 跑過？
```

**如果是後續的例行更新**（telemetry 已經在跑，只是部署新版程式），直接跳到第 2 節。

---

## 1. Merge

```bash
git checkout develop
git pull origin develop
# 在 GitHub 上 merge PR #1（或用 CLI），然後：
git pull origin develop
git log --oneline -3     # 確認 telemetry commit 在裡面
```

> 目前**沒有自動部署**。`.github/workflows/databricks-test.yml` 的觸發條件是
> `push` 到 `dev` 分支，但這個 repo 只有 `main` / `develop`，所以那個 workflow
> 從來沒跑過。merge 完不會有任何事情自動發生，要手動跑第 2 節。

---

## 2. 部署三個 App

三個都要部署。**telemetry 是每個 App 各自獨立的** —— 只部署前端的話，只會拿到瀏覽器互動，拿不到 pipeline 步驟、規格產出與 AI 成本。

```bash
EMAIL=your_email@asus.com   # 小寫

# 1/3 text-spec-service：pipeline 事件、spec_version、llm_call 成本
databricks sync ./backend/text-spec-service /Workspace/Users/$EMAIL/netspec-backend --full
databricks apps deploy netspec-backend --source-code-path /Workspace/Users/$EMAIL/netspec-backend

# 2/3 figma-service：Figma pipeline 事件、story 產出、monitor 比對
databricks sync ./backend/figma-service /Workspace/Users/$EMAIL/netspec-figma-backend --full
databricks apps deploy netspec-figma-backend --source-code-path /Workspace/Users/$EMAIL/netspec-figma-backend

# 3/3 frontend：/api/events ingest + 所有瀏覽器互動
databricks sync ./frontend /Workspace/Users/$EMAIL/netspec --full
databricks apps deploy netspec --source-code-path /Workspace/Users/$EMAIL/netspec
```

沒有新增任何 secret，Secret ACL 與 Volume 權限都不用重做。

---

## 3. 部署後 5 分鐘冒煙測試

**先做這個，再做第 4 節的完整驗收。** 這一節只確認「管線是通的」，不用寫 SQL。

### 3a. 新版程式有上去嗎

```bash
curl -s https://<netspec-backend-url>/api/health | jq .telemetry
curl -s https://<netspec-figma-backend-url>/api/health | jq .telemetry
```

`telemetry` 這個區塊**只存在於新版程式**，所以它有回應就代表部署成功：

```json
{
  "app": "netspec",
  "service": "text-spec-service",
  "stdout_sink": true,
  "delta_sink": false,
  "delta_table": "ep_dev.netspec.app_events",
  "delta_warehouse_id": null,
  "delta_pending_rows": 0,
  "delta_failed": false
}
```

- `service` 必須是 `text-spec-service` / `figma-service`，不能是 `unknown-service`
- `delta_sink: false` 是**正常的**（直寫是選配，預設關閉）
- `delta_failed: true` 才是要處理的訊號 → 見第 5 節

前端 ingest 端點：

```bash
curl -s https://<netspec-frontend-url>/api/events     # {"ok":true,"endpoint":"/api/events",...}
```

### 3b. 事件真的有寫出來嗎

**這是最快的檢查點，比查 SQL 快得多**，因為它跳過整條匯出鏈路。

Databricks UI → **Compute → Apps → 選 App → Logs**，然後在瀏覽器操作一次 NetSpec。log 裡應該立刻出現像這樣的一行：

```json
{"event_id":"3c3c3dd4-...","telemetry_schema":"ep.app_event.v1","app":"netspec","service":"frontend","event_type":"ui_interaction","event_name":"page_view","event_time":"2026-08-21T02:11:03.412Z","received_at":"2026-08-21T02:11:03.480Z","page":"/","workflow":"text","session_id":"sess-...","app_session_id":null,"user_email":"you@asus.com","user_id":"...","request_id":"...","duration_ms":null,"properties":"{\"view\":\"app\"}"}
```

**逐項確認**：`telemetry_schema` 是 `ep.app_event.v1`、`service` 對得上這個 App、
**`user_email` 是你自己的 email**（不是 null、不是 service principal）。

> 看到這一行，criterion #1 的程式面就已經成立了 —— 剩下的只是匯出與查詢。
> 如果這裡看不到 → 直接跳到第 5 節，不用往下查 SQL。

---

## 4. 完整驗收

### 4a. 產生測試資料（照著點，約 10 分鐘）

用**真的 Databricks App URL** 開啟 NetSpec（不要用 localhost、不要用 ngrok —— 身分 header 是 Databricks auth proxy 注入的，繞過它就沒有 `user_email`）。

**情境 A — 文字工作流**（涵蓋 criteria #1 / #2 / #10）

| # | 動作 | 會產生的關鍵事件 |
|---|---|---|
| 1 | 開啟 App | `page_view` |
| 2 | 切一次「規格詳細度」 | `detail_level_changed` |
| 3 | 輸入需求 → 開始分析 | `analysis_started`、`session_created`、`pipeline_started` |
| 4 | 回答一輪蘇格拉底追問 | `socratic_answered`、`pipeline_interrupted` |
| 5 | 確認搜尋計畫 | `search_plan_confirmed` |
| 6 | 等規格產出 | `pipeline_step_completed` ×8、`pipeline_completed`、**`spec_version`**、**`llm_call`** ×N |
| 7 | 按「優化迭代」跑一次 | `spec_iterate_clicked`、`spec_iterated`、第二筆 **`spec_version`** |
| 8 | 產生「架構師視圖」 | `role_view_requested`、**`role_view_generated`** → `approval_state` 變成 `approved_derived` |
| 9 | 匯出 Markdown | `spec_exported` |
| 10 | 切換到別的面板看一下 | `panel_viewed` |
| 11 | **關掉分頁** | `session_end` |

> **第 11 步不能省。** `session_end` 是在分頁隱藏／關閉時才用 `sendBeacon` 送出的，
> 不關分頁就沒有這筆，`v_sessions` 的 dwell time 會不準。

**情境 B — Figma 工作流**（可選，涵蓋 criterion #9 的跨工作流時間軸）

載入一個 Figma 檔 → 選 Frame → 生成 Story → 存檔。會產生 `figma_file_loaded`、
`figma_pipeline_started`、`figma_story_generated`、`figma_story_version_saved`。

### 4b. 等待與查詢

前端事件會先在瀏覽器批次 700ms，Delta 直寫（若啟用）每 10 秒 flush 一次，
stdout → `otel_logs` 的匯出還有平台自己的延遲。**先等幾分鐘再查**；如果 3b 的
App log 看得到但 SQL 查不到，那就是匯出還沒跟上，過幾分鐘重查即可。

然後跑 `doc/sql/04_verify.sql`。下面是逐條對應 Success Criteria 的驗收表 ——
建議直接複製這張表，把實際結果填進最後一欄，當作 Week 5 評估的紀錄。

### 4c. 驗收表

| # | Success Criterion | 用哪段查詢 | PASS 的條件 | 實際結果 |
|---|---|---|---|---|
| **1** | App telemetry capture | `04_verify.sql` §1 | 瀏覽器裡的一次點擊變成**一列 typed row**，`user_email` 是你自己的 email；且 `unattributed = 0` | |
| **1** | 「no instrumentation beyond one track() call」 | 看程式碼 | 每個互動只有一行 `track(...)`；App 內沒有任何認證程式碼（身分全部來自 `X-Forwarded-Email`） | |
| **2** | App output：spec 版本與 approval state | `04_verify.sql` §2 | `v_spec_versions` 每個版本一列，含 `quality_score` 與 `approval_state`；情境 A 第 8 步之後該筆為 `approved_derived` | |
| **2** | 「joinable to the telemetry on session and user」 | `04_verify.sql` §2 | **同一句 SQL** 同時回傳 spec 版本與它的 `interactions` 數與 `session_seconds` | |
| **10** | Token usage and cost by SDLC stage | `04_verify.sql` §3 | 每個 SDLC 步驟一列，token 數非 0，成本可加總；且每份規格能算出 `cost_usd` | |
| **10** | 「from platform system tables」 | — | ⚠️ **尚未成立**，見下方說明 | |
| **9** | 跨 App 使用情形（前置） | `04_verify.sql` §5 | 文字與 Figma 兩條工作流出現在同一條時間軸上 | |
| — | 行為分析可用性 | `04_verify.sql` §4 | 漏斗、各步驟耗時、面板使用率、re-work 次數都查得出來 | |

#### 關於 criterion #10 的誠實說明

文件裡 #10 的目標寫的是「available from platform system tables」。目前的實作提供的是
**同樣的指標，但來源是 app telemetry 而不是 system tables**：

- ✅ **已達成**：token 用量與成本**依 SDLC 步驟**拆解，而且**呼叫端零埋點**（事件從
  `llm_client._record_usage()` 這個所有模型呼叫本來就必經的唯一路徑送出）。
- ⚠️ **尚未達成**：走 system tables。那需要模型呼叫改走 **Databricks-hosted Anthropic
  endpoint**（把 `LLM_*` 環境變數改成 `databricks:` 前綴的模型，程式已經支援這個
  provider）。改完之後平台 system tables 會有權威的 token 與費用數字。
- 兩者不是二選一：system tables 知道花了多少錢，但**不可能知道這筆花費屬於哪個 SDLC
  步驟** —— 那個維度只有 `v_ai_cost_by_stage` 提供。最終形態是兩邊 join。

Week 5 評估時請不要把 #10 記成完全達成，也不要記成沒做 —— 準確的說法是
**「指標已可用，資料源尚未切換到 system tables」**。

---

## 5. 沒有資料的時候，照這個順序查

### 症狀：App log（第 3b 節）就看不到 JSON 行

| 檢查 | 怎麼確認 | 修法 |
|---|---|---|
| 新版程式沒上去 | `/api/health` 沒有 `telemetry` 區塊 | 重跑第 2 節的 sync + deploy |
| App 根本沒起來 | Apps UI 顯示 error / crash loop | 看 log 最前面的 traceback |
| 前端 build 失敗 | log 卡在 `npm run build` | 確認 `next.config.ts` 的 `eslint.ignoreDuringBuilds` 有在 merge 進來的版本裡 |
| 沒有真的操作 | log 只有啟動訊息 | 在瀏覽器實際點一下（`page_view` 是進頁面就會送的） |

### 症狀：App log 有 JSON 行，但 `v_app_events` 是空的

| 檢查 | 怎麼確認 | 修法 |
|---|---|---|
| App telemetry 沒開 | `SHOW TABLES IN ep_dev.netspec LIKE '*otel_logs*'` 沒東西 | UI 開啟後**必須重新 deploy 一次** App 才會開始匯出 |
| **只開了其中一個 App** | 只有某個 `service` 有資料 | telemetry 是**每個 App 各自設定**的，三個都要開 |
| 表名有 prefix | 表叫 `xxx_otel_logs` | 改 `02_bronze_from_otel.sql` 的 `FROM` 子句 |
| 匯出還沒跟上 | 剛操作完不到一兩分鐘 | 等一下重查 |
| view 的解析對不上 | 下面的 debug 查詢 | 見下方 |

`otel_logs` 有資料但 view 是空的時候，用這句看原始形狀：

```sql
SELECT time, service_name, body::string AS raw
FROM ep_dev.netspec.otel_logs
WHERE body::string LIKE '%ep.app_event.v1%'
ORDER BY time DESC LIMIT 5;
```

- 查得到 → `try_parse_json` 沒吃下去，把 `raw` 的實際內容貼出來對照 `02_bronze_from_otel.sql`
- 查不到 → 匯出鏈路的問題，不是 view 的問題，回上表

### 症狀：有資料，但 `user_email` 是 NULL

| 情況 | 原因 | 修法 |
|---|---|---|
| 全部都 NULL | 沒有經過 Databricks auth proxy（用了 localhost / ngrok / 直連後端） | 用真正的 App URL 操作 |
| 只有後端事件 NULL | 前端 proxy 沒轉發身分 header | 確認 `frontend/app/api/[...path]/route.ts` 的 header relay 有在部署的版本裡，並重新部署前端 |

### 症狀：有前端事件，但沒有 `spec_version` / `llm_call`

代表**後端 App 沒有部署新版或沒開 telemetry**。先確認
`SELECT DISTINCT service FROM v_app_events` 有沒有 `text-spec-service`。

`llm_call` 完全沒有還有兩個可能：跑在 demo mode（`/api/health` 的 `demo_mode: true`），
或這次流程完全命中快取沒有真的呼叫模型 —— 對照 `/api/cost-report` 是不是也是空的。

### 症狀：`delta_failed: true`

只影響**選配的直寫路徑**，stdout 主路徑不受影響，使用者也不會有感覺。原因通常是
service principal 少了 SQL warehouse 的 `CAN_USE`、或 table 的 `MODIFY`、或 warehouse 停掉了。
授權步驟見 `SDCL_telemetry_deployment.md` 第 6 節。設計上它只會在 stderr 印一次錯誤就靜默降級，
所以請直接看 App log 的第一筆 `[telemetry]` 訊息，那裡有實際的 HTTP 錯誤內容。

---

## 6. 驗收完成之後

1. 把第 4c 的表填完，附上幾張查詢結果截圖 —— 這就是 Week 5「Review results against the success criteria」的材料。
2. 設定 Genie space（`SDCL_telemetry_deployment.md` 第 7 節），把四個 view 加進去，讓 PM / Dev Lead / Test Lead 各自問自己的問題（criterion #6）。
3. 通知 BugZapper（Winnie）與 Polaris 兩邊：record 契約與 `app` 欄位已經備好，
   送出相同形狀的 record 就會自動出現在同一組 view 裡，下游查詢不用改
   （契約看 `SDCL_telemetry_events.md`，欄位定義看 `sql/01_setup.sql` 的 COMMENT）。
