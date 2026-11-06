import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  type AgentProfile,
  DEFAULT_MODEL_BY_PROVIDER,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ProviderInstanceId,
  type ScopedThreadRef,
  type ServerProvider,
  type TeamGroup,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { cn, newThreadId } from "../lib/utils";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
} from "../providerInstances";
import { useEnvironmentProviders } from "../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  AgentAvatarBadge,
  AgentProfileDialogHost,
  isAgentAvailableForProject,
  openAgentProfileDialog,
  openProjectAgentsDialog,
  resolveAgentProfileColor,
} from "./AgentProfileDialog";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import { openTeamGroupDialog, TeamGroupDialogHost } from "./TeamGroupDialog";

export interface SidebarTeamSectionProps {
  readonly environmentId: EnvironmentId | null;
  readonly activeProject: EnvironmentProject | null;
  readonly allThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly routeThreadRef: ScopedThreadRef | null;
  readonly showActiveProjectGroups?: boolean | undefined;
}

export interface SidebarProjectTeamGroupsProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly allThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly routeThreadRef: ScopedThreadRef | null;
}

function resolveFallbackModelSelection(
  orchestrator: AgentProfile | null,
  defaultModelSelection: ModelSelection | null | undefined,
  rawProviders: ReadonlyArray<ServerProvider>,
): ModelSelection {
  if (orchestrator) {
    return orchestrator.modelSelection;
  }
  if (defaultModelSelection) {
    return defaultModelSelection;
  }
  const entries = deriveProviderInstanceEntries(rawProviders).filter(
    isProviderInstancePickerVisible,
  );
  const preferred = entries.find((entry) => entry.isAvailable) ?? entries[0];
  const fallbackModel = preferred
    ? (preferred.models[0]?.slug ??
      DEFAULT_MODEL_BY_PROVIDER[preferred.driverKind] ??
      "gpt-5.3-codex")
    : "gpt-5.3-codex";
  return {
    instanceId: preferred?.instanceId ?? ProviderInstanceId.make("codex"),
    model: fallbackModel,
  };
}

