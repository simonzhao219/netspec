# **ASUS EP SDLC PoC — Consolidated Engineering Productivity Analytics**

## **Overview**

The ASUS Engineering Productivity (EP) team builds and operates internal tools across the software development lifecycle. Three of them are its own applications — NetSpec, BugZapper, and Polaris — running alongside four third-party systems: Figma, Jira, GitHub, and SquashTM. NetSpec and BugZapper already run as Databricks Apps, and Polaris is slated to follow. Together, these tools generate a great deal of information about how software actually gets built — but today that information is scattered, and almost none of it is used.

### **Tools and systems in scope**

Seven systems feed the PoC. Each EP-built app contributes two kinds of data — how it is used (app telemetry) and what it produces (its output records):  
 

| Tool / System | Type | On Databricks | What it contributes |
| :---- | :---- | :---- | :---- |
| NetSpec | EP app | Deployed | Spec-generation usage (telemetry) plus specification versions and approval history |
| BugZapper | EP app | Deployed | RCA usage (follow-up questions, re-asks) plus root causes and suspect commits |
| Polaris | EP app | Planned | Productivity-dashboard usage — how the BU actually consumes the metrics |
| Figma | Third party | — | Design files, versions and comments behind each specification |
| Jira | Third party | — | Requirements, planned versus actual dates, sprints |
| GitHub | Third party | — | Pull requests, review times, code churn |
| SquashTM | Third party | — | Manual and campaign test execution records |

 

### **The problem: the data is scattered**

• App telemetry is not captured yet. None of the three apps' user interactions flow into governed tables, so no one can see which steps users abandon, where they hesitate, which features go unused, or how often an answer has to be asked twice.  
• Each app's output sits in isolation. NetSpec's specification history and BugZapper's RCA analyses describe what the platform produced, but they are not queryable together or alongside anything else.  
• Internal and external data are not consolidated. Figma, Jira, GitHub, and SquashTM sit outside the apps entirely, and the questions the EP team's users actually ask span several of these systems at once.  
• There is no self-serve analytics. The data that does exist is not consistently used to inform decisions, and weekly meetings are not reliably data-driven.

### **The baseline today**

Before every project meeting, the PM, Dev Lead and Test Lead each spend roughly one hour manually assembling information from Jira, GitHub, test reports and RCA output. That is about 3 person-hours per sprint, per feature team — and it produces no reusable asset, so the next sprint starts from scratch.

### **Scope of this PoC**

This PoC consolidates all seven systems into one Databricks lakehouse, under a medallion architecture and a single Unity Catalog governance model. On top of the consolidated data, Genie answers questions in natural language and a role-based AI/BI dashboard serves the PM, Dev Lead, Test Lead and the EP team.  
The argument is not "an AI tool." It is that user behaviour, tool output, code, tickets, designs and test results belong in one governed place — because the questions the EP team's users actually ask span all of them. "Is this feature delayed, and why?" cannot be answered by Jira alone; the answer lives in the join.  
 

## **Success Criteria**

NetSpec and BugZapper are already deployed as Databricks Apps, and Polaris is planned to follow; therefore, managed hosting and credential pass-through come for free rather than being PoC goals. App telemetry is not yet being captured on any of them. These criteria are all about getting data from the three EP apps and the four third-party systems — Figma, Jira, GitHub, and SquashTM — into one governed place and in front of the four roles.  
 

