import { assert, describe, it } from "@effect/vitest";
import {
  AgentProfileId,
  type AgentProfile,
  MessageId,
  type OrchestrationV2ConversationMessage,
  ProjectId,
  ProviderInstanceId,
  type TeamGroup,
  TeamGroupId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { buildAgentTurnPrompt, resolveActiveAgentForTurn } from "./TeamAgentContext.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const nowIso = "2026-11-04T00:00:00.000Z";
const nowUtc = DateTime.makeUnsafe(nowIso);

const vex: AgentProfile = {
  id: AgentProfileId.make("agent-vex"),
  name: "Vex",
  role: "CEO",
  isOrchestrator: true,
  responsibilities: ["Lead discussions", "Delegate tasks"],
  systemInstructions: "You are Vex, the CEO and team lead.",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.3-codex",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: nowIso,
  updatedAt: nowIso,
};

const dex: AgentProfile = {
  id: AgentProfileId.make("agent-dex"),
  name: "Dex",
  role: "Developer",
  isOrchestrator: false,
  responsibilities: ["Technical architecture", "Implementation"],
  systemInstructions: "You are Dex, the lead Developer.",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.3-codex",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: nowIso,
  updatedAt: nowIso,
};

const cex: AgentProfile = {
  id: AgentProfileId.make("agent-cex"),
  name: "Cex",
  role: "Client",
  isOrchestrator: false,
  responsibilities: ["Business requirements", "User perspective"],
  systemInstructions: "You are Cex, representing the Client.",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.3-codex",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: nowIso,
  updatedAt: nowIso,
};

const teamProfiles: ReadonlyArray<AgentProfile> = [vex, dex, cex];

describe("TeamAgentContext", () => {
  it("resolves active agent for Group Chat and Personal Agent Chat turns", () => {
    const personalResolved = resolveActiveAgentForTurn({
      thread: {
        channel: {
          kind: "agent_personal",
          projectId,
          agentProfileId: dex.id,
        },
      },
      agentProfiles: teamProfiles,
      message: {
        text: "Hey Vex, check this",
      },
    });
    assert.strictEqual(personalResolved?.id, dex.id);

    const groupFallbackOrchestrator = resolveActiveAgentForTurn({
      thread: {
        channel: {
          kind: "group_chat",
          projectId,
        },
      },
      agentProfiles: teamProfiles,
      message: {
        text: "What features should we build next?",
      },
    });
    assert.strictEqual(groupFallbackOrchestrator?.id, vex.id);

    const groupMentionedAgent = resolveActiveAgentForTurn({
      thread: {
        channel: {
          kind: "group_chat",
          projectId,
        },
      },
      agentProfiles: teamProfiles,
      message: {
        text: "Hey Cex, would this be useful for clients?",
      },
    });
    assert.strictEqual(groupMentionedAgent?.id, cex.id);

    const groupExplicitTarget = resolveActiveAgentForTurn({
      thread: {
        channel: {
          kind: "group_chat",
          projectId,
        },
      },
      agentProfiles: teamProfiles,
      message: {
        text: "Please review this architecture.",
        targetAgentId: dex.id,
      },
    });
    assert.strictEqual(groupExplicitTarget?.id, dex.id);
  });

  it("builds channel-specific prompts with identity, roster, rules, and multi-speaker transcript", () => {
    const messages: ReadonlyArray<OrchestrationV2ConversationMessage> = [
      {
        id: MessageId.make("msg-1"),
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "Hey Vex, what features should we add?",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: nowUtc,
        updatedAt: nowUtc,
      },
      {
        id: MessageId.make("msg-2"),
        threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text: "I suggest student performance reports. What do you think, Cex?",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        authorAgentId: vex.id,
        authorAgentName: vex.name,
        authorAgentRole: vex.role,
        createdAt: nowUtc,
        updatedAt: nowUtc,
      },
    ];

    const groupPrompt = buildAgentTurnPrompt({
      thread: {
        channel: {
          kind: "group_chat",
          projectId,
        },
      },
      activeAgent: cex,
      agentProfiles: teamProfiles,
      userText: "Would detailed student performance reports be useful from the client perspective?",
      currentMessageId: MessageId.make("msg-3"),
      groupChatRecords: {
        messages,
        turnItems: [],
      },
    });

    assert.include(groupPrompt, "<agent_identity>");
    assert.include(groupPrompt, "Name: Cex");
    assert.include(groupPrompt, "Role: Client");
    assert.include(groupPrompt, "<team_roster>");
    assert.include(groupPrompt, "Vex (CEO) [Orchestrator / Team Lead]");
    assert.include(groupPrompt, "<group_chat_channel_rules>");
    assert.include(groupPrompt, "t3_team_create_agent");
    assert.include(groupPrompt, "t3_team_update_agent");
    assert.include(groupPrompt, "t3_team_delete_agent");
    assert.include(groupPrompt, "<group_chat_recent_transcript>");
    assert.include(groupPrompt, "[Vex (CEO)]:\nI suggest student performance reports.");

    const personalPrompt = buildAgentTurnPrompt({
      thread: {
        channel: {
          kind: "agent_personal",
          projectId,
          agentProfileId: dex.id,
        },
      },
      activeAgent: dex,
      agentProfiles: teamProfiles,
      userText: "Implement the report service.",
      currentMessageId: MessageId.make("msg-4"),
    });

    assert.include(personalPrompt, "<personal_chat_channel_rules>");
    assert.include(
      personalPrompt,
      "You are in your dedicated Personal Agent Chat (Me ↔ Dex) as Dex (Developer).",
    );

    const groupId = TeamGroupId.make("group-eng");
    const engGroup: TeamGroup = {
      id: groupId,
      projectId,
      name: "Core Engineering",
      description: "Backend and architecture group",
      memberAgentIds: [dex.id],
      orchestratorAgentId: dex.id,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const customizedDex: AgentProfile = {
      ...dex,
      agentsMdContent: "# Dex AGENTS.md\nAlways write pure Effect services.",
      customSkills: [
        {
          id: "skill-1",
          name: "effect-review",
          description: "Audit Effect service layers",
          content: "Verify all service methods use Effect.fn.",
        },
      ],
    };

    const groupResolvedLead = resolveActiveAgentForTurn({
      thread: {
        channel: {
          kind: "group_chat",
          projectId,
          groupId,
        },
      },
      agentProfiles: [vex, customizedDex, cex],
      teamGroups: [engGroup],
      message: {
        text: "Design the database schema.",
      },
    });
    assert.strictEqual(groupResolvedLead?.id, customizedDex.id);

    const customizedGroupPrompt = buildAgentTurnPrompt({
      thread: {
        channel: {
          kind: "group_chat",
          projectId,
          groupId,
        },
      },
      activeAgent: customizedDex,
      agentProfiles: [vex, customizedDex, cex],
      teamGroups: [engGroup],
      externalCustomization: {
        externalAgentsMd: "# External AGENTS.md\nFollow workspace conventions.",
        loadedSkills: [
          {
            path: ".agents/skills/db-migrations/SKILL.md",
            content: "# DB Migrations Skill",
          },
        ],
      },
      userText: "Design the database schema.",
      currentMessageId: MessageId.make("msg-5"),
    });

    assert.include(customizedGroupPrompt, "Group: Core Engineering");
    assert.include(customizedGroupPrompt, "<agent_agents_md>");
    assert.include(customizedGroupPrompt, "# Dex AGENTS.md");
    assert.include(customizedGroupPrompt, "# External AGENTS.md");
    assert.include(customizedGroupPrompt, "<agent_skills>");
    assert.include(
      customizedGroupPrompt,
      '<skill name="effect-review" description="Audit Effect service layers">',
    );
    assert.include(customizedGroupPrompt, '<skill path=".agents/skills/db-migrations/SKILL.md">');
  });
});
