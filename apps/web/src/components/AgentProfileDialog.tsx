import {
  isReasoningSelect,
  replaceDescriptorCurrentValue,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import {
  type AgentInlineSkill,
  AgentProfileId,
  type AgentProfile,
  DEFAULT_MODEL_BY_PROVIDER,
  type EnvironmentId,
  type ModelSelection,
  type ProjectIconColor,
  ProjectId,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProviderModel,
  type TeamGroupId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  BookOpenIcon,
  CheckIcon,
  CopyPlusIcon,
  CrownIcon,
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { create } from "zustand";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { cn, randomUUID } from "../lib/utils";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
} from "../providerInstances";
import { getProviderModelCapabilities } from "../providerModels";
import { useProjects } from "../state/entities";
import { useEnvironmentProviders } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useProjectPathSearch } from "../state/queries";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
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
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

export interface AgentProfileDialogRequest {
  readonly environmentId: EnvironmentId;
  readonly profile: AgentProfile | null;
  readonly defaultProjectId?: ProjectId | null | undefined;
  readonly defaultGroupId?: TeamGroupId | null | undefined;
  readonly defaultConversationThreadId?: ThreadId | null | undefined;
}

export interface ProjectAgentsDialogRequest {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle?: string | undefined;
}

const useAgentProfileDialogStore = create<{
  request: AgentProfileDialogRequest | null;
  projectAgentsRequest: ProjectAgentsDialogRequest | null;
}>(() => ({
  request: null,
  projectAgentsRequest: null,
}));

export function openAgentProfileDialog(request: AgentProfileDialogRequest): void {
  useAgentProfileDialogStore.setState({ request });
}

function closeAgentProfileDialog(): void {
  useAgentProfileDialogStore.setState({ request: null });
}

export function openProjectAgentsDialog(request: ProjectAgentsDialogRequest): void {
  useAgentProfileDialogStore.setState({ projectAgentsRequest: request });
}

function closeProjectAgentsDialog(): void {
  useAgentProfileDialogStore.setState({ projectAgentsRequest: null });
}

const AGENT_COLOR_OPTIONS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly label: string;
  readonly dotClass: string;
  readonly badgeClass: string;
}> = [
  {
    value: "blue",
    label: "Blue",
    dotClass: "bg-blue-500",
    badgeClass: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  },
  {
    value: "emerald",
    label: "Emerald",
    dotClass: "bg-emerald-500",
    badgeClass: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  },
  {
    value: "violet",
    label: "Violet",
    dotClass: "bg-violet-500",
    badgeClass: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30",
  },
  {
    value: "amber",
    label: "Amber",
    dotClass: "bg-amber-500",
    badgeClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  },
  {
    value: "rose",
    label: "Rose",
    dotClass: "bg-rose-500",
    badgeClass: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  },
  {
    value: "cyan",
    label: "Cyan",
    dotClass: "bg-cyan-500",
    badgeClass: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  },
];

const RUNTIME_MODE_OPTIONS: ReadonlyArray<{
  readonly value: RuntimeMode;
  readonly label: string;
}> = [
  { value: "full-access", label: "Full Access (unrestricted tools & edits)" },
  { value: "auto", label: "Auto (automatic workspace commands & edits)" },
  { value: "auto-accept-edits", label: "Auto-Accept Edits (ask before shell commands)" },
  { value: "approval-required", label: "Approval Required (ask before edits & commands)" },
];

const INTERACTION_MODE_OPTIONS: ReadonlyArray<{
  readonly value: ProviderInteractionMode;
  readonly label: string;
}> = [
  { value: "default", label: "Default (act & implement)" },
  { value: "plan", label: "Plan (propose before acting)" },
];

function resolveAgentBadgeColorClass(color: ProjectIconColor | undefined): string {
  const found = AGENT_COLOR_OPTIONS.find((item) => item.value === color);
  return found?.badgeClass ?? AGENT_COLOR_OPTIONS[0]!.badgeClass;
}

export function resolveAgentProfileColor(profile: Pick<AgentProfile, "icon">): ProjectIconColor {
  if (profile.icon && (profile.icon.kind === "monogram" || profile.icon.kind === "lucide")) {
    return profile.icon.color;
  }
  return "blue";
}

export function isAgentAvailableForProject(
  agent: AgentProfile,
  projectId: ProjectId | null,
): boolean {
  if (!projectId) {
    return true;
  }
  if (!agent.projectId) {
    return true;
  }
  if (agent.projectId === projectId) {
    return true;
  }
  return agent.sharedAcrossProjects === true;
}

export function AgentAvatarBadge(props: {
  readonly name: string;
  readonly isOrchestrator?: boolean | undefined;
  readonly color?: ProjectIconColor | undefined;
  readonly size?: "sm" | "md";
}) {
  const initial = props.name.trim().charAt(0).toUpperCase() || "A";
  const colorClass = resolveAgentBadgeColorClass(props.color);
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-md border font-semibold select-none",
        props.size === "md" ? "size-7 text-xs" : "size-5 text-2xs",
        colorClass,
      )}
    >
      {initial}
      {props.isOrchestrator ? (
        <CrownIcon className="absolute -top-1.5 -right-1.5 size-3 text-warning drop-shadow-xs" />
      ) : null}
    </span>
  );
}

export function AgentProfileDialogHost() {
  const request = useAgentProfileDialogStore((state) => state.request);
  const projectAgentsRequest = useAgentProfileDialogStore((state) => state.projectAgentsRequest);
  return (
    <>
      {projectAgentsRequest ? (
        <ProjectAgentsDialog
          key={`project-agents:${projectAgentsRequest.environmentId}:${projectAgentsRequest.projectId}`}
          request={projectAgentsRequest}
        />
      ) : null}
      {request ? (
        <AgentProfileDialog
          key={`${request.environmentId}:${request.profile?.id ?? "new"}:${request.defaultProjectId ?? "global"}`}
          request={request}
        />
      ) : null}
    </>
  );
}

