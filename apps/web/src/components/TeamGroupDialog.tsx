import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AgentProfile,
  AgentProfileId,
  DEFAULT_MODEL_BY_PROVIDER,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ProviderInstanceId,
  type ScopedThreadRef,
  type ServerProvider,
  type TeamGroup,
  TeamGroupId,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { CheckIcon, CrownIcon, PlusIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { useId, useState } from "react";
import { create } from "zustand";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { cn, newThreadId, randomUUID } from "../lib/utils";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
} from "../providerInstances";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { useEnvironmentProviders } from "../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  AgentAvatarBadge,
  isAgentAvailableForProject,
  openAgentProfileDialog,
  openProjectAgentsDialog,
  resolveAgentProfileColor,
} from "./AgentProfileDialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

export interface TeamGroupDialogRequest {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle?: string | undefined;
  readonly group: TeamGroup | null;
  readonly conversationThreadId?: ThreadId | undefined;
  readonly conversationTitle?: string | undefined;
}

const useTeamGroupDialogStore = create<{
  request: TeamGroupDialogRequest | null;
}>(() => ({
  request: null,
}));

export function openTeamGroupDialog(request: TeamGroupDialogRequest): void {
  useTeamGroupDialogStore.setState({ request });
}

function closeTeamGroupDialog(): void {
  useTeamGroupDialogStore.setState({ request: null });
}

export function TeamGroupDialogHost() {
  const request = useTeamGroupDialogStore((state) => state.request);
  if (!request) {
    return null;
  }
  return (
    <TeamGroupDialog
      key={`${request.environmentId}:${request.projectId}:${request.group?.id ?? "new"}:${request.conversationThreadId ?? "group"}`}
      request={request}
    />
  );
}

