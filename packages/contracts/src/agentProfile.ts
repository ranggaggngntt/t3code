import * as Schema from "effect/Schema";
import {
  AgentProfileId,
  IsoDateTime,
  ProjectId,
  TeamGroupId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectIconOverride } from "./project.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const AgentInlineSkill = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: TrimmedString,
  content: Schema.String,
});
export type AgentInlineSkill = typeof AgentInlineSkill.Type;

export const AgentProfile = Schema.Struct({
  id: AgentProfileId,
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  sharedAcrossProjects: Schema.optional(Schema.Boolean),
  name: TrimmedNonEmptyString,
  role: TrimmedNonEmptyString,
  isOrchestrator: Schema.Boolean,
  icon: Schema.optional(ProjectIconOverride),
  responsibilities: Schema.Array(TrimmedNonEmptyString),
  systemInstructions: TrimmedString,
  agentsMdContent: Schema.optional(Schema.String),
  agentsMdPath: Schema.optional(TrimmedString),
  enabledSkillPaths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  customSkills: Schema.optional(Schema.Array(AgentInlineSkill)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentProfile = typeof AgentProfile.Type;

export const TeamGroupConversationRoster = Schema.Struct({
  memberAgentIds: Schema.Array(AgentProfileId),
  orchestratorAgentId: Schema.optional(Schema.NullOr(AgentProfileId)),
});
export type TeamGroupConversationRoster = typeof TeamGroupConversationRoster.Type;

export const TeamGroup = Schema.Struct({
  id: TeamGroupId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedString),
  memberAgentIds: Schema.Array(AgentProfileId),
  orchestratorAgentId: Schema.optional(Schema.NullOr(AgentProfileId)),
  conversationRosters: Schema.optional(Schema.Record(ThreadId, TeamGroupConversationRoster)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamGroup = typeof TeamGroup.Type;
