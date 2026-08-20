# NetSpec — Agentic AI Network Specification Generator

> 將模糊的網通需求，轉化為可直接使用的 PRD 規格書。

NetSpec 是一個企業級 Agentic AI 平台，透過蘇格拉底式追問與社群情報爬取，協助 PM、架構師、QA 將口語化的 VLAN、BGP、防火牆等需求，結構化為完整的技術規格文件。

---

## 功能特色

**需求規格生成**
- **蘇格拉底式追問** — 最多 5 輪追問，自動評估需求清晰度（分數 < 70 繼續追問）
- **社群情報爬取** — 自動搜尋 GitHub Issues、Hacker News，挖掘真實踩坑經驗與 CVE
- **PRD 自動生成** — 含目標平台、NFR 可靠性指標、開放問題、RFC 引用、驗收標準
- **品質校驗與迭代** — 自動評分，支援有方向或無方向的優化迭代，附分數變動追蹤
- **中英文切換** — Section-by-section 翻譯，DB 快取避免重複翻譯
- **規格詳細度** — concise / standard / comprehensive 三段選擇，精簡檢視模式

**角色視圖（PM-first）**
- PM 規格確認後，按需衍生**架構師視圖**、**QA 視圖**
- 避免單一文件塞入所有角色需求，保持規格聚焦

**Figma 整合**
- **Figma OAuth 授權** — 安全連接 Figma 帳號
- **畫面解析** — 自動擷取 Frame 文字、UI 元件結構、設計師 Comments
- **Story 生成** — 對每個 Frame 產生 PM / FE / BE / QA 四種角色的可用 Story
- **多輪追問** — 生成前最多 3 輪釐清需求的追問
- **版本歷史** — 每次生成保存為快照，可隨時查閱舊版本

**其他**
- **Phase 0 安全檢查** — 三層防護（敏感資訊遮蔽、攻擊攔截、Prompt Injection 移除）
- **Per-step LLM 路由** — 每個 Pipeline 節點可獨立分配不同模型或 provider
- **多 Provider 支援** — Azure Anthropic、Azure OpenAI、Databricks Model Serving、OpenAI、Ollama

---

## 技術架構

```
netspec-app/
├── backend/
│   ├── text-spec-service/   # 需求輸入 → 蘇格拉底追問 → PRD（獨立 FastAPI process，本機 :8000）
│   │   ├── app.yaml         # Databricks Apps 部署設定
│   │   ├── .env             # 實際上是 symlink 到 backend/.env（單一密鑰來源）
│   │   └── requirements.txt
│   ├── figma-service/       # Frame 分析 + Frame 監控 + Figma Story pipeline（獨立 FastAPI process，本機 :8001）
│   │   ├── app.yaml
│   │   ├── .env             # 同上，symlink 到 backend/.env
│   │   └── requirements.txt
│   └── .env.example         # 環境變數範本（兩個服務共用同一份 .env）
├── frontend/          # Next.js 16 + Tailwind v4 + shadcn/ui
│   ├── app.yaml       # Databricks Apps 部署設定
│   ├── app/api/[...path]/route.ts  # 依路徑分流到兩個後端
│   └── start.sh       # Databricks 啟動腳本
└── skills/            # Socratic 題庫、安全規則
```

兩個後端服務完全獨立（各自的 process、db 檔、Databricks App），不互相呼叫——文字輸入的問題不會拖累 Figma 功能，反之亦然。`llm_client.py`/`cost.py` 等共用邏輯目前是刻意複製一份到兩邊，不是共用套件（先簡單，之後真的痛了再抽）。

### Backend（text-spec-service）
- **Python** + FastAPI + LangGraph 8 節點 Pipeline
- `parse → socratic → plan → scrape → analyze → detect_edges → gherkin → validate`
- `interrupt()` Human-in-the-loop（追問暫停等待回答）
- SQLite 持久化（sessions、iterations、翻譯快取）
- SSE 即時串流

### Backend（figma-service）
- Figma OAuth、Frame 解析、Frame 監控、Story pipeline（LangGraph Human-in-the-loop）
- SQLite 持久化（figma_cache、figma_tokens、Figma 故事、Frame 監控歷史、teams_webhooks）

