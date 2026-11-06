import {
  type AgentProfile,
  AgentProfileId,
  CommandId,
  IsoDateTime,
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TeamTaskRef,
  type OrchestratorMcpTeamAgentSummary,
  type OrchestratorMcpTeamAskAgentResult,
  type OrchestratorMcpTeamCreateAgentInput,
  type OrchestratorMcpTeamCreateAgentResult,
  type OrchestratorMcpTeamDelegateTaskResult,
  type OrchestratorMcpTeamDeleteAgentInput,
  type OrchestratorMcpTeamDeleteAgentResult,
  type OrchestratorMcpTeamListAgentsResult,
  type OrchestratorMcpTeamReportBlockerResult,
  type OrchestratorMcpTeamUpdateAgentInput,
  type OrchestratorMcpTeamUpdateAgentResult,
  type ProjectId,
  ProviderInstanceId,
  type RunId,
  type ServerSettings as ServerSettingsModel,
  type TeamGroup,
  type TeamGroupId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  findOrchestratorAgent,
  isAgentOrchestratorInGroup,
  resolveActiveAgentForTurn,
  resolveGroupMemberAgents,
  resolveTeamGroupForChannel,
} from "./TeamAgentContext.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_CONSECUTIVE_AGENT_TURNS = 8;

export class GroupChatCoordinatorError extends Schema.TaggedError<GroupChatCoordinatorError>()(
  "GroupChatCoordinatorError",
  {
    code: Schema.Literals(["agent_not_found", "thread_not_found", "orchestration_error"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

interface QueuedSpeakerHandoff {
  readonly fromAgent: AgentProfile | null;
  readonly targetAgent: AgentProfile;
  readonly question: string;
}

interface DelegatedPersonalRunState {
  readonly taskId: NodeId;
  readonly groupChatThreadId: ThreadId;
  readonly groupId?: TeamGroupId | undefined;
  readonly groupName?: string | undefined;
  readonly projectId: ProjectId;
  readonly personalThreadId: ThreadId;
  readonly personalRunId: RunId;
  readonly agentProfile: AgentProfile;
  readonly delegatorAgent: AgentProfile | null;
  readonly title: string;
}

export interface GroupChatCoordinatorServiceShape {
  readonly ensureGroupChatThread: (
    projectId: ProjectId,
    fallbackSourceThreadId?: ThreadId,
    groupId?: TeamGroupId,
  ) => Effect.Effect<ThreadId, GroupChatCoordinatorError>;
  readonly ensurePersonalAgentThread: (
    projectId: ProjectId,
    agentProfile: AgentProfile,
  ) => Effect.Effect<ThreadId, GroupChatCoordinatorError>;
  readonly listTeamAgents: (
    projectId: ProjectId,
    callerThreadId?: ThreadId,
  ) => Effect.Effect<OrchestratorMcpTeamListAgentsResult, GroupChatCoordinatorError>;
  readonly createTeamAgent: (input: {
    readonly callerThreadId: ThreadId;
    readonly request: OrchestratorMcpTeamCreateAgentInput;
  }) => Effect.Effect<OrchestratorMcpTeamCreateAgentResult, GroupChatCoordinatorError>;
  readonly updateTeamAgent: (input: {
    readonly callerThreadId: ThreadId;
    readonly request: OrchestratorMcpTeamUpdateAgentInput;
  }) => Effect.Effect<OrchestratorMcpTeamUpdateAgentResult, GroupChatCoordinatorError>;
  readonly deleteTeamAgent: (input: {
    readonly callerThreadId: ThreadId;
    readonly request: OrchestratorMcpTeamDeleteAgentInput;
  }) => Effect.Effect<OrchestratorMcpTeamDeleteAgentResult, GroupChatCoordinatorError>;
  readonly askTeamAgent: (input: {
    readonly callerThreadId: ThreadId;
    readonly targetAgent: string;
    readonly question: string;
  }) => Effect.Effect<OrchestratorMcpTeamAskAgentResult, GroupChatCoordinatorError>;
  readonly delegateTeamTask: (input: {
    readonly callerThreadId: ThreadId;
    readonly targetAgent: string;
    readonly title: string;
    readonly task: string;
    readonly expectedDeliverables?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<OrchestratorMcpTeamDelegateTaskResult, GroupChatCoordinatorError>;
  readonly reportTeamBlocker: (input: {
    readonly callerThreadId: ThreadId;
    readonly summary: string;
    readonly details?: string | undefined;
    readonly targetAgent?: string | undefined;
  }) => Effect.Effect<OrchestratorMcpTeamReportBlockerResult, GroupChatCoordinatorError>;
}

export class GroupChatCoordinatorService extends Context.Service<
  GroupChatCoordinatorService,
  GroupChatCoordinatorServiceShape
>()("t3/orchestration-v2/GroupChatCoordinatorService") {}

function findAgentProfileByQuery(
  agentProfiles: ReadonlyArray<AgentProfile>,
  query: string,
): AgentProfile | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  return (
    agentProfiles.find((agent) => agent.id.toLowerCase() === normalized) ??
    agentProfiles.find((agent) => agent.name.trim().toLowerCase() === normalized) ??
    agentProfiles.find((agent) => agent.role.trim().toLowerCase() === normalized) ??
    agentProfiles.find(
      (agent) =>
        `${agent.name.trim().toLowerCase()} (${agent.role.trim().toLowerCase()})` === normalized,
    ) ??
    null
  );
}

function summarizePersonalRunMessages(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  runId: RunId,
  fallbackTitle: string,
): string {
  const assistantMessages = messages.filter(
    (msg) => msg.role === "assistant" && msg.runId === runId && msg.text.trim().length > 0,
  );
  const latest = assistantMessages.at(-1) ?? messages.filter((m) => m.role === "assistant").at(-1);
  if (!latest) {
    return `Completed ${fallbackTitle}.`;
  }
  const trimmed = latest.text.trim();
  const summaryTagMatch = trimmed.match(/<group_chat_summary>([\s\S]*?)<\/group_chat_summary>/i);
  const rawCandidate = summaryTagMatch?.[1]?.trim() ?? trimmed;
  const proseLines = rawCandidate
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("#") &&
        !/^[-*_]{3,}$/.test(line) &&
        !/^(?:\d+\.|[-*•])\s+/.test(line),
    );
  const shortProse = proseLines.slice(0, 2).join(" ").trim();
  const baseText =
    shortProse.length > 0
      ? shortProse
      : rawCandidate
          .replace(/^#+\s+/gm, "")
          .replace(/\s+/g, " ")
          .trim();
  if (!baseText) {
    return `Completed ${fallbackTitle}.`;
  }
  if (baseText.length <= 360) {
    return baseText;
  }
  return `${baseText.slice(0, 357).trimEnd()}...`;
}

const isGroupChatCoordinatorError = Schema.is(GroupChatCoordinatorError);

function toCoordinatorError(cause: unknown): GroupChatCoordinatorError {
  if (isGroupChatCoordinatorError(cause)) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new GroupChatCoordinatorError({
    code: "orchestration_error",
    message,
    cause,
  });
}

const nextCommandId = (tag: string) =>
  Effect.map(randomUuidV4, (uuid) => CommandId.make(`command:team:${tag}:${uuid}`));
const nextThreadId = Effect.map(randomUuidV4, (uuid) => ThreadId.make(`thread:team:${uuid}`));
const nextMessageId = Effect.map(randomUuidV4, (uuid) => MessageId.make(`message:team:${uuid}`));
const nextTaskId = (prefix: string) =>
  Effect.map(randomUuidV4, (uuid) => NodeId.make(`${prefix}:${uuid}`));

export const layer: Layer.Layer<
  GroupChatCoordinatorService,
  never,
  | ProjectionStore.ProjectionStoreV2
  | Orchestrator.OrchestratorV2
  | ThreadManagementService.ThreadManagementService
  | ThreadLaunchService.ThreadLaunchService
  | ServerSettings.ServerSettingsService
  | Scope.Scope
> = Layer.effect(
  GroupChatCoordinatorService,
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const serverSettings = yield* ServerSettings.ServerSettingsService;

    const speakerQueues = new Map<ThreadId, Array<QueuedSpeakerHandoff>>();
    const needsOrchestratorReturn = new Set<ThreadId>();
    const lastDispatchedAgentByGroupThread = new Map<ThreadId, AgentProfile>();
    const consecutiveAgentTurns = new Map<ThreadId, number>();
    const activeDelegatedRuns = new Map<RunId, DelegatedPersonalRunState>();
    const lastGroupByPersonalThread = new Map<
      ThreadId,
      {
        readonly groupChatThreadId: ThreadId;
        readonly groupId?: TeamGroupId | undefined;
        readonly groupName?: string | undefined;
      }
    >();

    const ensureGroupChatThread = Effect.fn("GroupChatCoordinatorService.ensureGroupChatThread")(
      function* (projectId: ProjectId, fallbackSourceThreadId?: ThreadId, groupId?: TeamGroupId) {
        const snapshot = yield* projectionStore.getShellSnapshot({
          location: "active",
          projectId,
        });
        const existing = snapshot.threads.find(
          (shell) =>
            shell.deletedAt === null &&
            shell.archivedAt === null &&
            shell.channel?.kind === "group_chat" &&
            shell.projectId === projectId &&
            (groupId === undefined || shell.channel.groupId === groupId),
        );
        if (existing) {
          return existing.id;
        }

        const settings = yield* serverSettings.getSettings;
        const group: TeamGroup | null =
          groupId !== undefined
            ? (settings.teamGroups.find((candidate) => candidate.id === groupId) ?? null)
            : (settings.teamGroups.find((candidate) => candidate.projectId === projectId) ?? null);
        const roster = resolveGroupMemberAgents({
          group,
          projectId,
          agentProfiles: settings.agentProfiles,
        });
        const orchestratorAgent = findOrchestratorAgent(roster, group);
        const fallbackThread =
          fallbackSourceThreadId !== undefined
            ? yield* projectionStore
                .getThreadShell(fallbackSourceThreadId)
                .pipe(Effect.orElseSucceed(() => null))
            : null;

        const modelSelection =
          orchestratorAgent?.modelSelection ??
          fallbackThread?.modelSelection ??
          roster[0]?.modelSelection ??
          settings.agentProfiles[0]?.modelSelection;
        if (!modelSelection) {
          return yield* new GroupChatCoordinatorError({
            code: "orchestration_error",
            message:
              "Cannot create Group Chat thread: no agent profiles or default model selection configured.",
          });
        }

        const threadId = yield* nextThreadId;
        const commandId = yield* nextCommandId("create-group-chat");
        const launched = yield* threadLaunch.launch({
          commandId,
          threadId,
          projectId,
          title: group?.name ?? "Group Chat",
          modelSelection,
          runtimeMode: orchestratorAgent?.runtimeMode ?? "auto",
          interactionMode: orchestratorAgent?.interactionMode ?? "default",
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "server",
          channel: {
            kind: "group_chat",
            projectId,
            ...(group === null ? {} : { groupId: group.id }),
          },
        });

        return launched.threadId;
      },
      Effect.mapError(toCoordinatorError),
    );

    const ensurePersonalAgentThread = Effect.fn(
      "GroupChatCoordinatorService.ensurePersonalAgentThread",
    )(function* (projectId: ProjectId, agentProfile: AgentProfile) {
      const snapshot = yield* projectionStore.getShellSnapshot({
        location: "active",
        projectId,
      });
      const existing = snapshot.threads.find(
        (shell) =>
          shell.deletedAt === null &&
          shell.archivedAt === null &&
          shell.channel?.kind === "agent_personal" &&
          shell.projectId === projectId &&
          shell.channel.agentProfileId === agentProfile.id,
      );
      if (existing) {
        return existing.id;
      }

      const threadId = yield* nextThreadId;
      const commandId = yield* nextCommandId("create-personal-chat");
      const launched = yield* threadLaunch.launch({
        commandId,
        threadId,
        projectId,
        title: `${agentProfile.name} (${agentProfile.role})`,
        modelSelection: agentProfile.modelSelection,
        runtimeMode: agentProfile.runtimeMode,
        interactionMode: agentProfile.interactionMode,
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "server",
        channel: {
          kind: "agent_personal",
          projectId,
          agentProfileId: agentProfile.id,
        },
      });

      return launched.threadId;
    }, Effect.mapError(toCoordinatorError));

    const toAgentSummary = (
      agent: AgentProfile,
      group: TeamGroup | null,
      personalThreadId?: ThreadId | null,
      conversationThreadId?: ThreadId,
    ): OrchestratorMcpTeamAgentSummary => ({
      agentProfileId: agent.id,
      name: agent.name,
      role: agent.role,
      isOrchestrator: isAgentOrchestratorInGroup(agent, group, conversationThreadId),
      providerInstanceId: agent.modelSelection.instanceId,
      model: agent.modelSelection.model,
      ...(agent.modelSelection.options !== undefined && agent.modelSelection.options.length > 0
        ? { modelOptions: [...agent.modelSelection.options] }
        : {}),
      runtimeMode: agent.runtimeMode,
      interactionMode: agent.interactionMode,
      responsibilities: [...agent.responsibilities],
      ...(agent.systemInstructions.length > 0
        ? { systemInstructions: agent.systemInstructions }
        : {}),
      ...(agent.agentsMdContent ? { agentsMdContent: agent.agentsMdContent } : {}),
      ...(agent.agentsMdPath ? { agentsMdPath: agent.agentsMdPath } : {}),
      ...(agent.enabledSkillPaths && agent.enabledSkillPaths.length > 0
        ? { enabledSkillPaths: [...agent.enabledSkillPaths] }
        : {}),
      ...(agent.customSkills && agent.customSkills.length > 0
        ? { customSkills: [...agent.customSkills] }
        : {}),
      ...(personalThreadId !== undefined ? { personalThreadId } : {}),
    });

    const listTeamAgents = Effect.fn("GroupChatCoordinatorService.listTeamAgents")(function* (
      projectId: ProjectId,
      callerThreadId?: ThreadId,
    ) {
      const settings = yield* serverSettings.getSettings;
      const callerShell =
        callerThreadId !== undefined
          ? yield* projectionStore
              .getThreadShell(callerThreadId)
              .pipe(Effect.orElseSucceed(() => null))
          : null;
      const snapshot = yield* projectionStore
        .getShellSnapshot({
          location: "active",
          projectId,
        })
        .pipe(Effect.orElseSucceed(() => ({ threads: [] as const })));
      const group = resolveTeamGroupForChannel(callerShell?.channel, settings.teamGroups);
      const roster = resolveGroupMemberAgents({
        group,
        threadId: callerThreadId,
        projectId,
        agentProfiles: settings.agentProfiles,
      });
      const agents: Array<OrchestratorMcpTeamAgentSummary> = roster.map((agent) => {
        const personalThread = snapshot.threads.find(
          (shell) =>
            shell.deletedAt === null &&
            shell.archivedAt === null &&
            shell.channel?.kind === "agent_personal" &&
            shell.projectId === projectId &&
            shell.channel.agentProfileId === agent.id,
        );
        return toAgentSummary(agent, group, personalThread?.id ?? null, callerThreadId);
      });
      return { agents } satisfies OrchestratorMcpTeamListAgentsResult;
    }, Effect.mapError(toCoordinatorError));

    const createTeamAgent = Effect.fn("GroupChatCoordinatorService.createTeamAgent")(
      function* (input: {
        readonly callerThreadId: ThreadId;
        readonly request: OrchestratorMcpTeamCreateAgentInput;
      }) {
        const callerShell = yield* projectionStore
          .getThreadShell(input.callerThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (!callerShell) {
          return yield* new GroupChatCoordinatorError({
            code: "thread_not_found",
            message: `Thread ${input.callerThreadId} was not found.`,
          });
        }
        const settings = yield* serverSettings.getSettings;
        const nowIso = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
        const uuid = yield* randomUuidV4;
        const agentId = AgentProfileId.make(`agent-${uuid}`);
        const monogram = (
          input.request.name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "A"
        ).toUpperCase();

        const fallbackModelSelection = callerShell.modelSelection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex",
        };
        const resolvedModelSelection = {
          instanceId: input.request.providerInstanceId ?? fallbackModelSelection.instanceId,
          model: input.request.model ?? fallbackModelSelection.model,
          ...(input.request.modelOptions !== undefined
            ? { options: [...input.request.modelOptions] }
            : fallbackModelSelection.options !== undefined &&
                input.request.providerInstanceId === undefined &&
                input.request.model === undefined
              ? { options: fallbackModelSelection.options }
              : {}),
        };

        const nextProfile: AgentProfile = {
          id: agentId,
          name: input.request.name,
          role: input.request.role,
          projectId: callerShell.projectId,
          sharedAcrossProjects: input.request.sharedAcrossProjects ?? false,
          isOrchestrator: input.request.isOrchestrator ?? false,
          icon: {
            kind: "monogram",
            text: TrimmedNonEmptyString.make(monogram),
            color: "blue",
          },
          responsibilities: input.request.responsibilities
            ? [...input.request.responsibilities]
            : [],
          systemInstructions: input.request.systemInstructions?.trim() ?? "",
          ...(input.request.agentsMdContent
            ? { agentsMdContent: input.request.agentsMdContent }
            : {}),
          ...(input.request.agentsMdPath ? { agentsMdPath: input.request.agentsMdPath } : {}),
          ...(input.request.enabledSkillPaths
            ? { enabledSkillPaths: [...input.request.enabledSkillPaths] }
            : {}),
          ...(input.request.customSkills ? { customSkills: [...input.request.customSkills] } : {}),
          modelSelection: resolvedModelSelection,
          runtimeMode: input.request.runtimeMode ?? callerShell.runtimeMode ?? "full-access",
          interactionMode:
            input.request.interactionMode ?? callerShell.interactionMode ?? "default",
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        const callerGroup = resolveTeamGroupForChannel(callerShell.channel, settings.teamGroups);
        const shouldAddToGroup = input.request.addToCurrentGroup ?? true;
        const updatedGroups =
          callerGroup && shouldAddToGroup
            ? settings.teamGroups.map((group) => {
                if (group.id !== callerGroup.id) return group;
                const existingConvRoster = group.conversationRosters?.[input.callerThreadId];
                const nextConvRosters =
                  existingConvRoster === undefined
                    ? group.conversationRosters
                    : {
                        ...group.conversationRosters,
                        [input.callerThreadId]: {
                          ...existingConvRoster,
                          memberAgentIds: existingConvRoster.memberAgentIds.includes(agentId)
                            ? existingConvRoster.memberAgentIds
                            : [...existingConvRoster.memberAgentIds, agentId],
                          ...(input.request.isOrchestrator ? { orchestratorAgentId: agentId } : {}),
                        },
                      };
                return {
                  ...group,
                  memberAgentIds: group.memberAgentIds.includes(agentId)
                    ? group.memberAgentIds
                    : [...group.memberAgentIds, agentId],
                  ...(input.request.isOrchestrator ? { orchestratorAgentId: agentId } : {}),
                  ...(nextConvRosters === undefined
                    ? {}
                    : { conversationRosters: nextConvRosters }),
                  updatedAt: nowIso,
                };
              })
            : settings.teamGroups;

        yield* serverSettings.updateSettings({
          agentProfiles: [...settings.agentProfiles, nextProfile],
          teamGroups: updatedGroups,
        });

        const personalThreadId = yield* ensurePersonalAgentThread(
          callerShell.projectId,
          nextProfile,
        );

        return {
          created: true,
          agent: toAgentSummary(nextProfile, callerGroup, personalThreadId),
        } satisfies OrchestratorMcpTeamCreateAgentResult;
      },
      Effect.mapError(toCoordinatorError),
    );

    const updateTeamAgent = Effect.fn("GroupChatCoordinatorService.updateTeamAgent")(
      function* (input: {
        readonly callerThreadId: ThreadId;
        readonly request: OrchestratorMcpTeamUpdateAgentInput;
      }) {
        const callerShell = yield* projectionStore
          .getThreadShell(input.callerThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (!callerShell) {
          return yield* new GroupChatCoordinatorError({
            code: "thread_not_found",
            message: `Thread ${input.callerThreadId} was not found.`,
          });
        }
        const settings = yield* serverSettings.getSettings;
        const target = findAgentProfileByQuery(settings.agentProfiles, input.request.agentNameOrId);
        if (!target) {
          return yield* new GroupChatCoordinatorError({
            code: "agent_not_found",
            message: `No agent matched "${input.request.agentNameOrId}".`,
          });
        }

        const nowIso = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
        const { agentsMdPath: _oldAgentsMdPath, ...restTarget } = target;
        const nextAgentsMdPath =
          input.request.agentsMdPath === undefined
            ? target.agentsMdPath
            : (input.request.agentsMdPath ?? undefined);

        const nextOptions =
          input.request.modelOptions === null
            ? undefined
            : input.request.modelOptions !== undefined
              ? [...input.request.modelOptions]
              : target.modelSelection.options;
        const nextModelSelection = {
          instanceId: input.request.providerInstanceId ?? target.modelSelection.instanceId,
          model: input.request.model ?? target.modelSelection.model,
          ...(nextOptions !== undefined ? { options: nextOptions } : {}),
        };

        const updatedAgent: AgentProfile = {
          ...restTarget,
          ...(input.request.name !== undefined ? { name: input.request.name } : {}),
          ...(input.request.role !== undefined ? { role: input.request.role } : {}),
          ...(input.request.isOrchestrator !== undefined
            ? { isOrchestrator: input.request.isOrchestrator }
            : {}),
          modelSelection: nextModelSelection,
          ...(input.request.runtimeMode !== undefined
            ? { runtimeMode: input.request.runtimeMode }
            : {}),
          ...(input.request.interactionMode !== undefined
            ? { interactionMode: input.request.interactionMode }
            : {}),
          ...(input.request.responsibilities !== undefined
            ? { responsibilities: [...input.request.responsibilities] }
            : {}),
          ...(input.request.systemInstructions !== undefined
            ? { systemInstructions: input.request.systemInstructions }
            : {}),
          ...(input.request.agentsMdContent !== undefined
            ? { agentsMdContent: input.request.agentsMdContent }
            : {}),
          ...(nextAgentsMdPath !== undefined ? { agentsMdPath: nextAgentsMdPath } : {}),
          ...(input.request.enabledSkillPaths !== undefined
            ? { enabledSkillPaths: [...input.request.enabledSkillPaths] }
            : {}),
          ...(input.request.customSkills !== undefined
            ? { customSkills: [...input.request.customSkills] }
            : {}),
          ...(input.request.sharedAcrossProjects !== undefined
            ? { sharedAcrossProjects: input.request.sharedAcrossProjects }
            : {}),
          updatedAt: nowIso,
        };

        const callerGroup = resolveTeamGroupForChannel(callerShell.channel, settings.teamGroups);
        const updatedGroups =
          callerGroup &&
          (input.request.addToCurrentGroup !== undefined ||
            input.request.removeFromCurrentGroup !== undefined ||
            input.request.isOrchestrator === true)
            ? settings.teamGroups.map((group) => {
                if (group.id !== callerGroup.id) return group;
                const isGroupChatCaller = callerShell.channel?.kind === "group_chat";
                if (isGroupChatCaller) {
                  const currentRoster = group.conversationRosters?.[input.callerThreadId] ?? {
                    memberAgentIds: group.memberAgentIds,
                    orchestratorAgentId: group.orchestratorAgentId ?? null,
                  };
                  let nextMembers = [...currentRoster.memberAgentIds];
                  if (
                    input.request.addToCurrentGroup === true &&
                    !nextMembers.includes(target.id)
                  ) {
                    nextMembers.push(target.id);
                  }
                  if (input.request.removeFromCurrentGroup === true) {
                    nextMembers = nextMembers.filter((id) => id !== target.id);
                  }
                  return {
                    ...group,
                    conversationRosters: {
                      ...group.conversationRosters,
                      [input.callerThreadId]: {
                        memberAgentIds: nextMembers,
                        orchestratorAgentId:
                          input.request.isOrchestrator === true
                            ? target.id
                            : currentRoster.orchestratorAgentId === target.id &&
                                input.request.removeFromCurrentGroup === true
                              ? (nextMembers[0] ?? null)
                              : (currentRoster.orchestratorAgentId ?? null),
                      },
                    },
                    updatedAt: nowIso,
                  };
                }
                let nextMembers = [...group.memberAgentIds];
                if (input.request.addToCurrentGroup === true && !nextMembers.includes(target.id)) {
                  nextMembers.push(target.id);
                }
                if (input.request.removeFromCurrentGroup === true) {
                  nextMembers = nextMembers.filter((id) => id !== target.id);
                }
                return {
                  ...group,
                  memberAgentIds: nextMembers,
                  ...(input.request.isOrchestrator === true
                    ? { orchestratorAgentId: target.id }
                    : {}),
                  updatedAt: nowIso,
                };
              })
            : settings.teamGroups;

        const updatedProfiles = settings.agentProfiles.map((candidate) =>
          candidate.id === target.id ? updatedAgent : candidate,
        );
        yield* serverSettings.updateSettings({
          agentProfiles: updatedProfiles,
          teamGroups: updatedGroups,
        });

        if (
          input.request.providerInstanceId !== undefined ||
          input.request.model !== undefined ||
          input.request.modelOptions !== undefined
        ) {
          const shellSnapshot = yield* projectionStore
            .getShellSnapshot()
            .pipe(Effect.orElseSucceed(() => ({ projects: [], threads: [], snapshotSequence: 0 })));
          const personalThreads = shellSnapshot.threads.filter(
            (thread) =>
              thread.deletedAt === null &&
              thread.channel?.kind === "agent_personal" &&
              thread.channel.agentProfileId === target.id,
          );
          for (const personalThread of personalThreads) {
            const cmdUuid = yield* randomUuidV4;
            yield* orchestrator
              .dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make(`cmd:team-update-agent-model:${cmdUuid}`),
                threadId: personalThread.id,
                modelSelection: updatedAgent.modelSelection,
              })
              .pipe(Effect.ignore);
          }
        }

        return {
          updated: true,
          agent: toAgentSummary(updatedAgent, callerGroup),
        } satisfies OrchestratorMcpTeamUpdateAgentResult;
      },
      Effect.mapError(toCoordinatorError),
    );

    const deleteTeamAgent = Effect.fn("GroupChatCoordinatorService.deleteTeamAgent")(
      function* (input: {
        readonly callerThreadId: ThreadId;
        readonly request: OrchestratorMcpTeamDeleteAgentInput;
      }) {
        const settings = yield* serverSettings.getSettings;
        const target = findAgentProfileByQuery(settings.agentProfiles, input.request.agentNameOrId);
        if (!target) {
          return yield* new GroupChatCoordinatorError({
            code: "agent_not_found",
            message: `No agent matched "${input.request.agentNameOrId}".`,
          });
        }

        const nowIso = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
        const updatedProfiles = settings.agentProfiles.filter(
          (candidate) => candidate.id !== target.id,
        );
        const updatedGroups = settings.teamGroups.map((group) => {
          if (
            !group.memberAgentIds.includes(target.id) &&
            group.orchestratorAgentId !== target.id
          ) {
            return group;
          }
          const nextMembers = group.memberAgentIds.filter((id) => id !== target.id);
          return {
            ...group,
            memberAgentIds: nextMembers,
            orchestratorAgentId:
              group.orchestratorAgentId === target.id
                ? (nextMembers[0] ?? null)
                : group.orchestratorAgentId,
            updatedAt: nowIso,
          };
        });

        yield* serverSettings.updateSettings({
          agentProfiles: updatedProfiles,
          teamGroups: updatedGroups,
        });

        return {
          deleted: true,
          agentProfileId: target.id,
          name: target.name,
        } satisfies OrchestratorMcpTeamDeleteAgentResult;
      },
      Effect.mapError(toCoordinatorError),
    );

    const askTeamAgent = Effect.fn("GroupChatCoordinatorService.askTeamAgent")(function* (input: {
      readonly callerThreadId: ThreadId;
      readonly targetAgent: string;
      readonly question: string;
    }) {
      const callerRecords = yield* projectionStore
        .getThreadRecords(input.callerThreadId, ["messages"])
        .pipe(
          Effect.mapError(
            (cause) =>
              new GroupChatCoordinatorError({
                code: "thread_not_found",
                message: cause.message,
                cause,
              }),
          ),
        );
      const settings = yield* serverSettings.getSettings;
      const group = resolveTeamGroupForChannel(callerRecords.thread.channel, settings.teamGroups);
      const roster = resolveGroupMemberAgents({
        group,
        threadId: callerRecords.thread.id,
        projectId: callerRecords.thread.projectId,
        agentProfiles: settings.agentProfiles,
      });
      const target =
        findAgentProfileByQuery(roster, input.targetAgent) ??
        findAgentProfileByQuery(settings.agentProfiles, input.targetAgent);
      if (!target) {
        return yield* new GroupChatCoordinatorError({
          code: "agent_not_found",
          message: `No team agent matched "${input.targetAgent}". Call t3_team_list_agents to see configured agents.`,
        });
      }

      const fromAgent =
        resolveActiveAgentForTurn({
          thread: callerRecords.thread,
          message: callerRecords.messages.at(-1),
          agentProfiles: settings.agentProfiles,
          teamGroups: settings.teamGroups,
        }) ?? null;

      const groupChatThreadId =
        callerRecords.thread.channel?.kind === "group_chat"
          ? callerRecords.thread.id
          : yield* ensureGroupChatThread(
              callerRecords.thread.projectId,
              callerRecords.thread.id,
              group?.id,
            );

      const queue = speakerQueues.get(groupChatThreadId) ?? [];
      queue.push({
        fromAgent,
        targetAgent: target,
        question: input.question,
      });
      speakerQueues.set(groupChatThreadId, queue);
      if (fromAgent !== null && isAgentOrchestratorInGroup(fromAgent, group, groupChatThreadId)) {
        needsOrchestratorReturn.add(groupChatThreadId);
      }

      return {
        queued: true,
        targetAgentProfileId: target.id,
        targetAgentName: target.name,
        targetAgentRole: target.role,
        note: `${target.name} (${target.role}) will respond in Group Chat after your turn ends.`,
      } satisfies OrchestratorMcpTeamAskAgentResult;
    }, Effect.mapError(toCoordinatorError));

    const delegateTeamTask = Effect.fn("GroupChatCoordinatorService.delegateTeamTask")(
      function* (input: {
        readonly callerThreadId: ThreadId;
        readonly targetAgent: string;
        readonly title: string;
        readonly task: string;
        readonly expectedDeliverables?: ReadonlyArray<string> | undefined;
      }) {
        const callerRecords = yield* projectionStore
          .getThreadRecords(input.callerThreadId, ["messages"])
          .pipe(
            Effect.mapError(
              (cause) =>
                new GroupChatCoordinatorError({
                  code: "thread_not_found",
                  message: cause.message,
                  cause,
                }),
            ),
          );
        const settings = yield* serverSettings.getSettings;
        const group = resolveTeamGroupForChannel(callerRecords.thread.channel, settings.teamGroups);
        const roster = resolveGroupMemberAgents({
          group,
          projectId: callerRecords.thread.projectId,
          agentProfiles: settings.agentProfiles,
        });
        const target =
          findAgentProfileByQuery(roster, input.targetAgent) ??
          findAgentProfileByQuery(settings.agentProfiles, input.targetAgent);
        if (!target) {
          return yield* new GroupChatCoordinatorError({
            code: "agent_not_found",
            message: `No team agent matched "${input.targetAgent}". Call t3_team_list_agents to see configured agents.`,
          });
        }

        const fromAgent =
          resolveActiveAgentForTurn({
            thread: callerRecords.thread,
            message: callerRecords.messages.at(-1),
            agentProfiles: settings.agentProfiles,
            teamGroups: settings.teamGroups,
          }) ?? findOrchestratorAgent(roster, group);

        const projectId = callerRecords.thread.projectId;
        const groupChatThreadId =
          callerRecords.thread.channel?.kind === "group_chat"
            ? callerRecords.thread.id
            : yield* ensureGroupChatThread(projectId, callerRecords.thread.id, group?.id);
        const personalThreadId = yield* ensurePersonalAgentThread(projectId, target);

        const taskId = yield* nextTaskId("team-task");
        const deliverablesSection =
          input.expectedDeliverables && input.expectedDeliverables.length > 0
            ? `\n\nExpected Deliverables:\n${input.expectedDeliverables.map((item) => `- ${item}`).join("\n")}`
            : "";
        const promptText = [
          input.task,
          deliverablesSection,
          "",
          "Keep all detailed logs and long reports here in your Personal Chat. At the very end of your response, include a <group_chat_summary>...</group_chat_summary> tag with a short 1-3 sentence conversational message for Group Chat.",
        ]
          .filter((line) => line !== "")
          .join("\n");

        const commandId = yield* nextCommandId("delegate-task");
        const messageId = yield* nextMessageId;
        const assignedRef: OrchestrationV2TeamTaskRef = {
          taskId,
          ...(group === null ? {} : { groupId: group.id, groupName: group.name }),
          agentProfileId: target.id,
          agentName: target.name,
          agentRole: target.role,
          personalThreadId,
          title: input.title,
          kind: "assigned",
        };

        const dispatched = yield* threadManagement.sendToThread({
          projectId,
          commandId,
          threadId: personalThreadId,
          senderThreadId: groupChatThreadId,
          messageId,
          text: promptText,
          attachments: [],
          modelSelection: target.modelSelection,
          mode: "queue",
          createdBy: "agent",
          creationSource: "mcp",
          ...(fromAgent === null
            ? {}
            : {
                authorAgentId: fromAgent.id,
                authorAgentName: fromAgent.name,
                authorAgentRole: fromAgent.role,
              }),
          targetAgentId: target.id,
          teamTaskRef: assignedRef,
        });

        activeDelegatedRuns.set(dispatched.run.id, {
          taskId,
          groupChatThreadId,
          ...(group === null ? {} : { groupId: group.id, groupName: group.name }),
          projectId,
          personalThreadId,
          personalRunId: dispatched.run.id,
          agentProfile: target,
          delegatorAgent: fromAgent,
          title: input.title,
        });
        lastGroupByPersonalThread.set(personalThreadId, {
          groupChatThreadId,
          ...(group === null ? {} : { groupId: group.id, groupName: group.name }),
        });

        return {
          taskId,
          agentProfileId: target.id,
          agentName: target.name,
          agentRole: target.role,
          personalThreadId,
          personalRunId: dispatched.run.id,
          status: dispatched.delivery === "queued" ? "queued" : "started",
        } satisfies OrchestratorMcpTeamDelegateTaskResult;
      },
      Effect.mapError(toCoordinatorError),
    );

    const reportTeamBlocker = Effect.fn("GroupChatCoordinatorService.reportTeamBlocker")(
      function* (input: {
        readonly callerThreadId: ThreadId;
        readonly summary: string;
        readonly details?: string | undefined;
        readonly targetAgent?: string | undefined;
      }) {
        const callerRecords = yield* projectionStore
          .getThreadRecords(input.callerThreadId, ["runs", "messages"])
          .pipe(
            Effect.mapError(
              (cause) =>
                new GroupChatCoordinatorError({
                  code: "thread_not_found",
                  message: cause.message,
                  cause,
                }),
            ),
          );
        const settings = yield* serverSettings.getSettings;
        const callerAgent = resolveActiveAgentForTurn({
          thread: callerRecords.thread,
          message: callerRecords.messages.at(-1),
          agentProfiles: settings.agentProfiles,
          teamGroups: settings.teamGroups,
        });

        const rememberedGroup = lastGroupByPersonalThread.get(callerRecords.thread.id);
        const latestTaskMsg = [...callerRecords.messages]
          .reverse()
          .find((m) => m.teamTaskRef?.groupId !== undefined);
        const groupId = rememberedGroup?.groupId ?? latestTaskMsg?.teamTaskRef?.groupId;
        const group =
          groupId !== undefined
            ? (settings.teamGroups.find((candidate) => candidate.id === groupId) ?? null)
            : (settings.teamGroups.find(
                (candidate) => candidate.projectId === callerRecords.thread.projectId,
              ) ?? null);
        const roster = resolveGroupMemberAgents({
          group,
          projectId: callerRecords.thread.projectId,
          agentProfiles: settings.agentProfiles,
        });

        const target =
          (input.targetAgent
            ? (findAgentProfileByQuery(roster, input.targetAgent) ??
              findAgentProfileByQuery(settings.agentProfiles, input.targetAgent))
            : null) ?? findOrchestratorAgent(roster, group);

        const projectId = callerRecords.thread.projectId;
        const groupChatThreadId =
          rememberedGroup?.groupChatThreadId ??
          (yield* ensureGroupChatThread(projectId, callerRecords.thread.id, group?.id));
        const latestRun = callerRecords.runs.at(-1);
        const taskId = yield* nextTaskId("team-blocker");

        const commandId = yield* nextCommandId("report-blocker");
        const messageId = yield* nextMessageId;
        const blockerText = [input.summary, ...(input.details ? ["", input.details] : [])].join(
          "\n",
        );

        yield* threadManagement.sendToThread({
          projectId,
          commandId,
          threadId: groupChatThreadId,
          senderThreadId: callerRecords.thread.id,
          messageId,
          text: blockerText,
          attachments: [],
          ...(target === null
            ? {}
            : {
                modelSelection: target.modelSelection,
                targetAgentId: target.id,
              }),
          mode: "queue",
          createdBy: "agent",
          creationSource: "mcp",
          ...(callerAgent === undefined
            ? {}
            : {
                authorAgentId: callerAgent.id,
                authorAgentName: callerAgent.name,
                authorAgentRole: callerAgent.role,
                teamTaskRef: {
                  taskId,
                  ...(group === null ? {} : { groupId: group.id, groupName: group.name }),
                  agentProfileId: callerAgent.id,
                  agentName: callerAgent.name,
                  agentRole: callerAgent.role,
                  personalThreadId: callerRecords.thread.id,
                  ...(latestRun === undefined ? {} : { personalRunId: latestRun.id }),
                  title: input.summary,
                  kind: "blocker" as const,
                },
              }),
        });

        return {
          reported: true,
          groupChatThreadId,
          messageId,
        } satisfies OrchestratorMcpTeamReportBlockerResult;
      },
      Effect.mapError(toCoordinatorError),
    );

    // Runs for every domain event emitted by the orchestrator; avoid creating a span per event.
    const handleDomainEvent = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
      if (
        event.type === "message.updated" &&
        event.payload.role === "user" &&
        event.payload.authorAgentId === undefined &&
        event.payload.targetAgentId === undefined
      ) {
        consecutiveAgentTurns.set(event.threadId, 0);
        return;
      }

      if (event.type !== "run.updated") {
        return;
      }

      const status = event.payload.status;
      if (status !== "waiting" && status !== "completed" && status !== "failed") {
        return;
      }

      const runId = event.payload.id;
      const delegated = activeDelegatedRuns.get(runId);
      if (delegated !== undefined) {
        activeDelegatedRuns.delete(runId);
        if (status !== "failed") {
          const personalRuns = yield* projectionStore
            .getThreadRecords(delegated.personalThreadId, ["runs"])
            .pipe(Effect.orElseSucceed(() => null));
          const followUpRun = personalRuns?.runs.find(
            (candidate) =>
              candidate.id !== runId &&
              (candidate.status === "queued" ||
                candidate.status === "starting" ||
                candidate.status === "running"),
          );
          if (followUpRun !== undefined) {
            activeDelegatedRuns.set(followUpRun.id, {
              ...delegated,
              personalRunId: followUpRun.id,
            });
            return;
          }
        }
        const personalRecords = yield* projectionStore
          .getThreadRecords(delegated.personalThreadId, ["messages"], {
            runIds: [runId],
          })
          .pipe(Effect.orElseSucceed(() => null));
        const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
        const group =
          delegated.groupId !== undefined && settings !== null
            ? (settings.teamGroups.find((candidate) => candidate.id === delegated.groupId) ?? null)
            : null;
        const roster =
          settings === null
            ? []
            : resolveGroupMemberAgents({
                group,
                projectId: delegated.projectId,
                agentProfiles: settings.agentProfiles,
              });
        const orchestratorAgent = delegated.delegatorAgent ?? findOrchestratorAgent(roster, group);

        const summary =
          status === "failed"
            ? `I encountered an error while working on "${delegated.title}". Please check my Personal Chat for full logs.`
            : summarizePersonalRunMessages(personalRecords?.messages ?? [], runId, delegated.title);

        const commandId = yield* nextCommandId("delegated-completion");
        const messageId = yield* nextMessageId;
        yield* threadManagement
          .sendToThread({
            projectId: delegated.projectId,
            commandId,
            threadId: delegated.groupChatThreadId,
            senderThreadId: delegated.personalThreadId,
            messageId,
            text: summary,
            attachments: [],
            ...(orchestratorAgent === null
              ? {}
              : {
                  modelSelection: orchestratorAgent.modelSelection,
                  targetAgentId: orchestratorAgent.id,
                }),
            mode: "queue",
            createdBy: "agent",
            creationSource: "server",
            authorAgentId: delegated.agentProfile.id,
            authorAgentName: delegated.agentProfile.name,
            authorAgentRole: delegated.agentProfile.role,
            teamTaskRef: {
              taskId: delegated.taskId,
              ...(delegated.groupId === undefined ? {} : { groupId: delegated.groupId }),
              ...(delegated.groupName === undefined ? {} : { groupName: delegated.groupName }),
              agentProfileId: delegated.agentProfile.id,
              agentName: delegated.agentProfile.name,
              agentRole: delegated.agentProfile.role,
              personalThreadId: delegated.personalThreadId,
              personalRunId: delegated.personalRunId,
              title: delegated.title,
              kind: status === "failed" ? "blocker" : "completed",
            },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("group-chat-coordinator.delegated-completion-report-failed", {
                groupChatThreadId: delegated.groupChatThreadId,
                personalThreadId: delegated.personalThreadId,
                cause,
              }),
            ),
          );
        return;
      }

      if (status === "failed") {
        return;
      }

      const queue = speakerQueues.get(event.threadId);
      const currentTurns = consecutiveAgentTurns.get(event.threadId) ?? 0;
      if (currentTurns >= MAX_CONSECUTIVE_AGENT_TURNS) {
        speakerQueues.delete(event.threadId);
        needsOrchestratorReturn.delete(event.threadId);
        return;
      }

      if (queue && queue.length > 0) {
        const nextHandoff = queue.shift()!;
        if (queue.length === 0) {
          speakerQueues.delete(event.threadId);
        }
        consecutiveAgentTurns.set(event.threadId, currentTurns + 1);
        lastDispatchedAgentByGroupThread.set(event.threadId, nextHandoff.targetAgent);

        const shell = yield* projectionStore
          .getThreadShell(event.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (!shell) return;

        const commandId = yield* nextCommandId("speaker-handoff");
        const messageId = yield* nextMessageId;
        yield* threadManagement
          .sendToThread({
            projectId: shell.projectId,
            commandId,
            threadId: event.threadId,
            messageId,
            text: nextHandoff.question,
            attachments: [],
            modelSelection: nextHandoff.targetAgent.modelSelection,
            mode: "queue",
            createdBy: "agent",
            creationSource: "server",
            ...(nextHandoff.fromAgent === null
              ? {}
              : {
                  authorAgentId: nextHandoff.fromAgent.id,
                  authorAgentName: nextHandoff.fromAgent.name,
                  authorAgentRole: nextHandoff.fromAgent.role,
                }),
            targetAgentId: nextHandoff.targetAgent.id,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("group-chat-coordinator.speaker-handoff-failed", {
                threadId: event.threadId,
                targetAgent: nextHandoff.targetAgent.name,
                cause,
              }),
            ),
          );
        return;
      }

      if (needsOrchestratorReturn.has(event.threadId)) {
        needsOrchestratorReturn.delete(event.threadId);
        const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
        const shell = yield* projectionStore
          .getThreadShell(event.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (!shell || !settings) return;

        const group = resolveTeamGroupForChannel(shell.channel, settings.teamGroups);
        const roster = resolveGroupMemberAgents({
          group,
          threadId: event.threadId,
          projectId: shell.projectId,
          agentProfiles: settings.agentProfiles,
        });
        const orchestratorAgent = findOrchestratorAgent(roster, group, event.threadId);
        const lastAgent = lastDispatchedAgentByGroupThread.get(event.threadId) ?? null;
        if (!orchestratorAgent || lastAgent?.id === orchestratorAgent.id) {
          return;
        }

        consecutiveAgentTurns.set(event.threadId, currentTurns + 1);
        lastDispatchedAgentByGroupThread.set(event.threadId, orchestratorAgent);

        const commandId = yield* nextCommandId("orchestrator-return");
        const messageId = yield* nextMessageId;
        yield* threadManagement
          .sendToThread({
            projectId: shell.projectId,
            commandId,
            threadId: event.threadId,
            messageId,
            text: `[Floor returned to ${orchestratorAgent.name} (${orchestratorAgent.role}) to continue leading the discussion.]`,
            attachments: [],
            modelSelection: orchestratorAgent.modelSelection,
            mode: "queue",
            createdBy: "agent",
            creationSource: "server",
            ...(lastAgent === null
              ? {}
              : {
                  authorAgentId: lastAgent.id,
                  authorAgentName: lastAgent.name,
                  authorAgentRole: lastAgent.role,
                }),
            targetAgentId: orchestratorAgent.id,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("group-chat-coordinator.orchestrator-return-failed", {
                threadId: event.threadId,
                cause,
              }),
            ),
          );
      }
    });

    // Syncs personal thread model selections when agent profiles are updated in settings.
    const syncPersonalThreadModelSelections = Effect.fnUntraced(function* (
      settings: ServerSettingsModel,
    ) {
      if (settings.agentProfiles.length === 0) return;
      const shellSnapshot = yield* projectionStore
        .getShellSnapshot()
        .pipe(Effect.orElseSucceed(() => ({ projects: [], threads: [], snapshotSequence: 0 })));
      for (const thread of shellSnapshot.threads) {
        if (thread.deletedAt !== null || thread.channel?.kind !== "agent_personal") continue;
        const agent = settings.agentProfiles.find(
          (candidate) =>
            thread.channel?.kind === "agent_personal" &&
            candidate.id === thread.channel.agentProfileId,
        );
        if (!agent || modelSelectionsEqual(thread.modelSelection, agent.modelSelection)) continue;
        if (thread.modelSelection.instanceId !== agent.modelSelection.instanceId) continue;
        const cmdUuid = yield* randomUuidV4;
        yield* orchestrator
          .dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`cmd:sync-agent-personal-model:${cmdUuid}`),
            threadId: thread.id,
            modelSelection: agent.modelSelection,
          })
          .pipe(Effect.ignore);
      }
    });

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => handleDomainEvent(event)),
    );
    yield* forkParked(
      Stream.runForEach(serverSettings.streamChanges, (settings) =>
        syncPersonalThreadModelSelections(settings),
      ),
    );

    return GroupChatCoordinatorService.of({
      ensureGroupChatThread,
      ensurePersonalAgentThread,
      listTeamAgents,
      createTeamAgent,
      updateTeamAgent,
      deleteTeamAgent,
      askTeamAgent,
      delegateTeamTask,
      reportTeamBlocker,
    });
  }),
);