| \# | Success Criteria | Target |
| :---- | :---- | :---- |
| 1 | App telemetry capture — user interactions from NetSpec, BugZapper and Polaris land in a Unity Catalog Delta table, with the acting user identified automatically from the platform-injected headers | A click in the browser is queryable as a typed row carrying the correct user email, with no instrumentation beyond one track() call per interaction and no authentication code in the app |
| 2 | App output data: what each app produced, not just how it was used — NetSpec specification versions and approval state, BugZapper RCA analyses and root causes | Both queryable as governed tables and joinable to the telemetry on session and user |
| 3 | Third-party ingestion: Figma, Jira, GitHub and SquashTM ingested into the lakehouse via Lakeflow Connect & API | All four landing on a schedule with no manual export step |
| 4 | Consolidation: all sources land in one medallion architecture in a single catalog | A single query answers a question that spans app telemetry, Jira, GitHub, test executions and RCA |
| 5 | Governance: all tables governed by Unity Catalog with access control and end-to-end lineage | Lineage traceable from raw app logs through to the gold layer; access controlled per audience |
| 6 | Self-serve analytics via Genie: PM, Dev Lead, Test Lead and the EP team each get correct answers to their own questions in natural language, without writing SQL | Each of the four role questions below returns an answer judged correct by the asking role |
| 7 | Meeting preparation time: replace the manual cross-system assembly that precedes each project meeting | From 3 person-hours per sprint (3 roles × 1 hour) to under 15 minutes per role, with the underlying data reusable by every other role and retained for trend analysis |
| 8 | Engineering productivity dashboard: one dashboard reflecting the whole SDLC, with a page per role | Four pages live (PM, Dev Lead, Test Lead, EP Team); each role confirms their page answers their standing questions |
| 9 | Cross-app usage insight: see how the EP apps are used together across one feature's lifecycle | For a given feature, show the NetSpec specification activity and the BugZapper RCA activity on one timeline |
| 10 | AI development cost visibility: Claude token usage attributable by SDLC stage with no instrumentation in any app | Token usage and cost by SDLC stage available from platform system tables, because model calls route through the Databricks-hosted Anthropic endpoint |

## **Timeline**

 

| Week | Task Start Date | Databricks SA — Enablement & Sharing | ASUS EP Team Tasks | Status |
| :---- | :---- | :---- | :---- | :---- |
| Pre-work | Aug 11, 2026 | Confirm PoC Scope Send over PoC doc and timeline | Align on timeline and PoC scope Create Dev and PROD workspace | In Progress |
| Week 1 — Data Connection   | Aug 17, 2026 | Send doc to team \- done Check App deployment \- on-going | Jira, Github \-\> Kane Squash ™ \-\> Delbert NetSpec app telemetry \-\> Angelina RAC app telemetry \-\> Winnie   For detailed technical guide, please see **Data Ingestion** session at the bottom | In Progress |
| Week 2 — Data Processing | Aug 24, 2026 | Demonstrate Data processing flow in Databricks; | Write data processing logic in Databricks | Not Started |
| Week 3 — Deploy the Dashboard App to Databricks App , change data source to Databricks Table, Embed Genie | Aug 31, 2026 | Demonstrate the cross-system joins that answer each role's questions; demonstrate AI/BI dashboard authoring and embedding | Build the gold layer; build the four-page dashboard with each role reviewing their own page | Not Started |
| Week 4 — Ready for Demo | Sep 7, 2026 | Demonstrate Genie space configuration: table and column comments, instructions, example SQL, and how to correct a wrong answer; demonstrate granting access to more users | Configure the Genie space; have PM, Dev Lead and Test Lead each ask their own questions and confirm the answers; open to a wider pilot group | Not Started |
| Week 5 — Evaluation | Sep 14, 2026 |   | Review results against the success criteria; if met, plan production rollout |   Not Started |

———

## **Architecture**

### **Current architecture**

Users reach a GUI and CI automation, both calling a service hosted on a shared on-premise VM.

The service writes unstructured data and log data (RCA logs, specification history and output).

Jira and GitHub sit outside, unconnected. Some data reaches a lakehouse; user behaviour on the

front end is not collected at all.

![][image1]

Stated volumes and requirements:

 

| Dimension | Value |
| :---- | :---- |
| Users | 80–100 |
| Sessions per user | 2–3 times per day |
| Concurrency | 2 |
| GitHub | \~20 PR merges per day |
| Jira | \~100 new tickets per sprint (2 weeks) |
| Meetings | 10 per week; 1 hour of preparation each; \~2 hours per day average |
| End-to-end latency | Under 24 hours |
| Data refresh | At least once per day |

### **Proposed architecture**

**![][image2]**

## **Data Ingestion**

