---
name: netspec-figma-story
description: Netspec Figma Story pipeline 的 prompt 品質規範。包含追問題庫、功能粒度標準、各角色輸出品質門檻。載入後注入到 gen_questions / gen_feature_list / story_node 與 generate-one 的 prompt 中。採 PM 優先生成：PM 先行，FE/BE/QA 於 PM 編輯確認後按需生成並注入編輯後的 PM 版本（pm_context）作為對齊依據。企業網通產品背景（AP / Switch / Gateway / Controller）。
---

# Netspec Figma Story — Prompt 品質規範

---

## 一、追問題庫（gen_questions）

LLM 每輪從以下維度挑選 2-3 個**尚未釐清**的問題，不重複已問過的維度。

### 維度 1：業務目標與使用者
- 這個功能的主要使用者是誰？（網管人員 / 一般員工 / 系統管理員）
- 使用者完成這個操作的核心目的是什麼？
- 這個功能會影響哪些下游流程？（例如：新增 AP 後需要自動綁定 Controller？）

### 維度 2：設備與網路情境
- 這個操作針對哪種設備？（AP / Switch / Gateway / Controller / 多種）
- 設備數量規模為何？（單台 / 批次 / 大量部署）
- 操作期間設備是否需要在線？離線時如何處理？

### 維度 3：錯誤與例外狀態
- 操作失敗時（例如設備離線、config 衝突、逾時），系統應如何回應？
- 是否需要失敗回滾（rollback）？回滾的範圍為何？
- 批次操作中部分失敗時，是全部取消還是繼續其餘項目？

### 維度 4：權限與安全
- 這個操作有角色權限限制嗎？（例如：只有 Admin 可以刪除設備）
- 是否需要操作前確認（二次確認 / 輸入密碼）？
- 操作紀錄是否需要 audit log？

### 維度 5：效能與並發
- 是否可能有多人同時操作同一台設備或同一份 config？
- 大量設備的批次操作，有沒有時間限制或進度回報需求？
- 操作結果是即時生效還是排程執行？

### 維度 6：邊界條件
- 欄位的最大/最小值限制？（例如：VLAN ID 範圍 1-4094）
- 是否有相依性？（例如：刪除 AP 前需先解除綁定）
- 同名/重複資料的處理規則？

---

## 二、功能粒度標準（gen_feature_list）

### 命名規則
- 格式：**動詞 + 受詞**
- 動詞選擇：新增、編輯、刪除、查看、搜尋、匯出、啟用、停用、綁定、解除
- 範例：
  - ✅ 新增 AP 設備
  - ✅ 編輯 Switch Port 設定
  - ✅ 批次刪除離線設備
  - ❌ AP 管理（太寬）
  - ❌ 點擊新增按鈕（太細）

### 粒度判斷標準
一個功能應符合以下條件：

**可獨立測試**
- 可以在不依賴其他功能的情況下驗收
- 有明確的輸入、操作、輸出

**完整操作流程**
- 從使用者觸發到系統回應為一個完整循環
- 例如：「新增 AP」= 填表單 → 送出 → 成功/失敗回應

**不可拆分條件**
- 如果拆開後，其中一個部分無法獨立存在，就不應拆分
- 例如：「新增 AP 基本資訊」和「新增 AP 進階設定」若共用同一個表單送出，就應合併

**應拆分條件**
- 兩個操作有不同的觸發入口
- 兩個操作有不同的權限要求
- 兩個操作的失敗處理邏輯完全不同

---

## 三、各角色輸出品質門檻（story_node）

> **生成順序為 PM 優先（PM-first）。** PM 版本（User Story + AC）一定先生成；使用者討論、逐段編輯並存檔後，才依需要生成下游角色（FE / BE / QA）。
> 生成下游角色時，prompt 會注入**編輯後的 PM 版本**（見第四節 `pm_context`）作為權威依據——下游角色必須對齊該 PM 規格，不得與其矛盾。

### PM — User Story + Given/When/Then AC

**必須包含：**
- User Story 格式：`作為 [具體角色]，我可以 [具體行為]，以便 [可量化目的]`
- AC 每條必須是 Given/When/Then 格式
- AC 數值要具體，不能模糊：
  - ✅ 操作在 3 秒內完成
  - ✅ 批次操作上限為 100 台
  - ❌ 操作應快速完成
  - ❌ 支援多台設備