export function SidebarProjectTeamGroups(props: SidebarProjectTeamGroupsProps) {
  const router = useRouter();
  const { environmentId, projectId, projectTitle } = props;
  const settings = useEnvironmentSettings(environmentId);
  const rawProviders = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const createThread = useOrchestrationCommand(threadEnvironment.create);
  const archiveThread = useOrchestrationCommand(threadEnvironment.archive);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedAgentSubfolderGroupIds, setExpandedAgentSubfolderGroupIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const projectGroups = settings.teamGroups.filter((group) => group.projectId === projectId);
  const projectAgents = settings.agentProfiles.filter((agent) =>
    isAgentAvailableForProject(agent, projectId),
  );

  if (projectGroups.length === 0) {
    return null;
  }

  const routeKey = props.routeThreadRef ? scopedThreadKey(props.routeThreadRef) : null;

  const navigateToThread = async (ref: ScopedThreadRef) => {
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(ref),
    });
  };

  const toggleGroupCollapsed = (groupId: string) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const toggleAgentSubfolder = (groupId: string) => {
    setExpandedAgentSubfolderGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const isGroupThreadEmpty = (thread: EnvironmentThreadShell): boolean =>
    thread.itemCount === 0 && thread.latestUserMessageAt === null && thread.latestRun === null;

  const listGroupThreads = (group: TeamGroup): ReadonlyArray<EnvironmentThreadShell> =>
    props.allThreads
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.projectId === projectId &&
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.channel?.kind === "group_chat" &&
          (thread.channel.groupId === group.id ||
            (!thread.channel.groupId && projectGroups[0]?.id === group.id)),
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const findPersonalThread = (agent: AgentProfile): EnvironmentThreadShell | null =>
    props.allThreads.find(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.projectId === projectId &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        thread.channel?.kind === "agent_personal" &&
        thread.channel.agentProfileId === agent.id,
    ) ?? null;

  const handleOpenGroupChat = async (group: TeamGroup) => {
    const groupMembers =
      group.memberAgentIds.length > 0
        ? group.memberAgentIds
            .map((id) => settings.agentProfiles.find((candidate) => candidate.id === id))
            .filter((candidate): candidate is AgentProfile => candidate !== undefined)
        : projectAgents;
    const orchestrator =
      (group.orchestratorAgentId
        ? groupMembers.find((agent) => agent.id === group.orchestratorAgentId)
        : undefined) ??
      groupMembers.find((agent) => agent.isOrchestrator) ??
      groupMembers[0] ??
      null;
    const modelSelection = resolveFallbackModelSelection(
      orchestrator,
      props.defaultModelSelection,
      rawProviders,
    );

    const groupThreads = listGroupThreads(group);
    const blankThreads = groupThreads.filter(isGroupThreadEmpty);
    const matchingBlankThread =
      blankThreads.find(
        (thread) =>
          thread.channel?.kind === "group_chat" &&
          thread.channel.groupId === group.id &&
          thread.modelSelection.instanceId === modelSelection.instanceId &&
          thread.modelSelection.model === modelSelection.model,
      ) ?? null;

    if (matchingBlankThread) {
      await navigateToThread(scopeThreadRef(environmentId, matchingBlankThread.id));
      return;
    }

    for (const staleBlank of blankThreads) {
      await archiveThread({
        environmentId,
        input: {
          threadId: staleBlank.id,
        },
      });
    }

    const threadId = newThreadId();
    const created = await createThread({
      environmentId,
      input: {
        threadId,
        projectId,
        title: group.name,
        modelSelection,
        runtimeMode: orchestrator?.runtimeMode ?? "full-access",
        interactionMode: orchestrator?.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
        channel: {
          kind: "group_chat",
          projectId,
          groupId: group.id,
        },
      },
    });
    if (created._tag === "Success") {
      await navigateToThread(scopeThreadRef(environmentId, threadId));
    }
  };

  const handleOpenPersonalChat = async (agent: AgentProfile) => {
    const existing = findPersonalThread(agent);
    if (existing) {
      await navigateToThread(scopeThreadRef(environmentId, existing.id));
      return;
    }

    const threadId = newThreadId();
    const created = await createThread({
      environmentId,
      input: {
        threadId,
        projectId,
        title: `${agent.name} (${agent.role})`,
        modelSelection: agent.modelSelection,
        runtimeMode: agent.runtimeMode,
        interactionMode: agent.interactionMode,
        branch: null,
        worktreePath: null,
        channel: {
          kind: "agent_personal",
          projectId,
          agentProfileId: agent.id,
        },
      },
    });
    if (created._tag === "Success") {
      await navigateToThread(scopeThreadRef(environmentId, threadId));
    }
  };

  const handleResetPersonalChat = async (
    agent: AgentProfile,
    existingThread: EnvironmentThreadShell,
  ) => {
    await archiveThread({
      environmentId,
      input: {
        threadId: existingThread.id,
      },
    });
    const threadId = newThreadId();
    const created = await createThread({
      environmentId,
      input: {
        threadId,
        projectId,
        title: `${agent.name} (${agent.role})`,
        modelSelection: agent.modelSelection,
        runtimeMode: agent.runtimeMode,
        interactionMode: agent.interactionMode,
        branch: null,
        worktreePath: null,
        channel: {
          kind: "agent_personal",
          projectId,
          agentProfileId: agent.id,
        },
      },
    });
    if (created._tag === "Success") {
      await navigateToThread(scopeThreadRef(environmentId, threadId));
    }
  };

  return (
    <li className="list-none pl-2">
      <div className="my-0.5 flex flex-col gap-0.5 border-l border-sidebar-border/60 pl-2">
        {projectGroups.map((group) => {
          const isCollapsed = collapsedGroupIds.has(group.id);
          const groupThreads = listGroupThreads(group);
          const blankGroupThread = groupThreads.find(isGroupThreadEmpty) ?? null;
          const groupConversationThreads = groupThreads.filter(
            (thread) => !isGroupThreadEmpty(thread),
          );
          const isBlankGroupChatActive =
            blankGroupThread !== null &&
            routeKey === scopedThreadKey(scopeThreadRef(environmentId, blankGroupThread.id));
          const isAnyGroupConversationActive = groupConversationThreads.some(
            (thread) => routeKey === scopedThreadKey(scopeThreadRef(environmentId, thread.id)),
          );
          const isGroupChatActive =
            isBlankGroupChatActive || (isCollapsed && isAnyGroupConversationActive);
          const activeStatusThread =
            groupThreads.find((thread) => resolveThreadStatusPill({ thread }) !== null) ?? null;
          const groupStatusPill = activeStatusThread
            ? resolveThreadStatusPill({ thread: activeStatusThread })
            : null;
          const activeConversationThread =
            groupThreads.find(
              (thread) => routeKey === scopedThreadKey(scopeThreadRef(environmentId, thread.id)),
            ) ?? null;
          const activeConversationRoster =
            activeConversationThread !== null
              ? group.conversationRosters?.[activeConversationThread.id]
              : undefined;
          const groupMembers =
            activeConversationRoster !== undefined
              ? activeConversationRoster.memberAgentIds
                  .map((id) => settings.agentProfiles.find((candidate) => candidate.id === id))
                  .filter((candidate): candidate is AgentProfile => candidate !== undefined)
              : group.memberAgentIds.length > 0
                ? group.memberAgentIds
                    .map((id) => settings.agentProfiles.find((candidate) => candidate.id === id))
                    .filter((candidate): candidate is AgentProfile => candidate !== undefined)
                : projectAgents;
          const configuredLeadId =
            activeConversationRoster !== undefined
              ? activeConversationRoster.orchestratorAgentId
              : group.orchestratorAgentId;
          const groupLeadId =
            configuredLeadId ??
            groupMembers.find((agent) => agent.isOrchestrator)?.id ??
            groupMembers[0]?.id ??
            null;
          const isAnyGroupAgentActive = groupMembers.some((agent) => {
            const personalThread = findPersonalThread(agent);
            return (
              personalThread !== null &&
              routeKey === scopedThreadKey(scopeThreadRef(environmentId, personalThread.id))
            );
          });
          const isAgentsExpanded =
            expandedAgentSubfolderGroupIds.has(group.id) || isAnyGroupAgentActive;
          const activeAgentPill =
            groupMembers
              .map((agent) => {
                const personalThread = findPersonalThread(agent);
                return personalThread ? resolveThreadStatusPill({ thread: personalThread }) : null;
              })
              .find((pill) => pill !== null) ?? null;

          return (
            <div key={group.id} className="flex flex-col gap-0.5">
              <div className="group/team-group relative flex items-center">
                <button
                  type="button"
                  aria-label={`Toggle ${group.name}`}
                  onClick={() => toggleGroupCollapsed(group.id)}
                  className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground hover:text-sidebar-foreground"
                >
                  <ChevronDownIcon
                    className={cn("size-3 transition-transform", isCollapsed && "-rotate-90")}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => void handleOpenGroupChat(group)}
                  className={cn(
                    "flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md pr-16 pl-1 text-left text-xs font-medium transition-colors",
                    isGroupChatActive
                      ? "bg-sidebar-row-selected text-sidebar-foreground"
                      : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
                  )}
                >
                  <UsersIcon className="size-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  {groupStatusPill ? (
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 text-3xs font-medium group-hover/team-group:hidden",
                        groupStatusPill.colorClass,
                      )}
                    >
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          groupStatusPill.dotClass,
                          groupStatusPill.pulse && "animate-pulse",
                        )}
                      />
                      <span>
                        {groupStatusPill.label === "Working" ? "Discussing" : groupStatusPill.label}
                      </span>
                    </span>
                  ) : (
                    <span className="text-2xs text-sidebar-muted-foreground group-hover/team-group:hidden">
                      {groupConversationThreads.length > 0
                        ? groupConversationThreads.length
                        : groupMembers.length}
                    </span>
                  )}
                </button>

                <div className="absolute right-1 hidden items-center gap-0.5 group-hover/team-group:flex">
                  <button
                    type="button"
                    aria-label={`New conversation in ${group.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleOpenGroupChat(group);
                    }}
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="size-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Manage agents in ${projectTitle}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      openProjectAgentsDialog({
                        environmentId,
                        projectId,
                        projectTitle,
                      });
                    }}
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <BotIcon className="size-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit group ${group.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      openTeamGroupDialog({
                        environmentId,
                        projectId,
                        projectTitle,
                        group,
                      });
                    }}
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PencilIcon className="size-3" />
                  </button>
                </div>
              </div>

              {!isCollapsed ? (
                <ul className="flex flex-col gap-0.5 pl-4">
                  {groupConversationThreads.map((conversationThread) => {
                    const isConversationActive =
                      routeKey ===
                      scopedThreadKey(scopeThreadRef(environmentId, conversationThread.id));
                    const conversationPill = resolveThreadStatusPill({
                      thread: conversationThread,
                    });

                    return (
                      <li
                        key={conversationThread.id}
                        className="group/group-conv relative flex items-center"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            void navigateToThread(
                              scopeThreadRef(environmentId, conversationThread.id),
                            )
                          }
                          className={cn(
                            "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md pr-7 pl-1.5 text-left text-xs transition-colors",
                            isConversationActive
                              ? "bg-sidebar-row-selected font-medium text-sidebar-foreground"
                              : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover",
                          )}
                        >
                          <MessageSquareIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            {conversationThread.title}
                          </span>
                          {conversationPill ? (
                            <span
                              className={cn(
                                "inline-flex shrink-0 items-center gap-1 text-3xs font-medium group-hover/group-conv:hidden",
                                conversationPill.colorClass,
                              )}
                            >
                              <span
                                className={cn(
                                  "size-1.5 rounded-full",
                                  conversationPill.dotClass,
                                  conversationPill.pulse && "animate-pulse",
                                )}
                              />
                              <span>
                                {conversationPill.label === "Working"
                                  ? "Discussing"
                                  : conversationPill.label}
                              </span>
                            </span>
                          ) : null}
                        </button>
                        <div className="absolute right-1 hidden items-center gap-0.5 group-hover/group-conv:flex">
                          <button
                            type="button"
                            aria-label={`Archive ${conversationThread.title}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              void archiveThread({
                                environmentId,
                                input: {
                                  threadId: conversationThread.id,
                                },
                              });
                            }}
                            className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                          >
                            <Trash2Icon className="size-3" />
                          </button>
                        </div>
                      </li>
                    );
                  })}

                  {groupMembers.length > 0 ? (
                    <li className="flex flex-col gap-0.5">
                      <button
                        type="button"
                        onClick={() => toggleAgentSubfolder(group.id)}
                        className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      >
                        <ChevronDownIcon
                          className={cn(
                            "size-3 shrink-0 transition-transform",
                            !isAgentsExpanded && "-rotate-90",
                          )}
                        />
                        <BotIcon className="size-3 shrink-0 text-primary/80" />
                        <span className="min-w-0 flex-1 truncate">
                          Agents ({groupMembers.length})
                        </span>
                        {!isAgentsExpanded && activeAgentPill ? (
                          <span
                            className={cn(
                              "inline-flex shrink-0 items-center gap-1 text-3xs font-medium",
                              activeAgentPill.colorClass,
                            )}
                          >
                            <span
                              className={cn(
                                "size-1.5 rounded-full",
                                activeAgentPill.dotClass,
                                activeAgentPill.pulse && "animate-pulse",
                              )}
                            />
                            <span>{activeAgentPill.label}</span>
                          </span>
                        ) : null}
                      </button>

                      {isAgentsExpanded ? (
                        <ul className="flex flex-col gap-0.5 border-l border-sidebar-border/50 pl-3">
                          {groupMembers.map((agent) => {
                            const personalThread = findPersonalThread(agent);
                            const isPersonalActive =
                              personalThread !== null &&
                              routeKey ===
                                scopedThreadKey(scopeThreadRef(environmentId, personalThread.id));
                            const statusPill = personalThread
                              ? resolveThreadStatusPill({ thread: personalThread })
                              : null;

                            return (
                              <li key={agent.id} className="group/agent relative flex items-center">
                                <button
                                  type="button"
                                  onClick={() => void handleOpenPersonalChat(agent)}
                                  className={cn(
                                    "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md pr-11 pl-1.5 text-left text-xs transition-colors",
                                    isPersonalActive
                                      ? "bg-sidebar-row-selected font-medium text-sidebar-foreground"
                                      : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover",
                                  )}
                                >
                                  <AgentAvatarBadge
                                    name={agent.name}
                                    isOrchestrator={groupLeadId === agent.id}
                                    color={resolveAgentProfileColor(agent)}
                                  />
                                  <span className="min-w-0 flex-1 truncate">
                                    {agent.name}{" "}
                                    <span className="text-sidebar-muted-foreground">
                                      ({agent.role})
                                    </span>
                                  </span>
                                  {statusPill ? (
                                    <span
                                      className={cn(
                                        "inline-flex shrink-0 items-center gap-1 text-3xs font-medium",
                                        statusPill.colorClass,
                                      )}
                                    >
                                      <span
                                        className={cn(
                                          "size-1.5 rounded-full",
                                          statusPill.dotClass,
                                          statusPill.pulse && "animate-pulse",
                                        )}
                                      />
                                      <span className="group-hover/agent:hidden">
                                        {statusPill.label}
                                      </span>
                                    </span>
                                  ) : (
                                    <MessageSquareIcon className="size-3 shrink-0 text-sidebar-muted-foreground/40 group-hover/agent:hidden" />
                                  )}
                                </button>

                                <div className="absolute right-1 hidden items-center gap-0.5 group-hover/agent:flex">
                                  {personalThread ? (
                                    <button
                                      type="button"
                                      aria-label={`Reset ${agent.name}'s Personal Chat`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void handleResetPersonalChat(agent, personalThread);
                                      }}
                                      className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                                    >
                                      <RotateCcwIcon className="size-3" />
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    aria-label={`Edit ${agent.name}`}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openAgentProfileDialog({
                                        environmentId,
                                        profile: agent,
                                        defaultProjectId: projectId,
                                      });
                                    }}
                                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                                  >
                                    <PencilIcon className="size-3" />
                                  </button>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </li>
  );
}

export function SidebarTeamSection(props: SidebarTeamSectionProps) {
  const environmentId = props.activeProject?.environmentId ?? props.environmentId;
  if (!environmentId) {
    return null;
  }
  return <SidebarTeamSectionContent {...props} environmentId={environmentId} />;
}

function SidebarTeamSectionContent(
  props: SidebarTeamSectionProps & { readonly environmentId: EnvironmentId },
) {
  const { environmentId, activeProject } = props;
  const settings = useEnvironmentSettings(environmentId);

  const activeProjectGroups = activeProject
    ? settings.teamGroups.filter((group) => group.projectId === activeProject.id)
    : [];

  return (
    <>
      {props.showActiveProjectGroups && activeProject && activeProjectGroups.length > 0 ? (
        <ul className="mb-1 flex flex-col gap-0.5">
          <SidebarProjectTeamGroups
            environmentId={environmentId}
            projectId={activeProject.id}
            projectTitle={activeProject.title}
            defaultModelSelection={activeProject.defaultModelSelection}
            allThreads={props.allThreads}
            routeThreadRef={props.routeThreadRef}
          />
        </ul>
      ) : null}
      <AgentProfileDialogHost />
      <TeamGroupDialogHost />
    </>
  );
}
