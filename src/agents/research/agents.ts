// Research agents built on the Claude Agent SDK (the Claude Code agent runtime).
//
//   lead-orchestrator (skill: lead-research-orchestration)
//     ├─Agent tool─> company-researcher (Sonnet · WebSearch, WebFetch, heidi MCP · skill: hausverwaltung-research)
//     └─Agent tool─> linkedin-finder    (Haiku  · WebSearch, heidi MCP · skill: linkedin-lookup)
//
// The agents can only touch lead data through the in-process "heidi" MCP server,
// which verifies every write. Hooks record every URL the agents see, so claims
// citing pages that were never visited are rejected.
import { query, type AgentDefinition, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { ROOT } from "../../lib/env.ts";
import { models } from "../../lib/llm.ts";
import { heidiServer, rememberUrls } from "./tools.ts";

const SUB_TOOLS = ["mcp__heidi__get_company", "mcp__heidi__record_fact", "mcp__heidi__record_person"];
const HEIDI_TOOLS = [...SUB_TOOLS, "mcp__heidi__finish_company"];

// Three agents, each with its own skill (.claude/skills/<name>/SKILL.md) holding its domain knowledge.
// Prompts stay short: role, tools and limits. The know-how lives in the versioned skill files.
export const agents: Record<string, AgentDefinition> = {
  "lead-orchestrator": {
    description: "Coordinates research on a batch of leads by delegating to the specialist subagents. Main thread only.",
    model: models.agent_orchestrator,
    tools: ["Agent", "ToolSearch", "mcp__heidi__get_company", "mcp__heidi__finish_company"],
    skills: ["lead-research-orchestration"],
    prompt: `You coordinate lead research for Heidi Systems, a metering service for property managers.
Follow the lead-research-orchestration skill. Delegate to company-researcher and linkedin-finder; never research yourself.`,
  },
  "company-researcher": {
    description: "Researches one Berlin property management company: units managed, employees, VDIV membership and decision-makers. Use once per company.",
    model: models.agent_researcher,
    tools: ["WebSearch", "WebFetch", ...SUB_TOOLS],
    skills: ["hausverwaltung-research"],
    maxTurns: 25,
    prompt: `You research one German property management company (Hausverwaltung) for Heidi Systems.
Start with get_company, then fill the gaps following the hausverwaltung-research skill.
Record findings with record_fact / record_person (source URL + short verbatim quote).
If a tool answers REJECTED, do not retry that claim. At most 6 searches. End with a two-line summary.`,
  },
  "linkedin-finder": {
    description: "Finds LinkedIn profiles for named decision-makers of one company. Use after the company is researched.",
    model: models.agent_linkedin,
    tools: ["WebSearch", ...SUB_TOOLS],
    skills: ["linkedin-lookup"],
    maxTurns: 12,
    prompt: `You find LinkedIn profiles for the decision-makers of one company.
Start with get_company, then follow the linkedin-lookup skill. Never construct or guess a URL.`,
  },
};

/** Collect every URL the agents see, from search results and fetched pages (main agent and subagents). */
const trackUrls: HookCallback = async (input: any) => {
  rememberUrls(input.tool_input);
  rememberUrls(input.tool_response);
  return {};
};

export async function runResearch(companies: { id: number; name: string; website: string | null }[],
  onEvent: (line: string) => void = () => {}) {
  const list = companies.map((c) => `- id ${c.id}: ${c.name}${c.website ? ` (${c.website})` : ""}`).join("\n");
  let cost = 0, turns = 0, ok = false;
  for await (const m of query({
    prompt: `Research these companies:\n${list}`,
    options: {
      cwd: ROOT,
      model: models.agent_orchestrator,
      agent: "lead-orchestrator",           // main thread runs as the orchestrator agent
      agents,
      mcpServers: { heidi: heidiServer },
      allowedTools: ["Agent", "ToolSearch", "WebSearch", "WebFetch", ...HEIDI_TOOLS],
      disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit"],
      permissionMode: "dontAsk",
      settingSources: ["project"],          // discovers the skills in .claude/skills
      skills: ["lead-research-orchestration", "hausverwaltung-research", "linkedin-lookup"],
      hooks: { PostToolUse: [{ matcher: "WebSearch|WebFetch", hooks: [trackUrls] }] },
      maxTurns: 20 + companies.length * 6,
    },
  })) {
    if (m.type === "assistant") {
      for (const b of (m as any).message?.content ?? []) {
        if (b.type === "tool_use") {
          const who = (m as any).parent_tool_use_id ? "  ↳" : "•";
          const arg = b.input?.subagent_type ?? b.input?.query ?? b.input?.url ?? b.input?.field ?? b.input?.name ?? "";
          onEvent(`${who} ${b.name}${arg ? ` ${String(arg).slice(0, 80)}` : ""}`);
        }
      }
    }
    if (m.type === "result") {
      cost = (m as any).total_cost_usd ?? 0; turns = (m as any).num_turns ?? 0; ok = (m as any).subtype === "success";
    }
  }
  return { cost, turns, ok };
}
