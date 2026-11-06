import * as NodeOS from "node:os";

import type {
  AgentProfile,
  AgentProfileId,
  MessageId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ThreadChannel,
  OrchestrationV2TurnItem,
  ProjectId,
  TeamGroup,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const MAX_EXTERNAL_FILE_CHARS = 64_000;

export interface AgentAttribution {
  readonly authorAgentId: AgentProfileId;
  readonly authorAgentName: string;
  readonly authorAgentRole: string;
}

export interface LoadedAgentExternalCustomization {
  readonly externalAgentsMd?: string | undefined;
  readonly loadedSkills?:
    | ReadonlyArray<{
        readonly path: string;
        readonly content: string;
      }>
    | undefined;
}

export function toAgentAttribution(agent: AgentProfile): AgentAttribution {
  return {
    authorAgentId: agent.id,
    authorAgentName: agent.name,
    authorAgentRole: agent.role,
  };
}

export function resolveTeamGroupForChannel(
  channel: OrchestrationV2ThreadChannel | undefined,
  teamGroups: ReadonlyArray<TeamGroup>,
): TeamGroup | null {
  if (channel?.kind !== "group_chat") {
    return null;
  }
  if (channel.groupId !== undefined) {
    return teamGroups.find((group) => group.id === channel.groupId) ?? null;
  }
  return teamGroups.find((group) => group.projectId === channel.projectId) ?? null;
}

function resolveProjectAgents(
  projectId: ProjectId | undefined,
  agentProfiles: ReadonlyArray<AgentProfile>,
): ReadonlyArray<AgentProfile> {
  if (projectId === undefined) {
    return agentProfiles;
  }
  const scoped = agentProfiles.filter(
    (agent) =>
      agent.projectId === projectId ||
      agent.projectId == null ||
      agent.sharedAcrossProjects === true,
  );
  return scoped.length > 0 ? scoped : agentProfiles;
}

export function resolveGroupMemberAgents(input: {
  readonly group: TeamGroup | null;
  readonly threadId?: ThreadId | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly agentProfiles: ReadonlyArray<AgentProfile>;
}): ReadonlyArray<AgentProfile> {
  const { group, threadId, projectId, agentProfiles } = input;
  const byId = new Map(agentProfiles.map((agent) => [agent.id, agent] as const));
  const conversationRoster =
    group !== null && threadId !== undefined ? group.conversationRosters?.[threadId] : undefined;
  if (conversationRoster !== undefined) {
    return conversationRoster.memberAgentIds.flatMap((id) => {
      const found = byId.get(id);
      return found === undefined ? [] : [found];
    });
  }
  if (group !== null && group.memberAgentIds.length > 0) {
    const members = group.memberAgentIds.flatMap((id) => {
      const found = byId.get(id);
      return found === undefined ? [] : [found];
    });
    if (members.length > 0) {
      return members;
    }
  }
  return resolveProjectAgents(group?.projectId ?? projectId, agentProfiles);
}

function resolveConversationOrchestratorAgentId(
  group: TeamGroup | null | undefined,
  threadId?: ThreadId | undefined,
): AgentProfileId | null | undefined {
  if (!group) {
    return undefined;
  }
  if (threadId !== undefined && group.conversationRosters?.[threadId] !== undefined) {
    return group.conversationRosters[threadId]?.orchestratorAgentId;
  }
  return group.orchestratorAgentId;
}

export function isAgentOrchestratorInGroup(
  agent: AgentProfile,
  group?: TeamGroup | null,
  threadId?: ThreadId | undefined,
): boolean {
  const orchestratorId = resolveConversationOrchestratorAgentId(group, threadId);
  if (orchestratorId != null) {
    return agent.id === orchestratorId;
  }
  return agent.isOrchestrator;
}

export function findOrchestratorAgent(
  agentProfiles: ReadonlyArray<AgentProfile>,
  group?: TeamGroup | null,
  threadId?: ThreadId | undefined,
): AgentProfile | null {
  if (agentProfiles.length === 0) {
    return null;
  }
  const orchestratorId = resolveConversationOrchestratorAgentId(group, threadId);
  if (orchestratorId != null) {
    const explicit = agentProfiles.find((profile) => profile.id === orchestratorId);
    if (explicit !== undefined) {
      return explicit;
    }
  }
  return agentProfiles.find((profile) => profile.isOrchestrator) ?? agentProfiles[0] ?? null;
}

export function resolveActiveAgentForTurn(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "channel"> & {
    readonly id?: ThreadId | undefined;
    readonly projectId?: ProjectId | undefined;
  };
  readonly message?: Pick<OrchestrationV2ConversationMessage, "text" | "targetAgentId"> | undefined;
  readonly agentProfiles: ReadonlyArray<AgentProfile>;
  readonly teamGroups?: ReadonlyArray<TeamGroup> | undefined;
}): AgentProfile | undefined {
  const { thread, message, agentProfiles, teamGroups = [] } = input;
  if (thread.channel === undefined || agentProfiles.length === 0) {
    return undefined;
  }
  if (thread.channel.kind === "agent_personal") {
    const agentProfileId = thread.channel.agentProfileId;
    return agentProfiles.find((profile) => profile.id === agentProfileId);
  }
  const group = resolveTeamGroupForChannel(thread.channel, teamGroups);
  const roster = resolveGroupMemberAgents({
    group,
    threadId: thread.id,
    projectId: thread.channel.projectId,
    agentProfiles,
  });
  if (message?.targetAgentId !== undefined) {
    const targeted =
      roster.find((profile) => profile.id === message.targetAgentId) ??
      agentProfiles.find((profile) => profile.id === message.targetAgentId);
    if (targeted !== undefined) {
      return targeted;
    }
  }
  if (message !== undefined) {
    const mentionMatch = roster.find((profile) => {
      const escaped = profile.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `(?:^|\\s)@${escaped}\\b|^\\s*(?:hey\\s+|hi\\s+|hello\\s+)?${escaped}\\b[,:]`,
        "i",
      ).test(message.text);
    });
    if (mentionMatch !== undefined) {
      return mentionMatch;
    }
  }
  return findOrchestratorAgent(roster, group, thread.id) ?? undefined;
}

