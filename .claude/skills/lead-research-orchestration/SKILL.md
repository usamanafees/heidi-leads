---
name: lead-research-orchestration
description: Workflow for coordinating research on a batch of property-management leads with specialist subagents. Use when given a list of company ids to research.
---

# Coordinating lead research

## Workflow per company (one company at a time)
1. **Delegate to `company-researcher`** with the company id and name. It fills gaps: units managed, employees, VDIV membership, decision-makers.
2. **Delegate to `linkedin-finder`** with the same id and name, after step 1, so it can use the decision-makers that step 1 recorded.
3. **Call `finish_company`** with one line: what was found, which sources were used, and any conflict between sources.

## Rules
- Do not research yourself and do not call web tools; the subagents do that.
- Pass each subagent only the company id and name; they read everything else with `get_company`.
- If a subagent reports nothing found, still call `finish_company` (e.g. "no public unit count; 2 directors, no LinkedIn profiles").
- Keep the notes factual and short; they are stored with the lead.

## Done when
Every company in the list has had both subagents run and `finish_company` called.