**必須涵蓋：**
- 正常流程（Happy Path）
- 至少一條錯誤/例外 AC
- 如有權限限制，必須有對應 AC

**禁止：**
- AC 只描述 UI 行為而不描述業務結果
- 模糊時限（「盡快」「即時」）

---

### QA — 測試場景

**必須包含以下場景類型：**

1. **正常流程**：標準操作路徑，預期成功

2. **網通 edge case（必填）**：
   - 設備離線時執行操作
   - Config 衝突（例如兩人同時修改同一台設備）
   - 網路不穩定時的操作（逾時、重試）
   - 批次操作中部分設備失敗
   - 設備回應慢（超過閾值）

3. **邊界條件**：
   - 欄位最大值 / 最小值 / 空值
   - 特殊字元、超長字串
   - 重複資料（同名設備）

4. **權限驗證**（如有）：
   - 無權限角色執行操作
   - Token 過期時操作

**對齊 PM 規格（必填）：**
- 測試場景必須覆蓋注入的 PM 版本中**每一條 AC**（Given/When/Then）
- 不得測試 PM 版本未定義的行為，也不得與 AC 矛盾

**輸出格式規定：**
```
| 情境 | 操作步驟 | 預期結果 |
每行必須有明確的預期結果，不能寫「應正常運作」
```

---

### FE — 前端建議 task

**必須包含：**

1. **元件建立**
   - 列出每個需要的 component，標注 props / variants
   - 對應 Figma node 名稱

2. **狀態處理（必填）**
   - Loading 狀態：UI 如何呈現，是否 disable 互動
   - Error 狀態：錯誤訊息格式、位置、消除方式
   - Empty 狀態：無資料時的 UI
   - 每個 Figma variant 對應一個狀態的 task

3. **API 串接**
   - 每個 API call 對應一個 task
   - 明確標注 method + endpoint
   - 標注需要處理的 HTTP status code

4. **對齊 PM 規格（必填）**
   - 以注入的 PM User Story + AC 為準；每條 task 應可追溯到對應的使用者行為／AC
   - UI 狀態與互動行為不得與 PM 的 AC 矛盾

5. **禁止遺漏：**
   - ❌ 只寫「建立 Button component」而沒有列狀態
   - ❌ 只寫「串接 API」而沒有指定 endpoint 和 error handling

---

### BE — 後端建議 task

**必須包含：**

1. **Endpoint 定義**
   - 每個 endpoint 一條 task
   - 格式：`METHOD /path` + request schema + response schema

2. **業務邏輯**
   - 驗證規則（欄位格式、範圍、相依性）
   - 衝突處理（並發操作、重複資料）
   - 網通相關：設備狀態檢查、config 版本控制

3. **Error handling（必填）**
   - 每個 endpoint 必須定義至少 3 種 error code
   - 格式：`HTTP 狀態碼 + 業務錯誤碼 + 說明`
   - 例如：`422 DEVICE_OFFLINE 設備離線，無法套用 config`

4. **對齊 PM 規格（必填）**
   - 以注入的 PM User Story + AC 為準；endpoint 與業務邏輯必須支撐 PM 定義的行為與驗收標準
   - 錯誤碼應涵蓋 PM 例外 AC 所描述的失敗情境

5. **禁止遺漏：**
   - ❌ 沒有定義 rollback 邏輯（當有批次操作時）
   - ❌ 沒有考慮並發保護（同一設備同時被兩人修改）

---

## 四、注入方式

```python
import pathlib

SKILL_PATH = pathlib.Path(__file__).parent / "skills/netspec-figma-story/SKILL.md"
SKILL_CONTENT = SKILL_PATH.read_text(encoding="utf-8")

def get_question_dimensions() -> str:
    """萃取追問題庫區塊"""
    lines = SKILL_CONTENT.split("\n")
    start = next(i for i, l in enumerate(lines) if "追問題庫" in l)
    end = next(i for i, l in enumerate(lines) if "功能粒度標準" in l)
    return "\n".join(lines[start:end]).strip()

def get_feature_standards() -> str:
    """萃取功能粒度標準區塊"""
    lines = SKILL_CONTENT.split("\n")
    start = next(i for i, l in enumerate(lines) if "功能粒度標準" in l)
    end = next(i for i, l in enumerate(lines) if "各角色輸出品質門檻" in l)
    return "\n".join(lines[start:end]).strip()

def get_role_standard(role: str) -> str:
    """萃取特定角色的品質門檻"""
    marker = {"PM": "PM —", "QA": "QA —", "FE": "FE —", "BE": "BE —"}[role]
    lines = SKILL_CONTENT.split("\n")
    start = next(i for i, l in enumerate(lines) if marker in l)
    # 找下一個 ### 或 ## 作為結尾（與 backend/figma_story_graph.py 的 _role_standard 一致）
    end = next(
        (i for i, l in enumerate(lines)
         if i > start and (l.startswith("### ") or l.startswith("## "))),
        len(lines)
    )
    return "\n".join(lines[start:end]).strip()
```

