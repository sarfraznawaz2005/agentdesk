# Domain: shared

**Directory:** `src/shared`
**Files:** 28
**Symbols:** 102

## Files

### `src/shared/rpc.ts`

**Exports:**
- `AgentDeskRPC` (line 4)


### `src/shared/rpc/activity.ts`

**Interfaces:**
- `UnreadActivityEntry` (line 3)

**Types:**
- `ActivityRequests` (line 8)


### `src/shared/rpc/agents.ts`

**Types:**
- `AgentsRequests` (line 1)


### `src/shared/rpc/analytics.ts`

**Types:**
- `AnalyticsRequests` (line 1)


### `src/shared/rpc/conversations.ts`

**Types:**
- `ConversationRow` (line 1)
- `ConversationsRequests` (line 11)


### `src/shared/rpc/council.ts`

**Types:**
- `CouncilRequests` (line 1)


### `src/shared/rpc/dashboard.ts`

**Types:**
- `DashboardRequests` (line 1)


### `src/shared/rpc/deploy.ts`

**Types:**
- `DeployRequests` (line 1)


### `src/shared/rpc/env-vars.ts`

**Types:**
- `CustomEnvVar` (line 1)
- `EnvVarsRequests` (line 9)


### `src/shared/rpc/freelance.ts`

**Interfaces:**
- `FreelanceChatMessageDto` (line 3)
- `FreelanceListingDto` (line 10)
- `WizardWorkableListing` (line 31)
- `WizardFailedListing` (line 40)

**Types:**
- `FreelanceListingStatus` (line 1)
- `FreelanceRequests` (line 47)


### `src/shared/rpc/git.ts`

**Types:**
- `GitRequests` (line 1)


### `src/shared/rpc/inbox.ts`

**Types:**
- `InboxRequests` (line 1)


### `src/shared/rpc/index.ts`

**Types:**
- `BunRequests` (line 37)
- `AgentDeskRPC` (line 64)

**Exports:**
- `SettingsRequests` (line 73)
- `ProvidersRequests` (line 73)
- `ProjectsRequests` (line 73)
- `ConversationsRequests` (line 73)
- `AgentsRequests` (line 73)
- `KanbanRequests` (line 73)
- `NotesRequests` (line 73)
- `DeployRequests` (line 73)
- `GitRequests` (line 73)
- `IntegrationsRequests` (line 73)
- `InboxRequests` (line 73)
- `AnalyticsRequests` (line 73)
- `SystemRequests` (line 73)
- `BunMessages` (line 73)
- `PluginsRequests` (line 73)
- `LspRequests` (line 73)
- `DashboardRequests` (line 73)
- `SkillsRequests` (line 73)
- `CouncilRequests` (line 73)
- `UpdaterRequests` (line 73)
- `FreelanceRequests` (line 73)
- `FreelanceListingDto` (line 73)
- `FreelanceChatMessageDto` (line 73)
- `PlaygroundRequests` (line 73)
- `PlaygroundPreviewDto` (line 73)
- `IssueFixerRequests` (line 73)
- `IssueFixerConfigDto` (line 73)
- `IssueFixRunDto` (line 73)
- `RemoteSyncRequests` (line 73)
- `RemoteSyncConfigDto` (line 73)
- `RemoteSyncConfigInput` (line 73)
- `RemoteSyncRunDto` (line 73)
- `RemoteEntryDto` (line 73)
- `PushDiffEntry` (line 73)
- `ActivityRequests` (line 73)
- `UnreadActivityEntry` (line 73)
- `EnvVarsRequests` (line 73)
- `CustomEnvVar` (line 73)
- `WebviewSchema` (line 73)


### `src/shared/rpc/integrations.ts`

**Types:**
- `ChannelRow` (line 1)
- `IntegrationsRequests` (line 11)


### `src/shared/rpc/issue-fixer.ts`

**Interfaces:**
- `IssueFixerConfigDto` (line 3)
- `IssueFixRunDto` (line 22)
- `IssueFixerKeywordDto` (line 44)
- `ActiveIssueFixRunDto` (line 51)

**Types:**
- `IssueFixerRequests` (line 64)


### `src/shared/rpc/kanban.ts`

**Types:**
- `KanbanTaskRow` (line 1)
- `KanbanRequests` (line 18)


### `src/shared/rpc/lsp.ts`

**Interfaces:**
- `LspServerStatus` (line 1)

**Types:**
- `LspRequests` (line 10)


### `src/shared/rpc/notes.ts`

**Types:**
- `NoteRow` (line 1)
- `PromptRow` (line 11)
- `NotesRequests` (line 21)


### `src/shared/rpc/playground.ts`

**Interfaces:**
- `PlaygroundServerDto` (line 3)
- `PlaygroundPreviewDto` (line 13)
- `PlaygroundPartDto` (line 21)
- `PlaygroundTokensDto` (line 35)

**Types:**
- `PlaygroundRequests` (line 41)


### `src/shared/rpc/plugins.ts`

**Types:**
- `PluginsRequests` (line 1)


### `src/shared/rpc/projects.ts`

**Types:**
- `ProjectRow` (line 1)
- `ProjectsRequests` (line 13)


### `src/shared/rpc/providers.ts`

**Types:**
- `ProvidersRequests` (line 1)


### `src/shared/rpc/remote-sync.ts`

**Interfaces:**
- `RemoteSelection` (line 6)
- `RemoteSyncConfigDto` (line 12)
- `RemoteSyncConfigInput` (line 41)
- `RemoteEntryDto` (line 60)
- `PushDiffEntry` (line 69)
- `PullConflictEntry` (line 83)
- `RemoteSyncRunDto` (line 90)

**Types:**
- `RemoteProtocol` (line 3)
- `RemoteAuthType` (line 4)
- `PushChangeStatus` (line 67)
- `RemoteSyncRequests` (line 105)


### `src/shared/rpc/settings.ts`

**Types:**
- `SettingsRequests` (line 1)


### `src/shared/rpc/skills.ts`

**Types:**
- `SkillValidationError` (line 1)
- `SkillsRequests` (line 6)


### `src/shared/rpc/system.ts`

**Types:**
- `SystemRequests` (line 1)
- `BunMessages` (line 253)


### `src/shared/rpc/updater.ts`

**Types:**
- `UpdaterRequests` (line 1)


### `src/shared/rpc/webview.ts`

**Types:**
- `WebviewSchema` (line 3)


## Change Recipe

To add a new feature to the **shared** domain:

1. Update the model/schema in `src/shared/`
