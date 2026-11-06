import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  type AgentProfile,
  DEFAULT_MODEL_BY_PROVIDER,
  type EnvironmentId,
  type OrchestrationV2ThreadChannel,
  ProviderInstanceId,
  type ScopedThreadRef,
  type TeamGroup,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, BotIcon, PencilIcon, PlusIcon, UsersIcon } from "lucide-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn, newThreadId } from "../../lib/utils";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
} from "../../providerInstances";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  AgentAvatarBadge,
  isAgentAvailableForProject,
  openAgentProfileDialog,
  openProjectAgentsDialog,
  resolveAgentProfileColor,
} from "../AgentProfileDialog";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { openTeamGroupDialog } from "../TeamGroupDialog";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface TeamChannelHeaderBarProps {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId | undefined;
  readonly threadTitle?: string | undefined;
  readonly project: EnvironmentProject | null;
  readonly channel: OrchestrationV2ThreadChannel | undefined;
}

export function TeamChannelHeaderBar(props: TeamChannelHeaderBarProps) {
  const router = useRouter();
  const settings = useEnvironmentSettings(props.environmentId);
  const allThreads = useQuietThreadShells();
  const rawProviders = useEnvironmentProviders().get(props.environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const createThread = useOrchestrationCommand(threadEnvironment.create);

  const navigateToThread = async (ref: ScopedThreadRef) => {
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(ref),
    });
  };

  const channel = props.channel;
  if (!channel) {
    return null;
  }

  const projectId = channel.projectId;
  const projectTitle = props.project?.title ?? "Project";
  const projectGroups = settings.teamGroups.filter((group) => group.projectId === projectId);
  const projectAgents = settings.agentProfiles.filter((agent) =>
    isAgentAvailableForProject(agent, projectId),
  );

  const findPersonalThread = (agent: AgentProfile): EnvironmentThreadShell | null =>
    allThreads.find(
      (thread) =>
        thread.environmentId === props.environmentId &&
        thread.projectId === projectId &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        thread.channel?.kind === "agent_personal" &&
        thread.channel.agentProfileId === agent.id,
    ) ?? null;

  const openAgentPersonalChat = async (agent: AgentProfile) => {
    const existing = findPersonalThread(agent);
    if (existing) {
      await navigateToThread(scopeThreadRef(props.environmentId, existing.id));
      return;
    }
    const threadId = newThreadId();
    const created = await createThread({
      environmentId: props.environmentId,
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
      await navigateToThread(scopeThreadRef(props.environmentId, threadId));
    }
  };

  const openGroupChat = async (group?: TeamGroup | null) => {
    const targetGroup = group ?? projectGroups[0] ?? null;
    const matchingThreads = allThreads
      .filter(
        (thread) =>
          thread.environmentId === props.environmentId &&
          thread.projectId === projectId &&
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.channel?.kind === "group_chat" &&
          (targetGroup
            ? thread.channel.groupId === targetGroup.id ||
              (!thread.channel.groupId && projectGroups[0]?.id === targetGroup.id)
            : true),
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const activeConversation =
      matchingThreads.find(
        (thread) =>
          thread.itemCount > 0 || thread.latestUserMessageAt !== null || thread.latestRun !== null,
      ) ??
      matchingThreads[0] ??
      null;
    if (activeConversation) {
      await navigateToThread(scopeThreadRef(props.environmentId, activeConversation.id));
      return;
    }
    const groupMembers =
      targetGroup && targetGroup.memberAgentIds.length > 0
        ? targetGroup.memberAgentIds
            .map((id) => settings.agentProfiles.find((candidate) => candidate.id === id))
            .filter((candidate): candidate is AgentProfile => candidate !== undefined)
        : projectAgents;
    const orchestrator =
      (targetGroup?.orchestratorAgentId
        ? groupMembers.find((agent) => agent.id === targetGroup.orchestratorAgentId)
        : undefined) ??
      groupMembers.find((agent) => agent.isOrchestrator) ??
      groupMembers[0] ??
      null;
    const entries = deriveProviderInstanceEntries(rawProviders).filter(
      isProviderInstancePickerVisible,
    );
    const preferred = entries.find((entry) => entry.isAvailable) ?? entries[0];
    const fallbackModel = preferred
      ? (preferred.models[0]?.slug ??
        DEFAULT_MODEL_BY_PROVIDER[preferred.driverKind] ??
        "gpt-5.3-codex")
      : "gpt-5.3-codex";
    const modelSelection = orchestrator?.modelSelection ??
      props.project?.defaultModelSelection ?? {
        instanceId: preferred?.instanceId ?? ProviderInstanceId.make("codex"),
        model: fallbackModel,
      };
    const threadId = newThreadId();
    const created = await createThread({
      environmentId: props.environmentId,
      input: {
        threadId,
        projectId,
        title: targetGroup?.name ?? "Group Chat",
        modelSelection,
        runtimeMode: orchestrator?.runtimeMode ?? "full-access",
        interactionMode: orchestrator?.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
        channel: {
          kind: "group_chat",
          projectId,
          ...(targetGroup ? { groupId: targetGroup.id } : {}),
        },
      },
    });
    if (created._tag === "Success") {
      await navigateToThread(scopeThreadRef(props.environmentId, threadId));
    }
  };

  if (channel.kind === "group_chat") {
    const activeGroup =
      (channel.groupId ? projectGroups.find((group) => group.id === channel.groupId) : undefined) ??
      projectGroups[0] ??
      null;
    const conversationRoster =
      activeGroup && props.threadId ? activeGroup.conversationRosters?.[props.threadId] : undefined;
    const groupMembers =
      conversationRoster !== undefined
        ? conversationRoster.memberAgentIds
            .map((id) => settings.agentProfiles.find((candidate) => candidate.id === id))
            .filter((candidate): candidate is AgentProfile => candidate !== undefined)
        : activeGroup && activeGroup.memberAgentIds.length > 0
          ? activeGroup.memberAgentIds
              .map((id) => settings.agentProfiles.find((candidate) => candidate.id === id))
              .filter((candidate): candidate is AgentProfile => candidate !== undefined)
          : projectAgents;
    const configuredLeadId =
      conversationRoster !== undefined
        ? conversationRoster.orchestratorAgentId
        : activeGroup?.orchestratorAgentId;
    const groupLeadId =
      configuredLeadId ??
      groupMembers.find((agent) => agent.isOrchestrator)?.id ??
      groupMembers[0]?.id ??
      null;

    return (
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-muted/15 px-3 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-foreground">
            <UsersIcon className="size-3.5 text-primary" />
            <span className="max-w-40 truncate">
              {activeGroup ? activeGroup.name : "Team Group Chat"}
            </span>
          </span>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          {groupMembers.length > 0 ? (
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {groupMembers.map((agent) => {
                const personalThread = findPersonalThread(agent);
                const pill = personalThread
                  ? resolveThreadStatusPill({ thread: personalThread })
                  : null;
                return (
                  <Tooltip key={agent.id}>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={`Open Me ↔ ${agent.name} (${agent.role}) Personal Chat`}
                          onClick={() => void openAgentPersonalChat(agent)}
                          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border/60 bg-background/80 px-1.5 py-0.5 text-2xs transition-colors hover:bg-accent"
                        />
                      }
                    >
                      <AgentAvatarBadge
                        name={agent.name}
                        isOrchestrator={groupLeadId === agent.id}
                        color={resolveAgentProfileColor(agent)}
                      />
                      <span className="font-medium text-foreground">{agent.name}</span>
                      {pill ? (
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            pill.dotClass,
                            pill.pulse && "animate-pulse",
                          )}
                        />
                      ) : null}
                    </TooltipTrigger>
                    <TooltipPopup>
                      {agent.name} ({agent.role})
                    </TooltipPopup>
                  </Tooltip>
                );
              })}
            </div>
          ) : (
            <span className="truncate text-muted-foreground">
              Create your specialized agents to start collaborating.
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() =>
              openTeamGroupDialog({
                environmentId: props.environmentId,
                projectId,
                projectTitle,
                group: activeGroup,
                conversationThreadId: props.threadId,
                conversationTitle: props.threadTitle,
              })
            }
          >
            <PencilIcon className="size-3" />
            {activeGroup ? "Edit" : "Configure"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() =>
              openProjectAgentsDialog({
                environmentId: props.environmentId,
                projectId,
                projectTitle,
              })
            }
          >
            <BotIcon className="size-3" />
            Agents
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              openAgentProfileDialog({
                environmentId: props.environmentId,
                profile: null,
                defaultProjectId: projectId,
                defaultGroupId: activeGroup?.id ?? null,
                defaultConversationThreadId: props.threadId ?? null,
              })
            }
          >
            <PlusIcon className="size-3" />
            Agent
          </Button>
        </div>
      </div>
    );
  }

  const agent =
    settings.agentProfiles.find((candidate) => candidate.id === channel.agentProfileId) ?? null;
  const memberGroups = agent
    ? projectGroups.filter(
        (group) => group.memberAgentIds.length === 0 || group.memberAgentIds.includes(agent.id),
      )
    : projectGroups;

  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-muted/15 px-3 text-xs">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {memberGroups.length > 0 ? (
          memberGroups.slice(0, 2).map((group) => (
            <Button
              key={group.id}
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => void openGroupChat(group)}
            >
              <ArrowLeftIcon className="size-3" />
              {group.name}
            </Button>
          ))
        ) : (
          <Button type="button" size="xs" variant="ghost" onClick={() => void openGroupChat()}>
            <ArrowLeftIcon className="size-3" />
            Group Chat
          </Button>
        )}
        <span className="shrink-0 text-muted-foreground/50">·</span>
        {agent ? (
          <>
            <AgentAvatarBadge
              name={agent.name}
              isOrchestrator={agent.isOrchestrator}
              color={resolveAgentProfileColor(agent)}
            />
            <span className="shrink-0 font-semibold text-foreground">{agent.name}</span>
            <span className="truncate text-muted-foreground">({agent.role})</span>
          </>
        ) : (
          <span className="truncate font-medium text-foreground">Personal Agent Chat</span>
        )}
      </div>
      {agent ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() =>
            openAgentProfileDialog({
              environmentId: props.environmentId,
              profile: agent,
              defaultProjectId: projectId,
            })
          }
        >
          <PencilIcon className="size-3" />
          Configure
        </Button>
      ) : null}
    </div>
  );
}
