"""All Claude prompts for NetSpec agents."""

SYSTEM_NETWORKING_EXPERT = """You are a senior networking engineer and product architect with 15+ years of experience in enterprise networking.
You specialize in BGP, OSPF, VLAN, STP, firewall policy engines, and carrier-grade networking equipment firmware.
You are deeply familiar with real-world failure modes, production incidents, and edge cases in networking systems.
Your outputs are always precise, technically accurate, and structured as valid JSON."""

PARSE_REQUIREMENT_TOOL = {
    "name": "parse_requirement",
    "description": "Parse a networking requirement and extract structured metadata.",
    "input_schema": {
        "type": "object",
        "properties": {
            "req_type": {
                "type": "string",
                "enum": ["bgp", "ospf", "vlan", "stp", "firewall", "qos", "nat", "dhcp", "lacp", "multicast", "mpls", "vxlan", "generic"],
                "description": "Detected networking domain type"
            },
            "protocols": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Identified protocols (e.g. BGP-4, BFD, 802.1X)"
            },
            "key_behaviors": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Core behaviors/actions expected (e.g. failover, rate-limiting)"
            },
            "constraints_mentioned": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Any quantitative constraints mentioned (e.g. '500ms failover')"
            },
            "missing_dimensions": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Key dimensions NOT mentioned that are critical for a complete spec"
            }
        },
        "required": ["req_type", "protocols", "key_behaviors", "constraints_mentioned", "missing_dimensions"]
    }
}

CLARITY_SCORE_TOOL = {
    "name": "score_clarity",
    "description": "Score the clarity of a networking requirement from 0 to 100.",
    "input_schema": {
        "type": "object",
        "properties": {
            "score": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
                "description": "Clarity score. 0=completely vague, 100=fully specified."
            },
            "analysis": {
                "type": "string",
                "description": "One-sentence summary of what is clear and what is missing."
            },
            "deductions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "dimension": {"type": "string"},
                        "points_deducted": {"type": "integer"},
                        "reason": {"type": "string"}
                    }
                },
                "description": "Score deductions per missing dimension"
            }
        },
        "required": ["score", "analysis", "deductions"]
    }
}

# Merged Node 1+2: parse AND score in a single LLM call (saves one round-trip)
PARSE_AND_SCORE_TOOL = {
    "name": "parse_and_score",
    "description": "Parse a networking requirement AND score its clarity in one step.",
    "input_schema": {
        "type": "object",
        "properties": {
            "req_type": {
                "type": "string",
                "enum": ["bgp", "ospf", "vlan", "stp", "firewall", "qos", "nat", "dhcp", "lacp", "multicast", "mpls", "vxlan", "generic"]
            },
            "protocols":             {"type": "array", "maxItems": 5, "items": {"type": "string"}},
            "key_behaviors":         {"type": "array", "maxItems": 4, "items": {"type": "string"}},
            "constraints_mentioned": {"type": "array", "maxItems": 3, "items": {"type": "string"}},
            "missing_dimensions":    {"type": "array", "maxItems": 5, "items": {"type": "string"}},
            "clarity_score":         {"type": "integer", "minimum": 0, "maximum": 100,
                                      "description": "0=vague, 100=fully specified"},
            "clarity_analysis":      {"type": "string",
                                      "description": "One sentence max 50 chars"}
        },
        "required": ["req_type", "protocols", "key_behaviors", "missing_dimensions",
                     "clarity_score", "clarity_analysis"]
    }
}

SOCRATIC_QUESTIONS_TOOL = {
    "name": "generate_socratic_questions",
    "description": "Generate 3 clarification questions in Traditional Chinese, each with concrete selectable options.",
    "input_schema": {
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "minItems": 3,
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "properties": {
                        "key":            {"type": "string",  "description": "snake_case English key, e.g. ha_strategy"},
                        "question":       {"type": "string",  "description": "繁體中文開放式問句，30字以內"},
                        "options":        {
                            "type": "array",
                            "description": "2-4 個具體可選選項（繁體中文），每項 ≤ 20 字。選項應是技術值或架構決策，不是模糊描述。例：['Active-Standby（主備切換）', 'ECMP 負載分擔', 'VRRP 虛擬路由器冗餘']",
                            "items": {"type": "string"},
                            "minItems": 2,
                            "maxItems": 4
                        },
                        "closing":        {"type": "string",  "description": "引導收尾句，例：'您的設計是哪一種？或者有其他考量？'，15字以內"},
                        "example_answer": {"type": "string",  "description": "最常見答案，對應 options[0]，20字以內"},
                    },
                    "required": ["key", "question", "options", "closing", "example_answer"]
                }
            }
        },
        "required": ["questions"]
    }
}