### Frontend
- **Next.js 16** + React 19 + Tailwind CSS v4 + shadcn/ui
- 工具呼叫可視化（PipelinePanel）
- 版本切換（v1/v2/v3 迭代歷史）
- 角色視圖切換（PM / 架構師 / QA）

---

## 快速開始（本機開發）

### 前置需求

- Python 3.10+
- Node.js 18+
- Azure AI Services 或 Ollama（本地模式）

### 安裝與啟動

```bash
git clone <repo-url>
cd netspec-app

# Backend — .env 放在 backend/ 底下，兩個服務共用（各自目錄下是 symlink）
cd backend
cp .env.example .env   # 填入 API Key

# text-spec-service（另開終端機）
cd backend/text-spec-service
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000

# figma-service（另開終端機）
cd backend/figma-service
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8001

# Frontend（另開終端機）
cd frontend
npm install
npm run dev
```

開啟瀏覽器：
- Frontend：http://localhost:3000
- text-spec-service API Docs：http://localhost:8000/docs
- figma-service API Docs：http://localhost:8001/docs

### ngrok（對外分享）

```bash
bash start-ngrok.sh
```

---

## 環境變數

複製 `backend/.env.example` 為 `backend/.env` 並填入。詳細說明見 `.env.example`。

**主要欄位**

| 變數 | 說明 |
|------|------|
| `API_BASE_URL` | Azure AI Services endpoint |
| `API_KEY` | Azure API 金鑰 |
| `USE_OLLAMA` | `true` 啟用本地 Ollama 模式 |
| `DEFAULT_MODEL` | 預設模型（其他欄位留空時的 fallback）|
| `SECRET_KEY` | Figma OAuth token 加密金鑰（Fernet）|

**Per-step 模型分配**

格式：`model名稱` 或 `provider:model`（e.g. `databricks:databricks-claude-3-7-sonnet`）

```env
LLM_PARSE=gpt-5.4
LLM_SOCRATIC=gpt-5.4
LLM_PRD=claude-opus-4-6-2026V2
LLM_FIGMA_QUESTIONS=             # 留空 fallback 到 LLM_SOCRATIC
LLM_FIGMA_STORY=                 # 留空 fallback 到 LLM_PRD
```

**支援的 Provider**

| Provider | 格式範例 |
|----------|---------|
| Azure Anthropic（預設）| `claude-opus-4-6-2026V2` |
| Azure OpenAI（預設）| `gpt-5.4` |
| Databricks Model Serving | `databricks:databricks-claude-3-7-sonnet` |
| OpenAI direct | `openai:gpt-4o` |
| Ollama | `ollama:llama3` |

---

## 部署到 Databricks Apps

> Databricks App 是**運算容器**（磁碟為暫存、重啟即清空），不是儲存空間。
> 每個 App 有自己的 service principal，且透過各自的 auth proxy 隔離。以下步驟含
> 幾個不做就會卡住的重點：**Secret ACL、Volume 三層權限、SQLite 持久化架構**。

### 1. CLI 與 Secret Scope

```bash
# 安裝 + 登入
curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sudo sh
databricks configure

# 建立 Secret Scope 並填入金鑰（真實 key 只放這裡，不進 .env / git）
databricks secrets create-scope netspec
databricks secrets put-secret netspec api_base_url        --string-value "..."
databricks secrets put-secret netspec api_key             --string-value "..."
databricks secrets put-secret netspec secret_key          --string-value "..."
databricks secrets put-secret netspec figma_client_id     --string-value "..."
databricks secrets put-secret netspec figma_client_secret --string-value "..."
```

### 2. 建立兩個 Backend App + Frontend App，並部署（sync → deploy）

現在後端是兩個獨立服務，各自要建一個 Databricks App：

```bash
EMAIL=your_email@asus.com   # 小寫

# text-spec-service
databricks apps create netspec-backend
databricks sync ./backend/text-spec-service /Workspace/Users/$EMAIL/netspec-backend --full
databricks apps deploy netspec-backend --source-code-path /Workspace/Users/$EMAIL/netspec-backend

# figma-service（新的第二個 backend app）
databricks apps create netspec-figma-backend
databricks sync ./backend/figma-service /Workspace/Users/$EMAIL/netspec-figma-backend --full
databricks apps deploy netspec-figma-backend --source-code-path /Workspace/Users/$EMAIL/netspec-figma-backend

# Frontend（app 名稱就叫 netspec）
databricks apps create netspec
databricks sync ./frontend /Workspace/Users/$EMAIL/netspec --full
databricks apps deploy netspec --source-code-path /Workspace/Users/$EMAIL/netspec
```

