# Domain: shared

**Directory:** `src/shared`
**Files:** 31
**Symbols:** 128

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
- `BunRequests` (line 39)
- `AgentDeskRPC` (line 68)

**Exports:**
- `SettingsRequests` (line 77)
- `ProvidersRequests` (line 77)
- `ProjectsRequests` (line 77)
- `ConversationsRequests` (line 77)
- `AgentsRequests` (line 77)
- `KanbanRequests` (line 77)
- `NotesRequests` (line 77)
- `DeployRequests` (line 77)
- `GitRequests` (line 77)
- `IntegrationsRequests` (line 77)
- `InboxRequests` (line 77)
- `AnalyticsRequests` (line 77)
- `SystemRequests` (line 77)
- `BunMessages` (line 77)
- `PluginsRequests` (line 77)
- `LspRequests` (line 77)
- `DashboardRequests` (line 77)
- `SkillsRequests` (line 77)
- `CouncilRequests` (line 77)
- `UpdaterRequests` (line 77)
- `FreelanceRequests` (line 77)
- `FreelanceListingDto` (line 77)
- `FreelanceChatMessageDto` (line 77)
- `PlaygroundRequests` (line 77)
- `PlaygroundPreviewDto` (line 77)
- `IssueFixerRequests` (line 77)
- `IssueFixerConfigDto` (line 77)
- `IssueFixRunDto` (line 77)
- `RemoteSyncRequests` (line 77)
- `RemoteSyncConfigDto` (line 77)
- `RemoteSyncConfigInput` (line 77)
- `RemoteSyncRunDto` (line 77)
- `RemoteEntryDto` (line 77)
- `PushDiffEntry` (line 77)
- `ActivityRequests` (line 77)
- `UnreadActivityEntry` (line 77)
- `EnvVarsRequests` (line 77)
- `CustomEnvVar` (line 77)
- `RecommendationsRequests` (line 77)
- `DependencyId` (line 77)
- `DependencyStatus` (line 77)
- `IssuesRequests` (line 77)
- `IssueSource` (line 77)
- `ExternalIssue` (line 77)
- `IssueSourceStatus` (line 77)
- `WebviewSchema` (line 77)


### `src/shared/rpc/integrations.ts`

**Types:**
- `ChannelRow` (line 1)
- `IntegrationsRequests` (line 11)


### `src/shared/rpc/issue-fixer.ts`

**Interfaces:**
- `IssueFixerConfigDto` (line 3)
- `IssueFixRunDto` (line 24)
- `IssueFixerKeywordDto` (line 46)
- `ActiveIssueFixRunDto` (line 53)

**Types:**
- `IssueFixerRequests` (line 66)


### `src/shared/rpc/issues.ts`

**Interfaces:**
- `IssueSourceFieldDescriptor` (line 14)
- `IssueSourceCapabilities` (line 23)
- `BucketSelectionSpec` (line 39)
- `IssueSourceDescriptor` (line 52)
- `ExternalIssue` (line 166)
- `IssueSourceStatus` (line 184)

**Types:**
- `IssueSource` (line 11)
- `IssuesRequests` (line 189)

**Functions:**
- `getIssueSourceDescriptor` (line 154)
- `requireIssueSourceDescriptor` (line 159)

**Exports:**
- `ISSUE_SOURCE_DESCRIPTORS` (line 74)


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