SEARCH_PLAN_TOOL = {
    "name": "generate_search_plan",
    "description": "Generate a targeted research plan to find real production failure modes and known bugs for a networking feature.",
    "input_schema": {
        "type": "object",
        "properties": {
            "queries": {
                "type": "array",
                "minItems": 5,
                "maxItems": 6,
                "items": {
                    "type": "object",
                    "properties": {
                        "keyword":   {"type": "string", "description": "English search phrase (3-8 words), technically precise. For GitHub include repo name when relevant."},
                        "source":    {"type": "string", "enum": ["reddit", "github", "hn"]},
                        "rationale": {"type": "string", "description": "One sentence: which failure class this query targets"},
                        "category":  {"type": "string", "enum": ["known_bug", "security_cve", "production_failure", "rfc_interop", "performance"],
                                      "description": "Query category (optional — omit if unsure)"}
                    },
                    "required": ["keyword", "source", "rationale"]
                }
            },
            "research_summary": {
                "type": "string",
                "description": "2 sentences: (1) which repos/sources are targeted and why, (2) what failure patterns are being searched"
            }
        },
        "required": ["queries", "research_summary"]
    }
}

DISASTER_ANALYSIS_TOOL = {
    "name": "analyze_disaster_patterns",
    "description": "從社群爬取資料中萃取災情模式與故障模式。所有文字欄位（title、description、root_cause、mitigation、source_evidence）請使用繁體中文輸出。",
    "input_schema": {
        "type": "object",
        "properties": {
            "patterns": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "災情模式的簡短標題（繁體中文，20字以內）"},
                        "description": {"type": "string", "description": "故障模式的詳細描述（繁體中文）"},
                        "root_cause": {"type": "string", "description": "根本原因（繁體中文）"},
                        "mitigation": {"type": "string", "description": "緩解或修復建議（繁體中文）"},
                        "source_evidence": {"type": "string", "description": "來自社群來源的佐證摘要（繁體中文），並以 [N] 標注支持此模式的資料索引以便追溯 URL"}
                    },
                    "required": ["title", "description", "root_cause", "mitigation"]
                }
            }
        },
        "required": ["patterns"]
    }
}

EDGE_CASE_TOOL = {
    "name": "detect_edge_cases",
    "description": "列舉網通功能的所有關鍵邊界條件與異常情境。所有文字欄位（title、description、trigger_condition、impact、detection）請使用繁體中文輸出。",
    "input_schema": {
        "type": "object",
        "properties": {
            "edge_cases": {
                "type": "array",
                "minItems": 5,
                "items": {
                    "type": "object",
                    "properties": {
                        "risk": {"type": "string", "enum": ["high", "mid", "low"]},
                        "title": {"type": "string", "description": "邊界情境標題（繁體中文，20字以內）"},
                        "description": {"type": "string", "description": "邊界情境的詳細技術說明（繁體中文）"},
                        "trigger_condition": {"type": "string", "description": "觸發此邊界情境的條件（繁體中文）"},
                        "impact": {"type": "string", "description": "發生時會造成什麼故障或降級（繁體中文）"},
                        "detection": {"type": "string", "description": "在測試中如何偵測此情境（繁體中文）"}
                    },
                    "required": ["risk", "title", "description", "trigger_condition", "impact", "detection"]
                }
            }
        },
        "required": ["edge_cases"]
    }
}