function resolveCandidateFilePath(
  pathService: Path.Path,
  rawPath: string,
  workspaceRoot?: string | null,
): string {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return pathService.join(NodeOS.homedir(), trimmed.slice(2));
  }
  if (pathService.isAbsolute(trimmed)) {
    return trimmed;
  }
  if (workspaceRoot) {
    return pathService.resolve(workspaceRoot, trimmed);
  }
  return pathService.resolve(trimmed);
}

const readTextFileSafe = (fsService: FileSystem.FileSystem, filePath: string) =>
  fsService.readFileString(filePath, "utf8").pipe(
    Effect.map((content) => {
      const trimmed = content.trim();
      if (!trimmed) return null;
      return trimmed.length <= MAX_EXTERNAL_FILE_CHARS
        ? trimmed
        : `${trimmed.slice(0, MAX_EXTERNAL_FILE_CHARS)}\n...[truncated]`;
    }),
    Effect.orElseSucceed(() => null),
  );

export const loadAgentExternalCustomization = Effect.fnUntraced(function* (input: {
  readonly agent: AgentProfile;
  readonly workspaceRoot?: string | null | undefined;
}) {
  const fsOption = yield* Effect.serviceOption(FileSystem.FileSystem);
  const pathOption = yield* Effect.serviceOption(Path.Path);
  if (Option.isNone(fsOption) || Option.isNone(pathOption)) {
    return {} satisfies LoadedAgentExternalCustomization;
  }
  const fsService = fsOption.value;
  const pathService = pathOption.value;
  const { agent, workspaceRoot } = input;
  const externalAgentsMd =
    agent.agentsMdPath && agent.agentsMdPath.trim().length > 0
      ? yield* readTextFileSafe(
          fsService,
          resolveCandidateFilePath(pathService, agent.agentsMdPath, workspaceRoot),
        )
      : null;

  const skillPaths = agent.enabledSkillPaths ?? [];
  const loadedSkills: Array<{ readonly path: string; readonly content: string }> = [];
  for (const rawSkillPath of skillPaths) {
    const resolved = resolveCandidateFilePath(pathService, rawSkillPath, workspaceRoot);
    let content: string | null = null;
    if (resolved.toLowerCase().endsWith(".md")) {
      content = yield* readTextFileSafe(fsService, resolved);
    } else {
      const nestedSkillMd = yield* readTextFileSafe(
        fsService,
        pathService.join(resolved, "SKILL.md"),
      );
      content = nestedSkillMd ?? (yield* readTextFileSafe(fsService, resolved));
    }
    if (content !== null) {
      loadedSkills.push({ path: rawSkillPath, content });
    }
  }

  return {
    ...(externalAgentsMd === null ? {} : { externalAgentsMd }),
    ...(loadedSkills.length === 0 ? {} : { loadedSkills }),
  } satisfies LoadedAgentExternalCustomization;
});