> `netspec-figma-backend` 建立後，先跑 `databricks apps get netspec-figma-backend` 取得它的網址，
> 填回 `backend/figma-service/app.yaml` 的 `FIGMA_REDIRECT_URI`，重新 deploy 一次才會生效
> （見步驟 5）。

### 3. 授權 service principal（不做的話 secrets / Volume 都讀不到）

**兩個 backend App 各自有自己的 service principal，都要授權一次**：

```bash
for APP in netspec-backend netspec-figma-backend; do
  SP=$(databricks apps get "$APP" | grep service_principal_client_id | grep -oE '[0-9a-f-]{36}')

  # Secret Scope 讀取權（app.yaml 的 resources 只是宣告意圖，仍需顯式授權）
  databricks secrets put-acl netspec "$SP" READ

  # Unity Catalog Volume：三層權限缺一不可（catalog → schema → volume）
  databricks grants update catalog <catalog> \
    --json "{\"changes\":[{\"principal\":\"$SP\",\"add\":[\"USE_CATALOG\"]}]}"
  databricks grants update schema <catalog>.<schema> \
    --json "{\"changes\":[{\"principal\":\"$SP\",\"add\":[\"USE_SCHEMA\"]}]}"
  databricks grants update volume <catalog>.<schema>.netspec_data \
    --json "{\"changes\":[{\"principal\":\"$SP\",\"add\":[\"READ_VOLUME\",\"WRITE_VOLUME\"]}]}"
done
```

（兩個 App 目前共用同一個 `netspec` secret scope — 各自的 `app.yaml` 只 `resources:` 宣告自己
實際要用到的欄位，例如 text-spec-service 不會讀 `FIGMA_CLIENT_ID`，即使 scope 裡有這個 key。）

### 4. 資料持久化（重要架構）

**SQLite 不能直接跑在 Volume 上** —— Volume 底層是 S3 物件儲存 + FUSE，不支援
SQLite 需要的檔案鎖與隨機寫入。因此：

- SQLite 跑在**容器本地磁碟**（快、穩）
- 背景每 30 秒把整顆 db 快照，透過 **Files API** 上傳到 Volume（`DB_PATH` 指定）
- 容器**啟動時**從 Volume 還原 → 重啟資料不丟

**兩個服務各自有自己的 db 檔，互不共用**：
- `backend/text-spec-service/app.yaml` 設定 `DB_PATH=/Volumes/<catalog>/<schema>/netspec_data/netspec_text_spec.db`
- `backend/figma-service/app.yaml` 設定 `DB_PATH=/Volumes/<catalog>/<schema>/netspec_data/netspec_figma.db`

驗證：`databricks fs ls /Volumes/<catalog>/<schema>/netspec_data` 應看到兩個 `.db` 檔。

### 5. 跨 App 設定與 Figma OAuth

- `backend/figma-service/app.yaml`：`FIGMA_REDIRECT_URI`（= figma-service 的 App URL +
  `/api/figma/oauth/callback`，**只存在於 figma-service**，text-spec-service 不需要）、
  `FRONTEND_URL`（= 前端 URL，OAuth 成功後跳回用）
- `frontend/app.yaml`：`TEXT_SPEC_BACKEND_URL`（= text-spec-service App URL）、
  `FIGMA_BACKEND_URL`（= figma-service App URL）、`NEXT_PUBLIC_SKIP_LANDING=true`
  （`BACKEND_URL` 仍可用，作為 `TEXT_SPEC_BACKEND_URL` 的向後相容別名）
- 前端透過 catch-all proxy（`app/api/[...path]/route.ts`）依路徑分流到兩個後端，帶
  `x-forwarded-access-token` 轉發，瀏覽器不直接打後端（跨 App auth 隔離）
- **Figma Developer Portal** 要把 figma-service 的 callback URL 加進 Redirect URIs（需與
  `FIGMA_REDIRECT_URI` 完全一致），否則會 `redirect_uri mismatch`

> 更名限制：App 名稱不可變，要改名只能建新 App + 部署 + 刪舊 App。

---

## License

ASUS Enterprise Network — Internal Use