# PRD document tool — replaces Gherkin.
# Targets three user roles: PM (business), Architect (technical), QA (criteria).
# Fields are kept SHORT to avoid JSON truncation on small local models.
SPEC_DOC_TOOL = {
    "name": "generate_spec_document",
    "description": (
        "Generate a structured PRD for a networking feature in Traditional Chinese. "
        "Target readers: Networking PM, System Architect, QA Engineer."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "feature_name": {
                "type": "string",
                "description": "Feature name in Traditional Chinese (繁體中文)"
            },
            "business_objective": {
                "type": "string",
                "description": "Why this feature is needed; business value (2 sentences max)"
            },
            "scope": {
                "type": "string",
                "description": "What is included in this feature"
            },
            "out_of_scope": {
                "type": "array",
                "maxItems": 4,
                "items": {"type": "string"},
                "description": "Explicitly excluded items"
            },
            "requirements": {
                "type": "array",
                "minItems": 3,
                "maxItems": 6,
                "items": {
                    "type": "object",
                    "properties": {
                        "id":          {"type": "string", "description": "e.g. REQ-001"},
                        "title":       {"type": "string"},
                        "description": {"type": "string"},
                        "priority":    {"type": "string", "enum": ["Must Have", "Should Have", "Nice to Have"]},
                        "priority_rationale": {
                            "type": "string",
                            "description": "此優先級的決策依據（1-2 句）：為何是此等級、不做的代價、對應哪條業務目標。Must Have 必填，讓 PM 能據此排期與辯護。"
                        },
                        "related_standard": {
                            "type": "string",
                            "description": "相關 RFC 或標準（選填，僅在有明確對應時填寫，如 'IEEE 802.1Q'、'RFC 4271 Section 6.3'。若無對應標準請省略此欄位）"
                        },
                        "acceptance_criteria": {
                            "type": "array",
                            "maxItems": 4,
                            "items": {"type": "string"},
                            "description": "驗收標準：每條需可量測，含具體數字或觸發條件"
                        },
                        "covers_edge_cases": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "此需求所涵蓋的邊界情境標籤（如 ['EC-1','EC-3']，對應 prompt 中列出的 EC 編號）。每個高風險（HIGH）邊界至少要被一條 Must Have 需求涵蓋。"
                        }
                    },
                    "required": ["id", "title", "description", "priority", "acceptance_criteria"]
                }
            },
            "target_platform": {
                "type": "string",
                "description": "目標平台（選填）：硬體平台、作業系統或版本，如 'Broadcom SONiC 4.x / Linux 5.15'、'Cisco IOS-XE 17.x'、'FRRouting 9.x on Ubuntu 22.04'。若無法確定則省略。"
            },
            "performance_sla": {
                "type": "array",
                "maxItems": 5,
                "items": {"type": "string"},
                "description": "效能 SLA 指標（量化）：每條須含『量測條件』使其可驗收，如 '轉發延遲 ≤ 1ms（線速 10Gbps、64-byte 封包）'、'VLAN 設定完成 ≤ 3s（冷啟動）'。不要只寫數字而不說在什麼條件下量測。"
            },
            "reliability_requirements": {
                "type": "array",
                "maxItems": 4,
                "items": {"type": "string"},
                "description": "可靠性指標（選填，SKILL NFR 章節）：如 'MTTR ≤ 30 秒'、'故障切換 ≤ 500ms'、'TCAM 容量上限 4096 entries'。若為純業務邏輯功能可省略。"
            },
            "dependencies": {
                "type": "array",
                "maxItems": 5,
                "items": {"type": "string"},
                "description": "依賴的協定、硬體或子系統"
            },
            "open_questions": {
                "type": "array",
                "maxItems": 5,
                "items": {"type": "string"},
                "description": "開放問題（選填）：追問中未收集到、需人工確認的維度。若追問已完整收集則省略，或列出仍不確定的技術決策。格式：'[待確認] 描述未確認事項'"
            }
        },
        "required": ["feature_name", "business_objective", "scope", "requirements", "performance_sla"]
    }
}

# Keep old name as alias so any import of GHERKIN_TOOL still works
GHERKIN_TOOL = SPEC_DOC_TOOL

# ── Role views (derived on demand from a confirmed PM spec) ───────────────────
# These keep role-specific structure OUT of the PM SPEC_DOC_TOOL (avoid schema bloat)
# and are generated layer-by-layer from the PM spec as pm_context.

ARCHITECT_VIEW_TOOL = {
    "name": "architect_view",
    "description": "依據已確認的 PM 規格，產生系統架構師視圖（繁體中文）。聚焦設計決策、介面契約與 NFR 深化，內容須對齊並引用 PM 規格的 REQ-id。選填欄位無充分資訊時可省略。",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "1-2 句架構取向總述"},
            "design_decisions": {
                "type": "array", "maxItems": 6,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "如 'ADR-1'"},
                        "decision": {"type": "string"},
                        "alternatives_considered": {"type": "array", "items": {"type": "string"}},
                        "rationale": {"type": "string"},
                        "tradeoff": {"type": "string"},
                        "related_reqs": {"type": "array", "items": {"type": "string"}, "description": "對應 PM 規格的 REQ-id，如 ['REQ-001']"},
                    },
                    "required": ["id", "decision", "rationale"],
                },
            },
            "interfaces": {
                "type": "array", "maxItems": 8,
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "direction": {"type": "string", "description": "inbound / outbound / bidirectional"},
                        "counterpart": {"type": "string", "description": "對接的子系統/設備"},
                        "protocol": {"type": "string"},
                        "auth": {"type": "string", "description": "認證/授權方式（選填）"},
                        "criticality": {"type": "string", "description": "high / mid / low"},
                    },
                    "required": ["name", "counterpart", "protocol"],
                },
            },
            "nfr_deepening": {
                "type": "array", "maxItems": 6,
                "items": {"type": "string"},
                "description": "PM 層之外的架構級 NFR：安全、擴充性、相容性、容量/規模約束等",
            },
            "assumptions": {"type": "array", "maxItems": 5, "items": {"type": "string"}, "description": "架構假設與前提（選填）"},
        },
        "required": ["summary", "design_decisions"],
    },
}