export function buildAgentTurnPrompt(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "channel"> & {
    readonly id?: ThreadId | undefined;
  };
  readonly activeAgent: AgentProfile;
  readonly agentProfiles: ReadonlyArray<AgentProfile>;
  readonly teamGroups?: ReadonlyArray<TeamGroup> | undefined;
  readonly externalCustomization?: LoadedAgentExternalCustomization | undefined;
  readonly userText: string;
  readonly currentMessageId: MessageId;
  readonly groupChatRecords?: {
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  };
}): string {
  const {
    thread,
    activeAgent,
    agentProfiles,
    teamGroups = [],
    externalCustomization,
    userText,
    currentMessageId,
    groupChatRecords,
  } = input;

  const group = resolveTeamGroupForChannel(thread.channel, teamGroups);
  const roster = resolveGroupMemberAgents({
    group,
    threadId: thread.id,
    projectId: thread.channel?.projectId,
    agentProfiles,
  });
  const activeIsOrchestrator = isAgentOrchestratorInGroup(activeAgent, group, thread.id);

  const rosterLines = roster.map((profile) => {
    const isLeader = isAgentOrchestratorInGroup(profile, group, thread.id);
    return `- ${profile.name} (${profile.role})${isLeader ? " [Orchestrator / Team Lead]" : ""}: ${
      profile.responsibilities.length > 0 ? profile.responsibilities.join(", ") : "General"
    }`;
  });

  const identityBlock = [
    "<agent_identity>",
    `Name: ${activeAgent.name}`,
    `Role: ${activeAgent.role}`,
    `Model: ${activeAgent.modelSelection.instanceId}/${activeAgent.modelSelection.model}`,
    ...(group !== null ? [`Group: ${group.name}`] : []),
    `Team Role: ${activeIsOrchestrator ? "Orchestrator / Team Lead" : "Specialist Teammate"}`,
    `Responsibilities: ${
      activeAgent.responsibilities.length > 0 ? activeAgent.responsibilities.join(", ") : "General"
    }`,
    ...(activeAgent.systemInstructions.trim().length > 0
      ? ["System Instructions:", activeAgent.systemInstructions.trim()]
      : []),
    "</agent_identity>",
  ].join("\n");

  const agentsMdSections: string[] = [];
  if (externalCustomization?.externalAgentsMd) {
    agentsMdSections.push(
      `# Linked AGENTS.md (${activeAgent.agentsMdPath ?? "external"})\n${externalCustomization.externalAgentsMd}`,
    );
  }
  if (activeAgent.agentsMdContent && activeAgent.agentsMdContent.trim().length > 0) {
    agentsMdSections.push(activeAgent.agentsMdContent.trim());
  }
  const agentsMdBlock =
    agentsMdSections.length > 0
      ? ["<agent_agents_md>", ...agentsMdSections, "</agent_agents_md>"].join("\n\n")
      : "";

  const skillSections: string[] = [];
  for (const loaded of externalCustomization?.loadedSkills ?? []) {
    skillSections.push(`<skill path="${loaded.path}">\n${loaded.content}\n</skill>`);
  }
  for (const skill of activeAgent.customSkills ?? []) {
    if (skill.content.trim().length === 0 && skill.description.trim().length === 0) continue;
    skillSections.push(
      [
        `<skill name="${skill.name}" description="${skill.description}">`,
        skill.content.trim(),
        "</skill>",
      ].join("\n"),
    );
  }
  const skillsBlock =
    skillSections.length > 0
      ? ["<agent_skills>", ...skillSections, "</agent_skills>"].join("\n\n")
      : "";

  const rosterBlock = ["<team_roster>", ...rosterLines, "</team_roster>"].join("\n");

  if (thread.channel?.kind === "group_chat") {
    const transcriptEntries: Array<{
      readonly timestampMs: number;
      readonly speaker: string;
      readonly text: string;
    }> = [];

    if (groupChatRecords !== undefined) {
      const assistantTurnItemRunIds = new Set(
        groupChatRecords.turnItems
          .filter((item) => item.type === "assistant_message" && item.text.trim().length > 0)
          .map((item) => item.runId),
      );
      for (const msg of groupChatRecords.messages) {
        if (msg.id === currentMessageId || msg.text.trim().length === 0) continue;
        if (msg.role === "user") {
          const speaker =
            msg.authorAgentName !== undefined
              ? `${msg.authorAgentName} (${msg.authorAgentRole ?? "Agent"})`
              : "Human";
          transcriptEntries.push({
            timestampMs: DateTime.toEpochMillis(msg.createdAt),
            speaker,
            text: msg.text.trim(),
          });
        } else if (
          msg.role === "assistant" &&
          (msg.runId === null || !assistantTurnItemRunIds.has(msg.runId))
        ) {
          const speaker =
            msg.authorAgentName !== undefined
              ? `${msg.authorAgentName} (${msg.authorAgentRole ?? "Agent"})`
              : "Assistant";
          transcriptEntries.push({
            timestampMs: DateTime.toEpochMillis(msg.createdAt),
            speaker,
            text: msg.text.trim(),
          });
        }
      }
      for (const item of groupChatRecords.turnItems) {
        if (item.type !== "assistant_message" || item.text.trim().length === 0) continue;
        const speaker =
          item.authorAgentName !== undefined
            ? `${item.authorAgentName} (${item.authorAgentRole ?? "Agent"})`
            : "Assistant";
        transcriptEntries.push({
          timestampMs: DateTime.toEpochMillis(item.startedAt ?? item.updatedAt),
          speaker,
          text: item.text.trim(),
        });
      }
    }

    transcriptEntries.sort((a, b) => a.timestampMs - b.timestampMs);
    const recentTranscript = transcriptEntries
      .slice(-24)
      .map((entry) => `[${entry.speaker}]:\n${entry.text}`)
      .join("\n\n");

    const groupLabel = group ? `Group Chat "${group.name}"` : "the project's shared Group Chat";
    const groupRulesBlock = [
      "<group_chat_channel_rules>",
      `You are speaking as ${activeAgent.name} (${activeAgent.role}) in ${groupLabel}.`,
      "- Keep Group Chat clean, collaborative, and focused on high-level discussion, proposals, trade-offs, decisions, task assignments, and concise review/QA/completion reports.",
      "- Speak in first person as your character and address teammates by name.",
      "- Do NOT execute noisy implementation commands or dump raw code diffs in Group Chat.",
      "- To ask another teammate for their opinion, review, or perspective in Group Chat, call the `t3_team_ask_agent` MCP tool with `agentNameOrId` and `prompt`. After you finish your message, they will automatically respond in Group Chat.",
      "- Discussion vs. Delegation Gate:",
      "  1. When the Human asks an open brainstorming, product, or architecture question, consult the relevant teammates in Group Chat (`t3_team_ask_agent`), synthesize the discussion, and ask the Human for approval before delegating implementation work.",
      "  2. When the Human explicitly asks to implement, build, fix, review, or run QA (or approves a discussed plan), delegate the work to the appropriate specialist agent's Personal Agent Chat by calling `t3_team_delegate_task` (`agentNameOrId`, `title`, `task`).",
      "  3. All detailed implementation, file edits, command execution, and testing happen in that agent's Personal Agent Chat, and a concise report will automatically return to Group Chat when their run finishes.",
      "- Agent Roster Management: When instructed by the Human, you can inspect (`t3_team_list_agents`), create (`t3_team_create_agent`), update (`t3_team_update_agent`: including name, role, model/provider via `providerInstanceId`/`model`/`modelOptions`, `AGENTS.md`, `SKILLS`, and instructions), or delete (`t3_team_delete_agent`) team agents immediately.",
      "</group_chat_channel_rules>",
    ].join("\n");

    const transcriptBlock =
      recentTranscript.length > 0
        ? [
            "<group_chat_recent_transcript>",
            recentTranscript,
            "</group_chat_recent_transcript>",
          ].join("\n")
        : "";

    return [
      identityBlock,
      ...(agentsMdBlock.length > 0 ? [agentsMdBlock] : []),
      ...(skillsBlock.length > 0 ? [skillsBlock] : []),
      rosterBlock,
      groupRulesBlock,
      ...(transcriptBlock.length > 0 ? [transcriptBlock] : []),
      userText,
    ].join("\n\n");
  }

  const personalRulesBlock = [
    "<personal_chat_channel_rules>",
    `You are in your dedicated Personal Agent Chat (Me ↔ ${activeAgent.name}) as ${activeAgent.name} (${activeAgent.role}).`,
    "- This channel is for detailed technical execution, file inspection and edits, command/test runs, debugging, and direct 1:1 interaction with the Human.",
    "- If you hit a blocker that requires team discussion or orchestrator coordination in Group Chat, call `t3_team_report_blocker`.",
    "- When you complete a delegated task, keep all long reports and detailed outputs here in your Personal Chat, and end your final response with a <group_chat_summary>...</group_chat_summary> block containing a short 1-3 sentence conversational update for Group Chat.",
    "- Agent Roster Management: When instructed by the Human, you can inspect (`t3_team_list_agents`), create (`t3_team_create_agent`), update (`t3_team_update_agent`: including name, role, model/provider via `providerInstanceId`/`model`/`modelOptions`, `AGENTS.md`, `SKILLS`, and instructions), or delete (`t3_team_delete_agent`) team agents immediately.",
    "</personal_chat_channel_rules>",
  ].join("\n");

  return [
    identityBlock,
    ...(agentsMdBlock.length > 0 ? [agentsMdBlock] : []),
    ...(skillsBlock.length > 0 ? [skillsBlock] : []),
    rosterBlock,
    personalRulesBlock,
    userText,
  ].join("\n\n");
}
