# SDLC PoC — EP backlog (created in Jira)

`doc/SDCL_telemetry.md` broken down into Jira issues on the [EP board](https://asus-team-cnw.atlassian.net/jira/software/projects/EP/boards/209).

**Jira is the source of truth from here on.** This file records how the breakdown was derived so a reader can go from a success criterion to the tickets that satisfy it without opening 51 issues.

- Range: **EP-161 – EP-211** — 8 epics, 43 stories/tasks, 136 story points

- Unassigned by decision; the owners named in the source doc's Week 1 split are recorded in the ticket descriptions instead.


## Conventions

- **Hierarchy** — Epic -> Story / Task. Sub-tasks only when one Story needs to split across two owners.
- **Summaries** — Imperative verb + object + qualifier. <= 80 chars. No 'and' joining two deliverables.
- **Descriptions** — Context / In scope / Out of scope / Acceptance criteria / Technical notes / References
- **Estimation** — Fibonacci story points. 1 = a few hours, 2 = half a day, 3 = one day, 5 = two to three days, 8 = needs splitting but is not yet splittable.
- **Labels** — `ep-poc` on everything; `sc-1`…`sc-10` trace each ticket to a success criterion; plus system, workstream and `week-N` labels.

**Definition of done**

- Acceptance criteria demonstrated on the real Databricks workspace, not on localhost.
- Verification query or command recorded in the ticket as a comment.
- Any doc under doc/ that the change invalidates is updated in the same PR.

## Success criteria → tickets

| # | Success criterion | Tickets |
|---|---|---|
| 1 | App telemetry capture | EP-161, EP-169, EP-170, EP-171, EP-172, EP-173, EP-174, EP-175, EP-176, EP-201 |
| 2 | App output data | EP-170, EP-162, EP-177, EP-178, EP-179, EP-180 |
| 3 | Third-party ingestion | EP-163, EP-181, EP-182, EP-183, EP-184, EP-185 |
| 4 | Consolidation in one medallion architecture | EP-181, EP-182, EP-183, EP-164, EP-186, EP-187, EP-188, EP-189, EP-192 |
| 5 | Unity Catalog governance and lineage | EP-164, EP-190, EP-191 |
| 6 | Self-serve analytics via Genie | EP-165, EP-193, EP-194, EP-195, EP-203 |
| 7 | Meeting preparation time | EP-165, EP-196 |
| 8 | Engineering productivity dashboard | EP-189, EP-193, EP-166, EP-197, EP-198, EP-199, EP-200, EP-201, EP-203 |
| 9 | Cross-app usage insight | EP-175, EP-179, EP-184, EP-187, EP-166, EP-202 |
| 10 | AI development cost visibility | EP-167, EP-204, EP-205, EP-206, EP-207 |

## Epics


### EP-161 — App telemetry capture for the three EP apps

*week-1 · priority High · 8 children · 25 pts*

None of NetSpec, BugZapper or Polaris currently writes user interactions to a governed table, so nobody can see which steps users abandon, where they hesitate, which features go unused, or how often an answer has to be asked twice. This epic makes a browser click queryable as a typed row.

| Key | Type | Summary | Pts | Prio | Week | Blocked by |
|---|---|---|---|---|---|---|
| EP-169 | Story | Publish the ep.app_event.v1 contract as the shared telemetry schema | 3 | Highest | week-1 | — |
| EP-170 | Story | Create the ep_dev.netspec schema, tables and event views | 2 | High | week-1 | EP-169, EP-208 |
| EP-171 | Story | Enable Databricks Apps telemetry export on all three NetSpec apps | 2 | High | week-1 | EP-170 |
| EP-172 | Story | Relay the human identity from the frontend proxy to the backend services | 3 | High | week-1 | EP-171 |
| EP-173 | Story | Verify a NetSpec browser click lands as a typed row with the correct user | 3 | High | week-1 | EP-171, EP-172 |
| EP-174 | Task | Enable the Delta direct-write fallback sink for telemetry | 2 | Low | week-2 | EP-171 |
| EP-175 | Story | Instrument BugZapper interactions against the shared event contract | 5 | High | week-1 | EP-169 |
| EP-176 | Story | Instrument Polaris interactions against the shared event contract | 5 | Medium | week-3 | EP-169, EP-197 |

### EP-162 — App output data as governed, joinable tables

*week-2 · priority Medium · 4 children · 12 pts*

Telemetry says how an app was used; it does not say what the app produced. NetSpec specification versions and approval state, and BugZapper root causes and suspect commits, currently sit in isolation and cannot be queried alongside anything else.

| Key | Type | Summary | Pts | Prio | Week | Blocked by |
|---|---|---|---|---|---|---|
| EP-177 | Story | Verify NetSpec specification versions land with quality score and approval state | 2 | Medium | week-2 | EP-171 |
| EP-178 | Story | Decide whether derived role views satisfy the approval-state criterion | 3 | High | week-2 | EP-177 |
| EP-179 | Story | Emit BugZapper root causes and suspect commits as app_output rows | 5 | Medium | week-2 | EP-175 |
| EP-180 | Story | Prove output records join to telemetry on session and user in one query | 2 | Medium | week-2 | EP-177, EP-179 |

### EP-163 — Ingest Figma, Jira, GitHub and SquashTM into the lakehouse

*week-1 · priority High · 5 children · 17 pts*

Four third-party systems sit entirely outside the EP apps, and the questions the team actually asks span them. Today reaching them means a manual export, which is a large part of the three person-hours spent before every meeting.

| Key | Type | Summary | Pts | Prio | Week | Blocked by |
|---|---|---|---|---|---|---|
| EP-181 | Story | Ingest Jira issues and sprints via Lakeflow Connect | 3 | High | week-1 | — |
| EP-182 | Story | Ingest GitHub pull requests, reviews and code churn via Lakeflow Connect | 3 | High | week-1 | — |
| EP-183 | Story | Ingest SquashTM test executions and campaigns via its REST API | 5 | High | week-1 | — |
| EP-184 | Story | Ingest Figma files, versions and comments via the Figma API | 3 | Medium | week-2 | — |
| EP-185 | Story | Monitor ingestion freshness against the 24-hour latency requirement | 3 | Medium | week-2 | EP-181, EP-182, EP-183, EP-184 |

### EP-164 — Consolidate all seven sources under one medallion architecture and Unity Catalog

*week-2 · priority High · 7 children · 28 pts*

The PoC's actual argument is that user behaviour, tool output, code, tickets, designs and test results belong in one governed place, because the questions the team asks span all of them. 'Is this feature delayed, and why?' cannot be answered by Jira alone - the answer lives in the join.

| Key | Type | Summary | Pts | Prio | Week | Blocked by |
|---|---|---|---|---|---|---|
| EP-186 | Task | Define the catalog, schema and medallion naming standard | 2 | High | week-2 | — |
| EP-187 | Story | Establish the entity keys that link feature, Jira issue, PR, spec and test case | 8 | Highest | week-2 | EP-181, EP-182, EP-183, EP-186, EP-209 |
| EP-188 | Story | Build the silver layer conforming the seven sources | 5 | High | week-2 | EP-187 |
| EP-189 | Story | Build the gold marts serving the four roles | 5 | High | week-3 | EP-188, EP-193 |
| EP-190 | Story | Apply Unity Catalog access control per audience | 3 | High | week-3 | EP-186 |
| EP-191 | Story | Demonstrate end-to-end lineage from raw app logs to the gold layer | 2 | Medium | week-3 | EP-189 |
| EP-192 | Story | Answer one question with a single query spanning five systems | 3 | High | week-3 | EP-189 |

### EP-165 — Self-serve analytics through Genie for the four roles

*week-4 · priority High · 4 children · 11 pts*

Before every project meeting the PM, Dev Lead and Test Lead each spend roughly an hour assembling information from Jira, GitHub, test reports and RCA output - about three person-hours per sprint per feature team, producing no reusable asset. Genie is how that assembly stops being manual.

| Key | Type | Summary | Pts | Prio | Week | Blocked by |
|---|---|---|---|---|---|---|
| EP-193 | Story | Collect the standing questions from PM, Dev Lead, Test Lead and EP team | 3 | Highest | week-2 | — |
| EP-194 | Story | Configure the Genie space with comments, instructions and example SQL | 3 | High | week-4 | EP-189, EP-193 |
| EP-195 | Story | Run role acceptance on the Genie space with an evaluation set | 3 | High | week-4 | EP-194 |
| EP-196 | Story | Measure meeting preparation time before and after | 2 | High | week-4 | EP-195 |

### EP-166 — Role-based engineering productivity dashboard

*week-3 · priority High · 7 children · 25 pts*

One dashboard reflecting the whole SDLC, with a page per role, is criterion #8. Criterion #9 adds the cross-app view: for one feature, NetSpec specification activity and BugZapper RCA activity on a single timeline.

| Key | Type | Summary | Pts | Prio | Week | Blocked by |
|---|---|---|---|---|---|---|
| EP-197 | Story | Deploy Polaris to Databricks Apps and switch its data source to Databricks tables | 5 | High | week-3 | EP-189 |
| EP-198 | Story | Build the PM dashboard page | 3 | High | week-3 | EP-197, EP-193 |
| EP-199 | Story | Build the Dev Lead dashboard page | 3 | High | week-3 | EP-197, EP-193 |
| EP-200 | Story | Build the Test Lead dashboard page | 3 | High | week-3 | EP-197, EP-193, EP-183 |
| EP-201 | Story | Build the EP Team dashboard page | 3 | High | week-3 | EP-197, EP-193 |
| EP-202 | Story | Show NetSpec and BugZapper activity for one feature on a single timeline | 5 | High | week-4 | EP-175, EP-179, EP-187 |
| EP-203 | Story | Embed the Genie space in the dashboard app | 3 | Medium | week-4 | EP-194, EP-197 |

### EP-167 — AI development cost visibility by SDLC stage

*week-2 · priority Medium · 4 children · 10 pts*

Criterion #10 asks for Claude token usage attributable by SDLC stage with no instrumentation in any app, available from platform system tables because model calls route through the Databricks-hosted Anthropic endpoint. Today the metric exists but comes from app telemetry rather than system tables.

| Key | Type | Summary | Pts | Prio | Week | Blocked by |
|---|---|---|---|---|---|---|
| EP-204 | Story | Route model calls through the Databricks-hosted Anthropic endpoint | 3 | High | week-2 | — |
| EP-205 | Story | Join platform system tables with the SDLC stage dimension | 3 | High | week-3 | EP-204 |
| EP-206 | Task | Route /api/translate through llm_client to close its cost blind spot | 2 | Medium | week-3 | — |
| EP-207 | Task | Attribute Figma legacy endpoint cost to a session or document the gap | 2 | Low | week-3 | — |

### EP-168 — PoC enablement, evaluation and rollout decision

*week-0 · priority Highest · 4 children · 8 pts*

The wrapper around the PoC: the pre-work that has to be done before Week 1 can start, and the Week 5 evaluation that decides whether this becomes production.

| Key | Type | Summary | Pts | Prio | Week | Blocked by |
|---|---|---|---|---|---|---|
| EP-208 | Task | Create the Dev and PROD Databricks workspaces | 2 | Highest | week-0 | — |
| EP-209 | Task | Confirm PoC scope and timeline with the team | 1 | Highest | week-0 | — |
| EP-210 | Story | Record the Week 5 evaluation against all ten success criteria | 3 | High | week-5 | EP-173, EP-180, EP-185, EP-192, EP-196, EP-202, EP-205 |
| EP-211 | Story | Produce the production rollout recommendation | 2 | High | week-5 | EP-210 |

## Critical path

The sequence that everything else waits on:

1. **EP-209** confirm scope → **EP-208** create the workspaces (both pre-work; they gate the rest).
2. **EP-169** freeze the `ep.app_event.v1` contract — the other two apps are cheap to add only if this holds.
3. **EP-193** collect the role questions — decides what the gold marts must contain, so it precedes EP-189.
4. **EP-187** establish the entity keys — if a feature cannot be followed across systems, criteria #4, #6, #8 and #9 all fail.
5. **EP-189** gold marts → **EP-194** Genie space and **EP-197** Polaris deployment.
6. **EP-210** Week 5 evaluation → **EP-211** rollout recommendation.

## Decisions the backlog surfaces

Three tickets exist because the PoC cannot honestly be evaluated until someone decides them:

- **EP-178** — NetSpec has no approve button; `approval_state` is inferred from PM-first behaviour. Does that satisfy criterion #2, or is a real approval action needed?
- **EP-190** — app telemetry is per-person behavioural data. Who may see it per person, and who only in aggregate?
- **EP-204 / EP-205** — criterion #10 asks for cost from *platform system tables*. Today the metric is available but sourced from app telemetry. Routing model calls through the Databricks-hosted endpoint is the change that closes the gap.

---

Machine-readable definition: `doc/jira/EP_backlog.json`.