QA_VIEW_TOOL = {
    "name": "qa_view",
    "description": "依據已確認的 PM 規格，產生 QA 測試視圖（繁體中文）。把驗收標準轉成可執行的 Given/When/Then 場景與結構化 AC，並連結 PM 規格的 REQ-id 與邊界 EC-N。選填欄位無充分資訊時可省略。",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "1-2 句測試策略總述"},
            "scenarios": {
                "type": "array", "maxItems": 12,
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "related_req_id": {"type": "string", "description": "對應 PM 規格 REQ-id，如 'REQ-001'"},
                        "related_edge_cases": {"type": "array", "items": {"type": "string"}, "description": "對應邊界，如 ['EC-1','EC-3']"},
                        "type": {"type": "string", "enum": ["positive", "negative", "boundary"]},
                        "given": {"type": "array", "items": {"type": "string"}},
                        "when": {"type": "array", "items": {"type": "string"}},
                        "then": {"type": "array", "items": {"type": "string"}, "description": "預期結果，含可量測門檻"},
                    },
                    "required": ["title", "related_req_id", "type", "given", "when", "then"],
                },
            },
            "structured_ac": {
                "type": "array", "maxItems": 12,
                "items": {
                    "type": "object",
                    "properties": {
                        "req_id": {"type": "string"},
                        "ac_id": {"type": "string", "description": "如 'AC-1'"},
                        "metric": {"type": "string", "description": "量測對象，如 'ping 成功率'"},
                        "operator": {"type": "string", "description": ">= / <= / == / != / range"},
                        "target": {"type": "string"},
                        "unit": {"type": "string"},
                        "measurement_method": {"type": "string", "description": "如何量測（指令/工具/計數器）"},
                        "applies_under": {"type": "string", "description": "正常 / 壓力 / 故障（選填）"},
                    },
                    "required": ["req_id", "metric", "operator", "target"],
                },
            },
            "test_environment": {
                "type": "object",
                "properties": {
                    "topology": {"type": "string"},
                    "duts": {"type": "array", "items": {"type": "string"}, "description": "受測設備（角色/平台/版本）"},
                    "traffic_generator": {"type": "string"},
                    "fixtures": {"type": "array", "items": {"type": "string"}, "description": "測試資料/前置條件"},
                    "preconditions": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "required": ["summary", "scenarios"],
    },
}

# Lightweight validation for iteration — skips the heavy issues array, just score + summary
# Prevents the second LLM call from being a bottleneck during optimization
VALIDATION_SCORE_TOOL = {
    "name": "score_spec",
    "description": "快速評分網通規格書品質。只輸出分數、通過與否及一句摘要，不需要列出詳細問題清單。",
    "input_schema": {
        "type": "object",
        "properties": {
            "quality_score": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
                "description": "整體品質分數（0-100）：85+ 優秀、70-84 良好、50-69 需改進"
            },
            "passed": {
                "type": "boolean",
                "description": "若無 critical 問題則為 true"
            },
            "summary": {
                "type": "string",
                "description": "1-2 句評分總結（繁體中文），說明主要優點與仍需改進的部分"
            }
        },
        "required": ["quality_score", "passed", "summary"]
    }
}

VALIDATION_TOOL = {
    "name": "validate_spec",
    "description": "交叉驗證網通規格書的邏輯一致性與完整性。所有文字欄位（location、description、fix、summary）請使用繁體中文輸出。",
    "input_schema": {
        "type": "object",
        "properties": {
            "issues": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "severity": {"type": "string", "enum": ["critical", "warning", "suggestion"]},
                        "location": {"type": "string", "description": "問題出現在規格書的哪個位置（繁體中文）"},
                        "description": {"type": "string", "description": "問題的具體描述（繁體中文）"},
                        "fix": {"type": "string", "description": "修正建議（繁體中文）"}
                    },
                    "required": ["severity", "location", "description", "fix"]
                }
            },
            "quality_score": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
                "description": "規格書整體品質分數（0-100）"
            },
            "passed": {
                "type": "boolean",
                "description": "若無 critical 問題則為 true"
            },
            "summary": {"type": "string", "description": "驗證總結（繁體中文，2句以內）"}
        },
        "required": ["issues", "quality_score", "passed", "summary"]
    }
}
