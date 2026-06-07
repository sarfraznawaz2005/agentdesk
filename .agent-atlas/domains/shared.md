# Domain: shared

**Directory:** `src/shared`
**Files:** 30
**Symbols:** 113

## Files

### `src/shared/freelance-currencies.ts`

**Interfaces:**
- `CurrencyInfo` (line 5)

**Functions:**
- `getCurrencySymbol` (line 159)
- `getCurrencyLabel` (line 164)

**Exports:**
- `CURRENCIES` (line 149)
- `CURRENCY_MAP` (line 154)


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
- `BunRequests` (line 38)
- `AgentDeskRPC` (line 66)

**Exports:**
- `SettingsRequests` (line 75)
- `ProvidersRequests` (line 75)
- `ProjectsRequests` (line 75)
- `ConversationsRequests` (line 75)
- `AgentsRequests` (line 75)
- `KanbanRequests` (line 75)
- `NotesRequests` (line 75)
- `DeployRequests` (line 75)
- `GitRequests` (line 75)
- `IntegrationsRequests` (line 75)
- `InboxRequests` (line 75)
- `AnalyticsRequests` (line 75)
- `SystemRequests` (line 75)
- `BunMessages` (line 75)
- `PluginsRequests` (line 75)
- `LspRequests` (line 75)
- `DashboardRequests` (line 75)
- `SkillsRequests` (line 75)
- `CouncilRequests` (line 75)
- `UpdaterRequests` (line 75)
- `FreelanceRequests` (line 75)
- `FreelanceListingDto` (line 75)
- `FreelanceChatMessageDto` (line 75)
- `PlaygroundRequests` (line 75)
- `PlaygroundPreviewDto` (line 75)
- `IssueFixerRequests` (line 75)
- `IssueFixerConfigDto` (line 75)
- `IssueFixRunDto` (line 75)
- `RemoteSyncRequests` (line 75)
- `RemoteSyncConfigDto` (line 75)
- `RemoteSyncConfigInput` (line 75)
- `RemoteSyncRunDto` (line 75)
- `RemoteEntryDto` (line 75)
- `PushDiffEntry` (line 75)
- `ActivityRequests` (line 75)
- `UnreadActivityEntry` (line 75)
- `EnvVarsRequests` (line 75)
- `CustomEnvVar` (line 75)
- `RecommendationsRequests` (line 75)
- `DependencyId` (line 75)
- `DependencyStatus` (line 75)
- `WebviewSchema` (line 75)


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


### `src/shared/rpc/recommendations.ts`

**Types:**
- `DependencyId` (line 1)
- `DependencyStatus` (line 3)
- `RecommendationsRequests` (line 9)


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