const LEGACY_ANTIGRAVITY_EFFORT_REGEX = /^(.*)-(low|medium|high)$/i;

const ANTIGRAVITY_THINKING_CHOICES: ReadonlyArray<ProviderOptionChoice> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High", isDefault: true },
];

function isAntigravityFixedEffortModel(slug: string): boolean {
  return slug === "gpt-oss-120b-medium" || /^gpt-oss-.*-(low|medium|high)$/i.test(slug);
}

function normalizeAgentModelSelectionForProvider(input: {
  readonly driverKind: ProviderDriverKind | undefined;
  readonly availableModels: ReadonlyArray<ServerProviderModel>;
  readonly rawModel: string;
  readonly rawOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
}): {
  readonly modelSlug: string;
  readonly modelOptions: ReadonlyArray<ProviderOptionSelection>;
} {
  const trimmed = input.rawModel.trim();
  const baseOptions = input.rawOptions ?? [];
  if (!trimmed || input.availableModels.some((candidate) => candidate.slug === trimmed)) {
    return { modelSlug: trimmed, modelOptions: baseOptions };
  }
  const match = trimmed.match(LEGACY_ANTIGRAVITY_EFFORT_REGEX);
  if (!match) {
    return { modelSlug: trimmed, modelOptions: baseOptions };
  }
  const family = match[1]!;
  const legacyEffort = match[2]!.toLowerCase();
  const matchesProviderFamily =
    input.availableModels.some((candidate) => candidate.slug === family) ||
    (input.driverKind === "antigravity" && !isAntigravityFixedEffortModel(trimmed));
  if (!matchesProviderFamily) {
    return { modelSlug: trimmed, modelOptions: baseOptions };
  }
  const hasExplicitEffort = baseOptions.some(
    (option) =>
      option.id === "thinking_level" ||
      option.id === "effort" ||
      option.id === "reasoningEffort" ||
      option.id === "variant",
  );
  return {
    modelSlug: family,
    modelOptions: hasExplicitEffort
      ? baseOptions
      : [{ id: "thinking_level", value: legacyEffort }, ...baseOptions],
  };
}

function withResolvedDefaultChoice(descriptor: ProviderOptionDescriptor): ProviderOptionDescriptor {
  if (descriptor.type !== "select") {
    return descriptor;
  }
  if (descriptor.currentValue || descriptor.options.some((option) => option.isDefault)) {
    return descriptor;
  }
  const fallbackValue =
    descriptor.options.find((option) => option.id === "high")?.id ??
    descriptor.options.find((option) => option.id === "medium")?.id ??
    descriptor.options.at(-1)?.id ??
    descriptor.options[0]?.id;
  return fallbackValue ? { ...descriptor, currentValue: fallbackValue } : descriptor;
}

function resolveAgentOptionDescriptors(input: {
  readonly driverKind: ProviderDriverKind | undefined;
  readonly availableModels: ReadonlyArray<ServerProviderModel>;
  readonly modelSlug: string;
  readonly modelOptions: ReadonlyArray<ProviderOptionSelection>;
  readonly planModeEnabled: boolean;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.driverKind) {
    return [];
  }
  const baseCaps = getProviderModelCapabilities(
    input.availableModels,
    input.modelSlug,
    input.driverKind,
    input.planModeEnabled,
  );
  let rawDescriptors = (baseCaps.optionDescriptors ?? []).map(withResolvedDefaultChoice);
  if (
    input.driverKind === "antigravity" &&
    input.modelSlug.trim().length > 0 &&
    !isAntigravityFixedEffortModel(input.modelSlug.trim())
  ) {
    const existingThinkingIndex = rawDescriptors.findIndex(
      (descriptor) =>
        descriptor.type === "select" &&
        (descriptor.id === "thinking_level" || descriptor.role === "reasoning"),
    );
    if (existingThinkingIndex === -1) {
      rawDescriptors = [
        {
          id: "thinking_level",
          label: "Thinking Level",
          type: "select",
          role: "reasoning",
          options: ANTIGRAVITY_THINKING_CHOICES,
          currentValue: "high",
        },
        ...rawDescriptors,
      ];
    } else {
      const existingDescriptor = rawDescriptors[existingThinkingIndex];
      if (existingDescriptor?.type === "select") {
        const mergedChoices = ANTIGRAVITY_THINKING_CHOICES.map(
          (fallbackChoice) =>
            existingDescriptor.options.find((candidate) => candidate.id === fallbackChoice.id) ??
            fallbackChoice,
        );
        for (const extraChoice of existingDescriptor.options) {
          if (!mergedChoices.some((candidate) => candidate.id === extraChoice.id)) {
            mergedChoices.push(extraChoice);
          }
        }
        rawDescriptors = rawDescriptors.map((descriptor, index) =>
          index === existingThinkingIndex
            ? {
                ...existingDescriptor,
                options: mergedChoices,
                currentValue: existingDescriptor.currentValue ?? "high",
              }
            : descriptor,
        );
      }
    }
  }
  return getProviderOptionDescriptors({
    caps: createModelCapabilities({ optionDescriptors: rawDescriptors }),
    selections: input.modelOptions,
  });
}

