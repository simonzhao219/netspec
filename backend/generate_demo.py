"""
NetSpec Demo 資料生成腳本

自動執行 2 個高品質 Demo 範例：
  1. VLAN 管理功能  → 展示完整追問 + 社群情報
  2. BGP 路由備援   → 展示 RFC 引用 + 技術深度

執行方式：
  python3 generate_demo.py

每個 Demo 約 2~5 分鐘（Azure API 比 Ollama 快很多）
完成後可在左側欄歷史記錄載入展示。
"""

import asyncio
import json
import time
import sys
import httpx

BASE = "http://localhost:8000/api"

# ── 兩個黃金 Demo 需求 ────────────────────────────────────────────────────────

DEMOS = [
    {
        "name": "VLAN 管理功能",
        "requirement": (
            "需要在企業核心交換器上實作完整的 VLAN 管理功能，"
            "支援 VLAN 的新增、編輯與刪除（ID 範圍 1-4094），"
            "支援 trunk 與 access port 模式切換，"
            "並需考慮與現有 STP (802.1D/802.1w) 配置的相容性，"
            "設備為 Broadcom SONiC 4.x。"
        ),
        # Pre-defined Socratic answers — skip the questioning loop
        "skip_socratic": True,
    },
    {
        "name": "BGP 路由備援",
        "requirement": (
            "設計 BGP 雙線路由備援機制，當主線路發生故障時需在 500ms 內完成切換，"
            "支援 AS-PATH 過濾與 route-map 策略，需避免路由抖動（flap dampening），"
            "符合 RFC 4271 標準，運行於 FRRouting 9.x on Ubuntu 22.04。"
        ),
        "skip_socratic": True,
    },
]


async def run_demo(client: httpx.AsyncClient, demo: dict) -> bool:
    name = demo["name"]
    req  = demo["requirement"]
    print(f"\n{'='*55}")
    print(f"🚀 開始生成：{name}")
    print(f"{'='*55}")

    # 1. Create session
    r = await client.post(f"{BASE}/sessions")
    sid = r.json()["session_id"]
    print(f"   Session: {sid[:8]}...")

    # 2. Start pipeline
    r = await client.post(f"{BASE}/sessions/{sid}/start",
                          json={"requirement": req}, timeout=30)
    if r.status_code != 200:
        print(f"   ❌ Start failed: {r.status_code} {r.text[:200]}")
        return False
    print("   ✅ Pipeline 已啟動")

    # 3. Monitor SSE stream
    interrupt_count = 0
    async with client.stream("GET", f"{BASE}/sessions/{sid}/stream", timeout=600) as stream:
        buffer = ""
        async for chunk in stream.aiter_text():
            buffer += chunk
            while "\n\n" in buffer:
                event_block, buffer = buffer.split("\n\n", 1)
                for line in event_block.splitlines():
                    if line.startswith("data:"):
                        try:
                            event = json.loads(line[5:].strip())
                        except Exception:
                            continue

                        etype = event.get("type", "")

                        if etype == "step_start":
                            step  = event.get("step", "?")
                            title = event.get("title", "")
                            agent = event.get("agent", "")
                            print(f"   ▶ Step {step}  {title}  [{agent}]")

                        elif etype == "step_complete":
                            msg = event.get("log_message", "")[:60]
                            print(f"   ✓ {msg}")

                        elif etype == "interrupt":
                            itype = event.get("interrupt_type", "")
                            interrupt_count += 1

                            if itype == "socratic":
                                if demo.get("skip_socratic"):
                                    print(f"   ⏭ Socratic 第 {interrupt_count} 輪 → 自動跳過")
                                    await asyncio.sleep(0.5)
                                    rr = await client.post(
                                        f"{BASE}/sessions/{sid}/resume",
                                        json={"answers": {"__skip__": True}},
                                        timeout=30,
                                    )
                                    if rr.status_code != 200:
                                        print(f"   ❌ Resume failed: {rr.text[:100]}")

                            elif itype == "plan_confirm":
                                plan = event.get("data", {}).get("plan", [])
                                print(f"   📋 搜尋計畫（{len(plan)} 組關鍵字）→ 自動確認")
                                for q in plan[:3]:
                                    print(f"      [{q.get('source','?').upper()}] {q.get('keyword','')}")
                                await asyncio.sleep(0.5)
                                rr = await client.post(
                                    f"{BASE}/sessions/{sid}/resume",
                                    json={"confirmed": True},
                                    timeout=30,
                                )
                                if rr.status_code != 200:
                                    print(f"   ❌ Confirm failed: {rr.text[:100]}")

                        elif etype == "complete":
                            result = event.get("result", {})
                            score  = result.get("validation_score", 0)
                            fname  = result.get("spec_sections", {}).get("feature_name", name)
                            print(f"\n   🎉 完成！功能名稱：{fname}  品質分數：{score}/100")
                            return True

                        elif etype == "error":
                            print(f"   ❌ Error: {event.get('message','')[:100]}")
                            return False

                        elif etype == "__done__":
                            return False

                        elif etype == "heartbeat":
                            sys.stdout.write(".")
                            sys.stdout.flush()

    return False


async def main():
    print("NetSpec Demo 資料生成器")
    print("使用 Azure API（Claude Opus / GPT-5.4 / Kimi-K2.5）")
    print()

    async with httpx.AsyncClient(base_url="") as client:
        success = 0
        for i, demo in enumerate(DEMOS, 1):
            print(f"\n[{i}/{len(DEMOS)}] {demo['name']}")
            ok = await run_demo(client, demo)
            if ok:
                success += 1
            print(f"\n   {'✅ 成功' if ok else '❌ 失敗'}")
            if i < len(DEMOS):
                print("\n   ⏳ 等待 3 秒後繼續下一個...")
                await asyncio.sleep(3)

    print(f"\n{'='*55}")
    print(f"完成！成功 {success}/{len(DEMOS)} 筆")
    print("請到 http://localhost:3000 的左側欄「歷史記錄」載入展示")
    print("="*55)


if __name__ == "__main__":
    asyncio.run(main())