Jira Connector: [Jira connector | Databricks on AWS](https://docs.databricks.com/aws/en/ingestion/lakeflow-connect/jira)  
Github Connector: [GitHub connector | Databricks on AWS](https://docs.databricks.com/aws/en/ingestion/lakeflow-connect/github-overview)  
SquashTM API: [Access documentation on APIs \- Squash TM Documentation](https://tm-en.doc.squashtest.com/v7/install-guide/install-plugins/apis.html)  
 

### **App Telemetry Capturing:**

The detailed architecture is below:  
        	  
Browser UI  
  → POST /api/events with a semantic JSON event  
  → FastAPI validates and enriches the event  
  → Python logging writes JSON to stdout  
  → Databricks Apps captures stdout/stderr  
  → Optional App telemetry persists logs to Unity Catalog

#### **Step 1: Frontend — Capture interactions with track()**

A lightweight track() function is the single telemetry surface. Every user action (page views, button clicks, edits, approvals) calls it with an event name and properties.

```python
// track.js — fire-and-forget telemetry client  
   
function sessionId() {  
  let id \= sessionStorage.getItem("session\_id");  
  if (\!id) {  
	id \= \`sess-Date.now().toString(36)-{Math.random().toString(36).slice(2, 8)}\`;  
	sessionStorage.setItem("session\_id", id);  
  }  
  return id;  
}  
   
export async function track(eventName, properties \= {}) {  
  const event \= {  
	event\_name: eventName,  
	event\_time: new Date().toISOString(),  
	page: window.location.pathname,  
	session\_id: sessionId(),  
	properties,  
  };  
   
  try {  
	await fetch("/api/events", {  
  	method: "POST",  
  	headers: { "Content-Type": "application/json" },  
  	credentials: "same-origin",  
  	body: JSON.stringify(event),  
  	keepalive: true,   // survives page unload  
	});  
  } catch {  
	// Telemetry failure must never disrupt the UI.  
  }  
}

Usage in the React component is simple — just call track() at every interaction point:

// Examples from App.jsx  
track("page\_view", { view: "landing" });  
track("frame\_selected", { frame\_id: frame.frame\_id, feature\_key: frame.feature\_key, via: "list" });  
track("generate\_spec\_clicked", { frame\_id: selected.frame\_id });  
track("spec\_edited", { spec\_id: spec.spec\_id, section: heading, chars: edited\[heading\].length });  
track("feedback\_submitted", { spec\_id: spec.spec\_id, rating: "up" });  
track("spec\_approved", { spec\_id: spec.spec\_id, feature\_key: spec.feature\_key });

A session\_end event fires when the user leaves or switches tabs, enabling dwell-time and abandonment analysis:

window.addEventListener("visibilitychange", () \=\> {  
  if (document.visibilityState \=== "hidden" && \!ended) {  
	ended \= true;  
	track("session\_end", { reason: "hidden" });  
  }  
});  
```
---

#### **Step 2: Backend API — Receive events and enrich with identity**

The FastAPI backend accepts the event, merges it with the user's identity (injected by the Databricks Apps platform via x-forwarded-\* headers), and writes a single JSON line to stdout.

```python
# server/telemetry.py  
   
import json, logging, sys  
from fastapi import Request  
   
logger \= logging.getLogger("interaction\_events")  
logger.setLevel(logging.INFO)  
logger.addHandler(logging.StreamHandler(sys.stdout))  
   
def identity\_from(request: Request) \-\> dict:  
	"""User identity is injected by the platform — no auth code needed."""  
	return {  
    	"user\_email": request.headers.get("x-forwarded-email"),  
    	"user\_id": request.headers.get("x-forwarded-user"),  
    	"request\_id": request.headers.get("x-request-id"),  
	}  
   
def emit(record: dict) \-\> None:  
	"""Write one compact JSON record to stdout."""  
	logger.info(json.dumps(record, separators=(",", ":"), default=str))  
\# server/main.py — the /api/events endpoint  
   
class Event(BaseModel):  
	event\_name: str  
	event\_time: str  
	page: str | None \= None  
	session\_id: str | None \= None  
	properties: dict \= {}  
   
@app.post("/api/events")  
async def receive\_event(event: Event, request: Request):  
	emit({  
    	"event\_type": "ui\_interaction",  
    	"event\_name": event.event\_name,  
    	"event\_time": event.event\_time,  
    	"page": event.page,  
    	"session\_id": event.session\_id,  
    	\*\*identity\_from(request),   \# user\_email, user\_id, request\_id  
    	"properties": event.properties,  
	})  
	return {"accepted": True}  
 ```

#### **Step 3: Stdout → Delta Table (automatic, zero-config)**

The Databricks Apps runtime provides an automated export of all stdout and stderr streams directly into a Unity Catalog Delta table (otel\_logs) through OpenTelemetry. This transform every JSON line into a queryable record without requiring any custom export logic, IAM configuration, or separate token management.  
   
Reference:  
○      [Logging and Monitoring for Databricks Apps](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/monitor)  
○      [Configure telemetry for Databricks Apps](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/observability)  
○      [Access HTTP headers passed to Databricks apps](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/http-headers)  
○      [Configure authorization in a Databricks app](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth)   