function formatAgentModelSummary(
  selection: ModelSelection,
  providers: ReturnType<typeof deriveProviderInstanceEntries>,
): string {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const availableModels = provider?.models ?? [];
  const normalized = normalizeAgentModelSelectionForProvider({
    driverKind: provider?.driverKind,
    availableModels,
    rawModel: selection.model,
    rawOptions: selection.options,
  });
  const matchedModel = availableModels.find((candidate) => candidate.slug === normalized.modelSlug);
  const modelDisplay = matchedModel?.name || normalized.modelSlug || selection.model;
  const descriptors = resolveAgentOptionDescriptors({
    driverKind: provider?.driverKind,
    availableModels,
    modelSlug: normalized.modelSlug,
    modelOptions: normalized.modelOptions,
    planModeEnabled: true,
  });
  const reasoning = descriptors.find(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select" &&
      (isReasoningSelect(descriptor) || descriptor.id === "thinking_level"),
  );
  if (!reasoning) {
    return modelDisplay;
  }
  const currentValue = getProviderOptionCurrentValue(reasoning);
  const optionLabel = reasoning.options.find((option) => option.id === currentValue)?.label;
  return optionLabel ? `${modelDisplay} · ${optionLabel}` : modelDisplay;
}

function resolveDefaultModelForProvider(
  entry: ReturnType<typeof deriveProviderInstanceEntries>[number] | undefined,
): string {
  if (!entry) {
    return "gpt-5.3-codex";
  }
  return entry.models[0]?.slug ?? DEFAULT_MODEL_BY_PROVIDER[entry.driverKind] ?? "gpt-5.3-codex";
}

function resolveDefaultModelSelection(
  providers: ReturnType<typeof deriveProviderInstanceEntries>,
  existing: ModelSelection | undefined,
): ModelSelection {
  if (existing) {
    return existing;
  }
  const visible = providers.filter(isProviderInstancePickerVisible);
  const preferredInstance = visible.find((entry) => entry.isAvailable) ?? visible[0];
  const instanceId = preferredInstance?.instanceId ?? ProviderInstanceId.make("codex");
  const model = resolveDefaultModelForProvider(preferredInstance);
  return {
    instanceId,
    model,
  };
}

function sanitizeMonogramText(name: string): string {
  const match = name.trim().match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? "A").toUpperCase();
}

type AgentDialogTab = "general" | "agents-md" | "skills";