function resolveGroupModelSelection(
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

function TeamGroupDialog({ request }: { readonly request: TeamGroupDialogRequest }) {
  const formId = useId();
  const router = useRouter();
  const settings = useEnvironmentSettings(request.environmentId);
  const allProjects = useProjects();
  const allThreads = useQuietThreadShells();
  const rawProviders =
    useEnvironmentProviders().get(request.environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const createThread = useOrchestrationCommand(threadEnvironment.create);
  const archiveThread = useOrchestrationCommand(threadEnvironment.archive);

  const project =
    allProjects.find(
      (candidate) =>
        candidate.environmentId === request.environmentId && candidate.id === request.projectId,
    ) ?? null;
  const projectTitle = request.projectTitle ?? project?.title ?? "Project";

  const availableAgents = settings.agentProfiles.filter((agent) =>
    isAgentAvailableForProject(agent, request.projectId),
  );

  const existing = request.group;
  const isConversationEdit = Boolean(existing && request.conversationThreadId);
  const existingConversationRoster =
    existing && request.conversationThreadId
      ? existing.conversationRosters?.[request.conversationThreadId]
      : undefined;
  const defaultMemberIds =
    existingConversationRoster !== undefined
      ? existingConversationRoster.memberAgentIds
      : existing && existing.memberAgentIds.length > 0
        ? existing.memberAgentIds
        : availableAgents.map((agent) => agent.id);
  const defaultOrchestratorId =
    existingConversationRoster?.orchestratorAgentId !== undefined
      ? existingConversationRoster.orchestratorAgentId
      : existing?.orchestratorAgentId
        ? existing.orchestratorAgentId
        : (availableAgents.find((agent) => agent.isOrchestrator)?.id ??
          availableAgents[0]?.id ??
          null);

  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [selectedAgentIds, setSelectedAgentIds] =
    useState<ReadonlyArray<AgentProfileId>>(defaultMemberIds);
  const [orchestratorId, setOrchestratorId] = useState<string>(defaultOrchestratorId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const navigateToThread = async (ref: ScopedThreadRef) => {
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(ref),
    });
  };

  const toggleMember = (agentId: AgentProfileId) => {
    setSelectedAgentIds((current) => {
      const exists = current.includes(agentId);
      const next = exists ? current.filter((id) => id !== agentId) : [...current, agentId];
      if (!exists && !orchestratorId) {
        setOrchestratorId(agentId);
      } else if (exists && orchestratorId === agentId) {
        setOrchestratorId(next[0] ?? "");
      }
      return next;
    });
  };

  const selectedMembers = availableAgents.filter((agent) => selectedAgentIds.includes(agent.id));
  const resolvedOrchestratorId =
    selectedMembers.find((agent) => agent.id === orchestratorId)?.id ??
    selectedMembers.find((agent) => agent.isOrchestrator)?.id ??
    selectedMembers[0]?.id ??
    null;

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!isConversationEdit && !trimmedName) {
      setError("Enter a group name (e.g., Core Engineering, Product & Design, QA Team).");
      return;
    }

    // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
    const nowIso = new Date().toISOString();
    const nextGroup: TeamGroup =
      isConversationEdit && existing && request.conversationThreadId
        ? {
            ...existing,
            conversationRosters: {
              ...existing.conversationRosters,
              [request.conversationThreadId]: {
                memberAgentIds: selectedMembers.map((agent) => agent.id),
                orchestratorAgentId: resolvedOrchestratorId
                  ? AgentProfileId.make(resolvedOrchestratorId)
                  : null,
              },
            },
            updatedAt: nowIso,
          }
        : {
            id: existing?.id ?? TeamGroupId.make(`group-${randomUUID()}`),
            projectId: request.projectId,
            name: trimmedName,
            ...(description.trim().length > 0 ? { description: description.trim() } : {}),
            memberAgentIds: selectedMembers.map((agent) => agent.id),
            orchestratorAgentId: resolvedOrchestratorId
              ? AgentProfileId.make(resolvedOrchestratorId)
              : null,
            ...(existing?.conversationRosters === undefined
              ? {}
              : { conversationRosters: existing.conversationRosters }),
            createdAt: existing?.createdAt ?? nowIso,
            updatedAt: nowIso,
          };

    const updatedGroups = existing
      ? settings.teamGroups.map((candidate) =>
          candidate.id === existing.id ? nextGroup : candidate,
        )
      : [...settings.teamGroups, nextGroup];

    setIsSaving(true);
    setError(null);
    const result = await updateSettings({
      environmentId: request.environmentId,
      input: {
        patch: {
          teamGroups: updatedGroups,
        },
      },
    });

    if (result._tag !== "Success") {
      setIsSaving(false);
      setError("Failed to save group. Please try again.");
      return;
    }

    if (!existing) {
      const existingGroupThread = allThreads.find(
        (thread) =>
          thread.environmentId === request.environmentId &&
          thread.projectId === request.projectId &&
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.channel?.kind === "group_chat" &&
          thread.channel.groupId === nextGroup.id,
      );
      if (existingGroupThread) {
        setIsSaving(false);
        closeTeamGroupDialog();
        await navigateToThread(scopeThreadRef(request.environmentId, existingGroupThread.id));
        return;
      }

      const orchestrator =
        selectedMembers.find((agent) => agent.id === resolvedOrchestratorId) ??
        selectedMembers[0] ??
        null;
      const modelSelection = resolveGroupModelSelection(
        orchestrator,
        project?.defaultModelSelection,
        rawProviders,
      );
      const threadId = newThreadId();
      const created = await createThread({
        environmentId: request.environmentId,
        input: {
          threadId,
          projectId: request.projectId,
          title: trimmedName,
          modelSelection,
          runtimeMode: orchestrator?.runtimeMode ?? "full-access",
          interactionMode: orchestrator?.interactionMode ?? "default",
          branch: null,
          worktreePath: null,
          channel: {
            kind: "group_chat",
            projectId: request.projectId,
            groupId: nextGroup.id,
          },
        },
      });
      setIsSaving(false);
      closeTeamGroupDialog();
      if (created._tag === "Success") {
        await navigateToThread(scopeThreadRef(request.environmentId, threadId));
      }
      return;
    }

    setIsSaving(false);
    closeTeamGroupDialog();
  };

  const handleDelete = async () => {
    if (!existing) return;
    setIsSaving(true);
    const updatedGroups = settings.teamGroups.filter((candidate) => candidate.id !== existing.id);
    const result = await updateSettings({
      environmentId: request.environmentId,
      input: {
        patch: {
          teamGroups: updatedGroups,
        },
      },
    });
    const groupThread = allThreads.find(
      (thread) =>
        thread.environmentId === request.environmentId &&
        thread.projectId === request.projectId &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        thread.channel?.kind === "group_chat" &&
        thread.channel.groupId === existing.id,
    );
    if (groupThread) {
      await archiveThread({
        environmentId: request.environmentId,
        input: { threadId: groupThread.id },
      });
    }
    setIsSaving(false);
    if (result._tag === "Success") {
      closeTeamGroupDialog();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeTeamGroupDialog();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {isConversationEdit
                ? `Conversation Agents · ${request.conversationTitle ?? existing?.name ?? "Group Chat"}`
                : existing
                  ? `Edit Group · ${existing.name}`
                  : `New Group in ${projectTitle}`}
            </DialogTitle>
            <DialogDescription>
              {isConversationEdit
                ? "Choose which agents participate in this conversation and select its Orchestrator. Changes here only affect this conversation."
                : `Create a dedicated team group for ${projectTitle}, select which agents collaborate in this group, and choose the group's Orchestrator.`}
            </DialogDescription>
          </DialogHeader>

          <DialogPanel>
            <div className="flex flex-col gap-4">
              {!isConversationEdit ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${formId}-name`}>Group Name</Label>
                    <Input
                      id={`${formId}-name`}
                      placeholder="e.g., Core Engineering, Frontend Team, Product & QA"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setError(null);
                      }}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${formId}-description`}>Description / Focus (optional)</Label>
                    <Textarea
                      id={`${formId}-description`}
                      size="sm"
                      placeholder="What is this group responsible for in this project?"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </div>
                </>
              ) : null}

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Group Members ({selectedMembers.length} selected)</Label>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        openProjectAgentsDialog({
                          environmentId: request.environmentId,
                          projectId: request.projectId,
                          projectTitle,
                        })
                      }
                    >
                      <UsersIcon className="size-3" />
                      Manage Agents
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        openAgentProfileDialog({
                          environmentId: request.environmentId,
                          profile: null,
                          defaultProjectId: request.projectId,
                        })
                      }
                    >
                      <PlusIcon className="size-3" />
                      New Agent
                    </Button>
                  </div>
                </div>

                {availableAgents.length > 0 ? (
                  <div className="flex max-h-52 flex-col gap-1.5 overflow-y-auto rounded-lg border border-border/70 bg-muted/20 p-2">
                    {availableAgents.map((agent) => {
                      const isSelected = selectedAgentIds.includes(agent.id);
                      const isGroupLead = resolvedOrchestratorId === agent.id && isSelected;
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => toggleMember(agent.id)}
                          className={cn(
                            "flex cursor-pointer items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors",
                            isSelected
                              ? "border-primary/50 bg-primary/10 text-foreground"
                              : "border-border/50 bg-background text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <AgentAvatarBadge
                              name={agent.name}
                              isOrchestrator={isGroupLead}
                              color={resolveAgentProfileColor(agent)}
                            />
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate font-medium text-foreground">
                                {agent.name}{" "}
                                <span className="font-normal text-muted-foreground">
                                  ({agent.role})
                                </span>
                              </span>
                              <span className="truncate text-2xs text-muted-foreground">
                                {agent.modelSelection.model}
                              </span>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {isGroupLead ? (
                              <span className="inline-flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning">
                                <CrownIcon className="size-3" />
                                Lead
                              </span>
                            ) : null}
                            <span
                              className={cn(
                                "flex size-4 items-center justify-center rounded border",
                                isSelected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-border",
                              )}
                            >
                              {isSelected ? <CheckIcon className="size-3" /> : null}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border/70 p-4 text-center">
                    <p className="text-xs text-muted-foreground">
                      Create your specialized agents to start collaborating.
                    </p>
                  </div>
                )}
              </div>

              {selectedMembers.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <Label>Group Orchestrator (Team Lead)</Label>
                  <Select
                    value={resolvedOrchestratorId ?? ""}
                    onValueChange={(next) => {
                      if (next) setOrchestratorId(next);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select group orchestrator" />
                    </SelectTrigger>
                    <SelectPopup>
                      {selectedMembers.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name} ({agent.role})
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <p className="text-2xs text-muted-foreground">
                    Leads discussions in this Group Chat, consults group members, and delegates
                    tasks to their Personal Chats.
                  </p>
                </div>
              ) : null}

              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </div>
          </DialogPanel>

          <DialogFooter>
            {existing && !isConversationEdit ? (
              <div className="mr-auto">
                <Button
                  type="button"
                  variant="destructive-outline"
                  disabled={isSaving}
                  onClick={() => void handleDelete()}
                >
                  <Trash2Icon className="size-3.5" />
                  Delete Group
                </Button>
              </div>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => closeTeamGroupDialog()}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isConversationEdit
                ? "Save Conversation Agents"
                : existing
                  ? "Save Group"
                  : "Create Group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