在 prompt builder 裡注入：

```python
def build_question_prompt(figma_texts, history, round_num):
    dimensions = get_question_dimensions()
    return f"""你是資深 PM，分析企業網通產品的 Figma 設計稿。

{dimensions}

設計稿文字內容：
{figma_texts}

已問過的問題（請勿重複維度）：
{format_history(history)}

目前第 {round_num + 1} 輪（最多 3 輪）。
從尚未釐清的維度中挑選 2-3 個問題。
只輸出 JSON：{{"questions": [{{"key": "q1", "question": "..."}}]}}
"""

def build_story_prompt(feature, role, figma_texts, figma_nodes,
                       history, supplement, pm_context=""):
    role_standard = get_role_standard(role)
    # PM / QA 用人類可讀文字；FE / BE 用元件/節點結構（JSON）
    figma_content = figma_texts if role in ("PM", "QA") \
                    else json.dumps(figma_nodes[:30], ensure_ascii=False)
    # 下游角色（FE/BE/QA）注入編輯後的 PM 版本作為權威依據
    pm_section = ""
    if role != "PM" and pm_context.strip():
        pm_section = (
            "## PM 版本（User Story + 驗收標準，請以此為準對齊你的任務）\n"
            f"{pm_context.strip()}\n\n"
        )
    return f"""你是資深{role}，根據以下資訊為企業網通產品功能產生高品質輸出。

## 品質要求
{role_standard}

## 功能資訊
功能名稱：{feature['name']}
功能說明：{feature['description']}

{pm_section}## 設計稿內容
{figma_content}

## 問答歷史
{format_history(history)}

## 使用者補充
{supplement or "（無）"}
"""
```

> 對應實作：`backend/figma_story_graph.py` 的 `build_story_prompt()` / `generate_one_story()`，
> 以及 `story_node`（pipeline 內 PM 生成）與 `/api/figma/stories/generate-one`（下游角色按需生成）。

---

## 五、生成流程與模型（現況）

### PM 優先、下游按需
- LangGraph pipeline（`cache_check → parse_frames → gen_questions → wait_answers → gen_feature_list → wait_features → dispatch_stories → story_node → save_cache`）目前只生成 **PM**（`roles=["PM"]`）。
- FE / BE / QA 由前端在 **PM 存檔後**呼叫 `POST /api/figma/stories/generate-one` 逐一生成，並帶入該功能編輯後的 PM 故事作為 `pm_context`。
- 前端目前以 `SHOW_DOWNSTREAM_ROLES = false`（`FigmaStoryPanel.tsx`）**隱藏下游角色 UI**，最小交付為 PM-only；後端端點與邏輯保留，旗標改 `true` 即可開放。

### 模型路由（`.env` per-step）
- **PM**：`LLM_PRD`（Opus，品質優先）。
- **FE / BE / QA**：`LLM_ANALYZE`（gpt-5.4，較快）——Opus 在大型 `figma_nodes` prompt 上易逾時，下游任務清單用較快模型即可。
- LLM client 逾時 180s，並對逾時自動重試（`call_tool`）。

### 版本與歷史（不影響 prompt 內容，但屬同一子系統）
- 故事存為版本：`figma_story_sessions`（父，id = `cache_key = sha256(file_key + sorted(frame_ids))`）→ `figma_story_versions`（版本快照，含 `features_json` / `stories_json`）。
- 進版 = `POST /api/figma/history/{id}/save-version`；不進版（原地編輯）= `PUT .../versions/{n}`。
- 歷史清單依工作模式（文字／figma）分流顯示；frame 選取畫面會標記「已生成」並在整組相同時提供「開啟歷史 / 重新生成（`force_regenerate` 跳過快取）」。