function AgentProfileDialog({ request }: { readonly request: AgentProfileDialogRequest }) {
  const formId = useId();
  const settings = useEnvironmentSettings(request.environmentId);
  const allProjects = useProjects().filter(
    (project) => project.environmentId === request.environmentId && project.archivedAt === null,
  );
  const rawProviders =
    useEnvironmentProviders().get(request.environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const providerEntries = deriveProviderInstanceEntries(rawProviders).filter(
    isProviderInstancePickerVisible,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const readProjectFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
  });

  const existing = request.profile;
  const initialSelection = resolveDefaultModelSelection(providerEntries, existing?.modelSelection);

  const [activeTab, setActiveTab] = useState<AgentDialogTab>("general");
  const [name, setName] = useState(existing?.name ?? "");
  const [role, setRole] = useState(existing?.role ?? "");
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    existing ? (existing.projectId ?? "__shared__") : (request.defaultProjectId ?? "__shared__"),
  );
  const [sharedAcrossProjects, setSharedAcrossProjects] = useState<boolean>(
    existing
      ? (existing.sharedAcrossProjects ?? existing.projectId == null)
      : request.defaultProjectId == null,
  );
  const [isOrchestrator, setIsOrchestrator] = useState(
    existing?.isOrchestrator ?? settings.agentProfiles.length === 0,
  );
  const [color, setColor] = useState<ProjectIconColor>(
    existing ? resolveAgentProfileColor(existing) : "blue",
  );
  const [responsibilitiesText, setResponsibilitiesText] = useState(
    existing ? existing.responsibilities.join("\n") : "",
  );
  const [systemInstructions, setSystemInstructions] = useState(existing?.systemInstructions ?? "");
  const [instanceId, setInstanceId] = useState<string>(initialSelection.instanceId);
  const [rawModelSlug, setModelSlug] = useState<string>(initialSelection.model);
  const [rawModelOptions, setModelOptions] = useState<ReadonlyArray<ProviderOptionSelection>>(
    initialSelection.options ?? [],
  );
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    existing?.runtimeMode ?? "full-access",
  );
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>(
    existing?.interactionMode ?? "default",
  );

  // AGENTS.md state
  const [agentsMdPath, setAgentsMdPath] = useState<string>(existing?.agentsMdPath ?? "");
  const [agentsMdContent, setAgentsMdContent] = useState<string>(existing?.agentsMdContent ?? "");
  const [fileLoadMessage, setFileLoadMessage] = useState<string | null>(null);

  // SKILLS state
  const [enabledSkillPaths, setEnabledSkillPaths] = useState<ReadonlyArray<string>>(
    existing?.enabledSkillPaths ?? [],
  );
  const [externalSkillPathInput, setExternalSkillPathInput] = useState<string>("");
  const [customSkills, setCustomSkills] = useState<ReadonlyArray<AgentInlineSkill>>(
    existing?.customSkills ?? [],
  );

  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const activeProjectForWorkspace =
    allProjects.find((project) => project.id === selectedProjectId) ?? allProjects[0] ?? null;
  const workspaceSkillSearch = useProjectPathSearch(
    {
      environmentId: request.environmentId,
      cwd: activeProjectForWorkspace?.workspaceRoot ?? null,
      query: "SKILL.md",
      kind: "file",
    },
    50,
  );

  const selectedProvider =
    providerEntries.find((entry) => entry.instanceId === instanceId) ?? providerEntries[0] ?? null;
  const availableModels = selectedProvider?.models ?? [];
  const normalizedSelection = normalizeAgentModelSelectionForProvider({
    driverKind: selectedProvider?.driverKind,
    availableModels,
    rawModel: rawModelSlug,
    rawOptions: rawModelOptions,
  });
  const modelSlug = normalizedSelection.modelSlug;
  const modelOptions = normalizedSelection.modelOptions;
  const optionDescriptors = resolveAgentOptionDescriptors({
    driverKind: selectedProvider?.driverKind,
    availableModels,
    modelSlug,
    modelOptions,
    planModeEnabled: interactionMode === "plan",
  });
  const selectDescriptors = optionDescriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = optionDescriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const reasoningDescriptor =
    selectDescriptors.find(
      (descriptor) => isReasoningSelect(descriptor) || descriptor.id === "thinking_level",
    ) ??
    selectDescriptors[0] ??
    null;
  const otherSelectDescriptors = selectDescriptors.filter(
    (descriptor) => descriptor !== reasoningDescriptor,
  );
  const isFixedAntigravityEffort =
    selectedProvider?.driverKind === "antigravity" &&
    isAntigravityFixedEffortModel(modelSlug.trim());

  const handleSelectDescriptorChange = (descriptorId: string, value: string) => {
    const nextDescriptors = replaceDescriptorCurrentValue(optionDescriptors, descriptorId, value);
    setModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? []);
  };

  const handleBooleanDescriptorChange = (descriptorId: string, value: boolean) => {
    const nextDescriptors = replaceDescriptorCurrentValue(optionDescriptors, descriptorId, value);
    setModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? []);
  };

  const handleLoadAgentsMdFromDisk = async () => {
    const targetPath = agentsMdPath.trim() || "AGENTS.md";
    if (!activeProjectForWorkspace?.workspaceRoot) {
      setFileLoadMessage("Select a project first to load a relative path from its workspace.");
      return;
    }
    setFileLoadMessage("Loading file...");
    const result = await readProjectFile({
      environmentId: request.environmentId,
      input: {
        cwd: activeProjectForWorkspace.workspaceRoot,
        relativePath: targetPath,
      },
    });
    if (result._tag === "Success" && result.value.exists !== false && "contents" in result.value) {
      setAgentsMdContent(result.value.contents);
      setFileLoadMessage(`Loaded ${targetPath} into editor.`);
    } else {
      setFileLoadMessage(`Could not read ${targetPath} in ${activeProjectForWorkspace.title}.`);
    }
  };

  const toggleSkillPath = (skillPath: string) => {
    const trimmed = skillPath.trim();
    if (!trimmed) return;
    setEnabledSkillPaths((current) =>
      current.includes(trimmed)
        ? current.filter((item) => item !== trimmed)
        : [...current, trimmed],
    );
  };

  const handleAddExternalSkillPath = () => {
    const trimmed = externalSkillPathInput.trim();
    if (!trimmed) return;
    if (!enabledSkillPaths.includes(trimmed)) {
      setEnabledSkillPaths((current) => [...current, trimmed]);
    }
    setExternalSkillPathInput("");
  };

  const handleAddCustomSkill = () => {
    setCustomSkills((current) => [
      ...current,
      {
        id: `skill-${randomUUID()}`,
        name: "custom-skill",
        description: "Describe when and how this skill should be used",
        content: "# Custom Skill\n\nWrite step-by-step instructions for this agent...",
      },
    ]);
  };

  const handleUpdateCustomSkill = (
    skillId: string,
    patch: Partial<Omit<AgentInlineSkill, "id">>,
  ) => {
    setCustomSkills((current) =>
      current.map((skill) => (skill.id === skillId ? { ...skill, ...patch } : skill)),
    );
  };

  const handleRemoveCustomSkill = (skillId: string) => {
    setCustomSkills((current) => current.filter((skill) => skill.id !== skillId));
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedRole = role.trim();
    const trimmedModel = modelSlug.trim();
    if (!trimmedName) {
      setError("Enter a name for the agent.");
      setActiveTab("general");
      return;
    }
    if (!trimmedRole) {
      setError("Enter a role or title for the agent.");
      setActiveTab("general");
      return;
    }
    if (!trimmedModel) {
      setError("Select or enter a model for the agent.");
      setActiveTab("general");
      return;
    }

    const sanitizedCustomSkills = customSkills
      .map((skill) => ({
        id: skill.id.trim() || `skill-${randomUUID()}`,
        name: skill.name.trim(),
        description: skill.description.trim() || "Custom agent skill",
        content: skill.content.trim(),
      }))
      .filter((skill) => skill.name.length > 0 && skill.content.length > 0);

    // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
    const nowIso = new Date().toISOString();
    const responsibilities = responsibilitiesText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const resolvedProjectId =
      selectedProjectId && selectedProjectId !== "__shared__"
        ? ProjectId.make(selectedProjectId)
        : null;

    const persistedOptions = buildProviderOptionSelectionsFromDescriptors(optionDescriptors);

    const nextProfile: AgentProfile = {
      id: existing?.id ?? AgentProfileId.make(`agent-${randomUUID()}`),
      name: trimmedName,
      role: trimmedRole,
      projectId: resolvedProjectId,
      sharedAcrossProjects: resolvedProjectId === null ? true : sharedAcrossProjects,
      isOrchestrator,
      icon: {
        kind: "monogram",
        text: sanitizeMonogramText(trimmedName),
        color,
      },
      responsibilities,
      systemInstructions: systemInstructions.trim(),
      ...(agentsMdContent.trim().length > 0 ? { agentsMdContent } : {}),
      ...(agentsMdPath.trim().length > 0 ? { agentsMdPath: agentsMdPath.trim() } : {}),
      ...(enabledSkillPaths.length > 0 ? { enabledSkillPaths } : {}),
      ...(sanitizedCustomSkills.length > 0 ? { customSkills: sanitizedCustomSkills } : {}),
      modelSelection: createModelSelection(
        ProviderInstanceId.make(instanceId),
        trimmedModel,
        persistedOptions,
      ),
      runtimeMode,
      interactionMode,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    const updatedProfiles = existing
      ? settings.agentProfiles.map((candidate) =>
          candidate.id === existing.id ? nextProfile : candidate,
        )
      : [...settings.agentProfiles, nextProfile];

    const updatedGroups =
      !existing && request.defaultGroupId
        ? settings.teamGroups.map((group) => {
            if (group.id !== request.defaultGroupId) return group;
            const convId = request.defaultConversationThreadId;
            if (convId) {
              const currentConv = group.conversationRosters?.[convId] ?? {
                memberAgentIds: group.memberAgentIds,
                orchestratorAgentId: group.orchestratorAgentId ?? null,
              };
              return {
                ...group,
                conversationRosters: {
                  ...group.conversationRosters,
                  [convId]: {
                    memberAgentIds: currentConv.memberAgentIds.includes(nextProfile.id)
                      ? currentConv.memberAgentIds
                      : [...currentConv.memberAgentIds, nextProfile.id],
                    orchestratorAgentId: nextProfile.isOrchestrator
                      ? nextProfile.id
                      : (currentConv.orchestratorAgentId ?? null),
                  },
                },
                updatedAt: nowIso,
              };
            }
            return {
              ...group,
              memberAgentIds: group.memberAgentIds.includes(nextProfile.id)
                ? group.memberAgentIds
                : [...group.memberAgentIds, nextProfile.id],
              ...(nextProfile.isOrchestrator ? { orchestratorAgentId: nextProfile.id } : {}),
              updatedAt: nowIso,
            };
          })
        : undefined;

    setIsSaving(true);
    setError(null);
    const result = await updateSettings({
      environmentId: request.environmentId,
      input: {
        patch: {
          agentProfiles: updatedProfiles,
          ...(updatedGroups === undefined ? {} : { teamGroups: updatedGroups }),
        },
      },
    });
    setIsSaving(false);
    if (result._tag === "Success") {
      closeAgentProfileDialog();
    } else {
      setError("Failed to save agent configuration. Please try again.");
    }
  };

  const handleDelete = async () => {
    if (!existing) return;
    setIsSaving(true);
    const updatedProfiles = settings.agentProfiles.filter(
      (candidate) => candidate.id !== existing.id,
    );
    const updatedGroups = settings.teamGroups.map((group) => {
      if (
        !group.memberAgentIds.includes(existing.id) &&
        group.orchestratorAgentId !== existing.id
      ) {
        return group;
      }
      const nextMembers = group.memberAgentIds.filter((id) => id !== existing.id);
      return {
        ...group,
        memberAgentIds: nextMembers,
        orchestratorAgentId:
          group.orchestratorAgentId === existing.id
            ? (nextMembers[0] ?? null)
            : group.orchestratorAgentId,
      };
    });
    const result = await updateSettings({
      environmentId: request.environmentId,
      input: {
        patch: {
          agentProfiles: updatedProfiles,
          teamGroups: updatedGroups,
        },
      },
    });
    setIsSaving(false);
    if (result._tag === "Success") {
      closeAgentProfileDialog();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeAgentProfileDialog();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? `Edit Agent · ${existing.name}` : "Create Agent"}</DialogTitle>
            <DialogDescription>
              Configure a specialized AI agent with its own role, model, AGENTS.md instructions, and
              SKILLS for your project groups.
            </DialogDescription>
            <div className="mt-2 flex items-center gap-1 border-b border-border/60 pb-2">
              <button
                type="button"
                onClick={() => setActiveTab("general")}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  activeTab === "general"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <SparklesIcon className="size-3.5" />
                <span>Identity &amp; Model</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("agents-md")}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  activeTab === "agents-md"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <FileTextIcon className="size-3.5" />
                <span>AGENTS.md</span>
                {agentsMdContent.trim().length > 0 || agentsMdPath.trim().length > 0 ? (
                  <span className="size-1.5 rounded-full bg-primary" />
                ) : null}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("skills")}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  activeTab === "skills"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <WrenchIcon className="size-3.5" />
                <span>SKILLS</span>
                {enabledSkillPaths.length + customSkills.length > 0 ? (
                  <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-2xs text-primary">
                    {enabledSkillPaths.length + customSkills.length}
                  </span>
                ) : null}
              </button>
            </div>
          </DialogHeader>

          <DialogPanel>
            {activeTab === "general" ? (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${formId}-name`}>Agent Name</Label>
                    <Input
                      id={`${formId}-name`}
                      placeholder="e.g., Atlas, Nova, Sentinel"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setError(null);
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${formId}-role`}>Role / Title</Label>
                    <Input
                      id={`${formId}-role`}
                      placeholder="e.g., Tech Lead, Backend Engineer, Product Designer, QA"
                      value={role}
                      onChange={(event) => {
                        setRole(event.target.value);
                        setError(null);
                      }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 rounded-lg border border-border/70 bg-muted/20 p-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>Primary Project Scope</Label>
                    <Select
                      value={selectedProjectId}
                      onValueChange={(next) => {
                        if (!next) return;
                        setSelectedProjectId(next);
                        if (next === "__shared__") {
                          setSharedAcrossProjects(true);
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="__shared__">
                          All Projects (Shared Agents Library)
                        </SelectItem>
                        {allProjects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.title}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between gap-3 pt-1 sm:pt-5">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                        <GlobeIcon className="size-3.5 text-primary" />
                        <span>Share Across All Projects</span>
                      </div>
                      <p className="text-2xs text-muted-foreground">
                        Allow any project&apos;s groups to add this agent.
                      </p>
                    </div>
                    <Switch
                      checked={selectedProjectId === "__shared__" ? true : sharedAcrossProjects}
                      disabled={selectedProjectId === "__shared__"}
                      onCheckedChange={(checked) => setSharedAcrossProjects(Boolean(checked))}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/30 p-3">
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      <CrownIcon className="size-3.5 text-warning" />
                      <span>Default Team Lead / Orchestrator</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Default lead when creating a group. Each group can also select its own
                      Orchestrator.
                    </p>
                  </div>
                  <Switch
                    checked={isOrchestrator}
                    onCheckedChange={(checked) => setIsOrchestrator(Boolean(checked))}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Badge Color</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    {AGENT_COLOR_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setColor(option.value)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                          color === option.value
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border/70 bg-background text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <span className={cn("size-2.5 rounded-full", option.dotClass)} />
                        <span>{option.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${formId}-responsibilities`}>
                    Responsibilities &amp; Expertise (one per line)
                  </Label>
                  <Textarea
                    id={`${formId}-responsibilities`}
                    size="sm"
                    placeholder={
                      "Lead architecture and code reviews\nImplement backend and frontend features\nVerify edge cases and performance"
                    }
                    value={responsibilitiesText}
                    onChange={(event) => setResponsibilitiesText(event.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${formId}-instructions`}>
                    System Instructions &amp; Personality
                  </Label>
                  <Textarea
                    id={`${formId}-instructions`}
                    placeholder="Describe how this agent thinks, communicates, challenges assumptions, and approaches work..."
                    value={systemInstructions}
                    onChange={(event) => setSystemInstructions(event.target.value)}
                  />
                </div>

                <div
                  className={cn(
                    "grid grid-cols-1 gap-3",
                    reasoningDescriptor || isFixedAntigravityEffort
                      ? "sm:grid-cols-3"
                      : "sm:grid-cols-2",
                  )}
                >
                  <div className="flex flex-col gap-1.5">
                    <Label>Provider</Label>
                    <Select
                      value={instanceId}
                      onValueChange={(next) => {
                        if (!next) return;
                        setInstanceId(next);
                        const nextProvider = providerEntries.find(
                          (entry) => entry.instanceId === next,
                        );
                        setModelSlug(resolveDefaultModelForProvider(nextProvider));
                        setModelOptions([]);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectPopup>
                        {providerEntries.map((entry) => (
                          <SelectItem key={entry.instanceId} value={entry.instanceId}>
                            {entry.displayName}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${formId}-model`}>Model</Label>
                    {availableModels.length > 0 ? (
                      <Select
                        value={modelSlug}
                        onValueChange={(next) => {
                          if (next) setModelSlug(next);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select model" />
                        </SelectTrigger>
                        <SelectPopup>
                          {availableModels.map((model) => (
                            <SelectItem key={model.slug} value={model.slug}>
                              {model.name || model.slug}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    ) : (
                      <Input
                        id={`${formId}-model`}
                        placeholder="Model identifier"
                        value={modelSlug}
                        onChange={(event) => setModelSlug(event.target.value)}
                      />
                    )}
                  </div>

                  {reasoningDescriptor ? (
                    <div className="flex flex-col gap-1.5">
                      <Label>
                        {reasoningDescriptor.id === "thinking_level"
                          ? "Effort / Thinking Level"
                          : reasoningDescriptor.label}
                      </Label>
                      {(() => {
                        const choices = selectableProviderOptionChoices(reasoningDescriptor);
                        const selectedValue = String(
                          getProviderOptionCurrentValue(reasoningDescriptor) ??
                            choices[0]?.id ??
                            "",
                        );
                        return (
                          <Select
                            value={selectedValue}
                            onValueChange={(next) => {
                              if (next) {
                                handleSelectDescriptorChange(reasoningDescriptor.id, next);
                              }
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select effort" />
                            </SelectTrigger>
                            <SelectPopup>
                              {choices.map((choice) => (
                                <SelectItem key={choice.id} value={choice.id}>
                                  {choice.label}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        );
                      })()}
                    </div>
                  ) : isFixedAntigravityEffort ? (
                    <div className="flex flex-col gap-1.5">
                      <Label>Effort / Thinking Level</Label>
                      <Select value="medium" disabled>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="medium">Medium (Built-in)</SelectItem>
                        </SelectPopup>
                      </Select>
                    </div>
                  ) : null}
                </div>

                {otherSelectDescriptors.length > 0 || booleanDescriptors.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {otherSelectDescriptors.map((descriptor) => {
                      const choices = selectableProviderOptionChoices(descriptor);
                      const selectedValue = String(
                        getProviderOptionCurrentValue(descriptor) ?? choices[0]?.id ?? "",
                      );
                      return (
                        <div key={descriptor.id} className="flex flex-col gap-1.5">
                          <Label>{descriptor.label}</Label>
                          <Select
                            value={selectedValue}
                            onValueChange={(next) => {
                              if (next) {
                                handleSelectDescriptorChange(descriptor.id, next);
                              }
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectPopup>
                              {choices.map((choice) => (
                                <SelectItem key={choice.id} value={choice.id}>
                                  {choice.label}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        </div>
                      );
                    })}
                    {booleanDescriptors.map((descriptor) => (
                      <div
                        key={descriptor.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 p-2.5"
                      >
                        <Label>{descriptor.label}</Label>
                        <Switch
                          checked={descriptor.currentValue === true}
                          onCheckedChange={(checked) =>
                            handleBooleanDescriptorChange(descriptor.id, Boolean(checked))
                          }
                        />
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>Runtime Mode</Label>
                    <Select
                      value={runtimeMode}
                      onValueChange={(next) => {
                        if (next) setRuntimeMode(next as RuntimeMode);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {RUNTIME_MODE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label>Interaction Mode</Label>
                    <Select
                      value={interactionMode}
                      onValueChange={(next) => {
                        if (next) setInteractionMode(next as ProviderInteractionMode);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {INTERACTION_MODE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                </div>
              </div>
            ) : null}

            {activeTab === "agents-md" ? (
              <div className="flex flex-col gap-4">
                <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${formId}-agents-md-path`}>
                      Link External AGENTS.md File Path (optional)
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Link a workspace-relative path (e.g.{" "}
                      <code className="rounded bg-muted px-1">AGENTS.md</code> or{" "}
                      <code className="rounded bg-muted px-1">.agents/backend-AGENTS.md</code>) or
                      an absolute path on disk. It is read fresh on every turn.
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        id={`${formId}-agents-md-path`}
                        placeholder="e.g., AGENTS.md or .agents/frontend-AGENTS.md"
                        value={agentsMdPath}
                        onChange={(event) => {
                          setAgentsMdPath(event.target.value);
                          setFileLoadMessage(null);
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void handleLoadAgentsMdFromDisk()}
                      >
                        <FolderOpenIcon className="size-3.5" />
                        Load into Editor
                      </Button>
                    </div>
                    {fileLoadMessage ? (
                      <p className="text-2xs text-muted-foreground">{fileLoadMessage}</p>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${formId}-agents-md-content`}>
                    Built-in AGENTS.md Instructions (per-agent markdown)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Write custom <code className="rounded bg-muted px-1">AGENTS.md</code> rules,
                    coding standards, or domain guidelines dedicated to this agent. Both linked and
                    built-in <code className="rounded bg-muted px-1">AGENTS.md</code> content are
                    injected when this agent runs.
                  </p>
                  <Textarea
                    id={`${formId}-agents-md-content`}
                    className="min-h-56"
                    placeholder={
                      "# Agent Guidelines (AGENTS.md)\n\n- Follow strict TypeScript and domain boundaries.\n- Always verify contracts and write focused tests before completing a task."
                    }
                    value={agentsMdContent}
                    onChange={(event) => setAgentsMdContent(event.target.value)}
                  />
                </div>
              </div>
            ) : null}

            {activeTab === "skills" ? (
              <div className="flex flex-col gap-4">
                <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <Label>
                        Workspace Skills ({activeProjectForWorkspace?.title ?? "Project"})
                      </Label>
                      <span className="text-2xs text-muted-foreground">
                        {workspaceSkillSearch.entries.length} found
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Select existing <code className="rounded bg-muted px-1">SKILL.md</code> files
                      discovered in the project workspace to activate for this agent.
                    </p>
                    {workspaceSkillSearch.entries.length > 0 ? (
                      <div className="flex max-h-36 flex-col gap-1 overflow-y-auto rounded-md border border-border/60 bg-background p-2">
                        {workspaceSkillSearch.entries.map((entry) => {
                          const isChecked = enabledSkillPaths.includes(entry.path);
                          return (
                            <button
                              key={entry.path}
                              type="button"
                              onClick={() => toggleSkillPath(entry.path)}
                              className={cn(
                                "flex cursor-pointer items-center justify-between rounded px-2 py-1 text-left text-xs transition-colors",
                                isChecked
                                  ? "bg-primary/10 font-medium text-foreground"
                                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                              )}
                            >
                              <span className="truncate font-mono text-2xs">{entry.path}</span>
                              {isChecked ? (
                                <CheckIcon className="size-3.5 shrink-0 text-primary" />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-2xs text-muted-foreground">
                        No <code className="rounded bg-muted px-1">SKILL.md</code> files detected in
                        this workspace yet. You can link external skill paths or create custom
                        skills below.
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${formId}-skill-path`}>
                      Link External Skill Folder or SKILL.md Path
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Link any skill directory (automatically loads its{" "}
                      <code className="rounded bg-muted px-1">SKILL.md</code>) or file path from
                      disk (workspace-relative, <code className="rounded bg-muted px-1">~/</code>,
                      or absolute path).
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        id={`${formId}-skill-path`}
                        placeholder="e.g., .agents/skills/test-t3-app or ~/.agents/skills/security-audit"
                        value={externalSkillPathInput}
                        onChange={(event) => setExternalSkillPathInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            handleAddExternalSkillPath();
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={handleAddExternalSkillPath}
                      >
                        <PlusIcon className="size-3.5" />
                        Add Path
                      </Button>
                    </div>
                    {enabledSkillPaths.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {enabledSkillPaths.map((skillPath) => (
                          <span
                            key={skillPath}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-0.5 font-mono text-2xs text-foreground"
                          >
                            <BookOpenIcon className="size-3 text-primary" />
                            <span>{skillPath}</span>
                            <button
                              type="button"
                              aria-label={`Remove ${skillPath}`}
                              onClick={() => toggleSkillPath(skillPath)}
                              className="cursor-pointer text-muted-foreground hover:text-destructive"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Custom Inline Skills (SKILL.md)</Label>
                      <p className="text-xs text-muted-foreground">
                        Author custom skills directly inside this agent profile.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={handleAddCustomSkill}
                    >
                      <PlusIcon className="size-3.5" />
                      New Custom Skill
                    </Button>
                  </div>

                  {customSkills.length > 0 ? (
                    <div className="flex flex-col gap-3">
                      {customSkills.map((skill) => (
                        <div
                          key={skill.id}
                          className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <Input
                              placeholder="Skill name (e.g., api-contract-audit)"
                              value={skill.name}
                              onChange={(event) =>
                                handleUpdateCustomSkill(skill.id, { name: event.target.value })
                              }
                            />
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Remove custom skill"
                              onClick={() => handleRemoveCustomSkill(skill.id)}
                            >
                              <Trash2Icon className="size-3.5 text-destructive" />
                            </Button>
                          </div>
                          <Input
                            placeholder="Short description of when to use this skill"
                            value={skill.description}
                            onChange={(event) =>
                              handleUpdateCustomSkill(skill.id, {
                                description: event.target.value,
                              })
                            }
                          />
                          <Textarea
                            size="sm"
                            className="min-h-28"
                            placeholder="# Skill Instructions (SKILL.md)\n\nStep-by-step instructions..."
                            value={skill.content}
                            onChange={(event) =>
                              handleUpdateCustomSkill(skill.id, { content: event.target.value })
                            }
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-border/70 p-3 text-center text-xs text-muted-foreground">
                      No custom inline skills added yet. Click &ldquo;New Custom Skill&rdquo; to
                      create a dedicated SKILL.md for this agent.
                    </p>
                  )}
                </div>
              </div>
            ) : null}

            {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
          </DialogPanel>

          <DialogFooter>
            {existing ? (
              <div className="mr-auto">
                <Button
                  type="button"
                  variant="destructive-outline"
                  disabled={isSaving}
                  onClick={() => void handleDelete()}
                >
                  <Trash2Icon className="size-3.5" />
                  Delete Agent
                </Button>
              </div>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => closeAgentProfileDialog()}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {existing ? "Save Changes" : "Create Agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function ProjectAgentsDialog({ request }: { readonly request: ProjectAgentsDialogRequest }) {
  const settings = useEnvironmentSettings(request.environmentId);
  const allProjects = useProjects().filter(
    (project) => project.environmentId === request.environmentId,
  );
  const rawProviders =
    useEnvironmentProviders().get(request.environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const providerEntries = deriveProviderInstanceEntries(rawProviders).filter(
    isProviderInstancePickerVisible,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const [isUpdating, setIsUpdating] = useState(false);

  const currentProject = allProjects.find((project) => project.id === request.projectId) ?? null;
  const projectTitle = request.projectTitle ?? currentProject?.title ?? "Project";

  const projectAgents = settings.agentProfiles.filter((agent) =>
    isAgentAvailableForProject(agent, request.projectId),
  );
  const otherProjectAgents = settings.agentProfiles.filter(
    (agent) => !isAgentAvailableForProject(agent, request.projectId),
  );

  const handleImportAgent = async (agent: AgentProfile, mode: "share" | "copy") => {
    setIsUpdating(true);
    // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
    const nowIso = new Date().toISOString();
    const updatedProfiles =
      mode === "share"
        ? settings.agentProfiles.map((candidate) =>
            candidate.id === agent.id
              ? { ...candidate, sharedAcrossProjects: true, updatedAt: nowIso }
              : candidate,
          )
        : [
            ...settings.agentProfiles,
            {
              ...agent,
              id: AgentProfileId.make(`agent-${randomUUID()}`),
              projectId: request.projectId,
              sharedAcrossProjects: false,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          ];

    await updateSettings({
      environmentId: request.environmentId,
      input: {
        patch: {
          agentProfiles: updatedProfiles,
        },
      },
    });
    setIsUpdating(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeProjectAgentsDialog();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Agents · {projectTitle}</DialogTitle>
          <DialogDescription>
            Create specialized agents for {projectTitle}, customize their AGENTS.md and SKILLS, or
            share/import agents across projects.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Available in {projectTitle} ({projectAgents.length})
              </span>
              <Button
                type="button"
                size="xs"
                onClick={() =>
                  openAgentProfileDialog({
                    environmentId: request.environmentId,
                    profile: null,
                    defaultProjectId: request.projectId,
                  })
                }
              >
                <PlusIcon className="size-3.5" />
                Create Agent
              </Button>
            </div>

            {projectAgents.length > 0 ? (
              <div className="flex flex-col gap-2">
                {projectAgents.map((agent) => {
                  const isShared = !agent.projectId || agent.sharedAcrossProjects === true;
                  const skillCount =
                    (agent.enabledSkillPaths?.length ?? 0) + (agent.customSkills?.length ?? 0);
                  const hasAgentsMd =
                    Boolean(agent.agentsMdContent?.trim()) || Boolean(agent.agentsMdPath?.trim());

                  return (
                    <div
                      key={agent.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background p-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <AgentAvatarBadge
                          name={agent.name}
                          isOrchestrator={agent.isOrchestrator}
                          color={resolveAgentProfileColor(agent)}
                          size="md"
                        />
                        <div className="flex min-w-0 flex-col">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-xs font-semibold text-foreground">
                              {agent.name}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                              ({agent.role})
                            </span>
                            {isShared ? (
                              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
                                Shared
                              </span>
                            ) : (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                                Project only
                              </span>
                            )}
                            {hasAgentsMd ? (
                              <span className="rounded bg-success/15 px-1.5 py-0.5 text-2xs font-medium text-success">
                                AGENTS.md
                              </span>
                            ) : null}
                            {skillCount > 0 ? (
                              <span className="rounded bg-info/15 px-1.5 py-0.5 text-2xs font-medium text-info">
                                {skillCount} {skillCount === 1 ? "Skill" : "Skills"}
                              </span>
                            ) : null}
                          </div>
                          <span className="truncate text-2xs text-muted-foreground">
                            Model: {formatAgentModelSummary(agent.modelSelection, providerEntries)}
                          </span>
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          openAgentProfileDialog({
                            environmentId: request.environmentId,
                            profile: agent,
                            defaultProjectId: request.projectId,
                          })
                        }
                      >
                        <PencilIcon className="size-3" />
                        Edit
                      </Button>
                    </div>
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

            {otherProjectAgents.length > 0 ? (
              <div className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-3">
                <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Agents in Other Projects ({otherProjectAgents.length})
                </span>
                <div className="flex flex-col gap-2">
                  {otherProjectAgents.map((agent) => {
                    const ownerProject = allProjects.find(
                      (project) => project.id === agent.projectId,
                    );
                    return (
                      <div
                        key={agent.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 p-2"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <AgentAvatarBadge
                            name={agent.name}
                            isOrchestrator={agent.isOrchestrator}
                            color={resolveAgentProfileColor(agent)}
                          />
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate text-xs font-medium text-foreground">
                              {agent.name}{" "}
                              <span className="text-muted-foreground">({agent.role})</span>
                            </span>
                            <span className="truncate text-2xs text-muted-foreground">
                              From {ownerProject?.title ?? "another project"}
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={isUpdating}
                            onClick={() => void handleImportAgent(agent, "copy")}
                          >
                            <CopyPlusIcon className="size-3" />
                            Copy Here
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={isUpdating}
                            onClick={() => void handleImportAgent(agent, "share")}
                          >
                            <GlobeIcon className="size-3" />
                            Share Globally
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => closeProjectAgentsDialog()}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
