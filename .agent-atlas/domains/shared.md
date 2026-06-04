# Domain: shared

**Directory:** `src/shared`
**Files:** 27
**Symbols:** 98

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
- `BunRequests` (line 36)
- `AgentDeskRPC` (line 62)

**Exports:**
- `SettingsRequests` (line 71)
- `ProvidersRequests` (line 71)
- `ProjectsRequests` (line 71)
- `ConversationsRequests` (line 71)
- `AgentsRequests` (line 71)
- `KanbanRequests` (line 71)
- `NotesRequests` (line 71)
- `DeployRequests` (line 71)
- `GitRequests` (line 71)
- `IntegrationsRequests` (line 71)
- `InboxRequests` (line 71)
- `AnalyticsRequests` (line 71)
- `SystemRequests` (line 71)
- `BunMessages` (line 71)
- `PluginsRequests` (line 71)
- `LspRequests` (line 71)
- `DashboardRequests` (line 71)
- `SkillsRequests` (line 71)
- `CouncilRequests` (line 71)
- `UpdaterRequests` (line 71)
- `FreelanceRequests` (line 71)
- `FreelanceListingDto` (line 71)
- `FreelanceChatMessageDto` (line 71)
- `PlaygroundRequests` (line 71)
- `PlaygroundPreviewDto` (line 71)
- `IssueFixerRequests` (line 71)
- `IssueFixerConfigDto` (line 71)
- `IssueFixRunDto` (line 71)
- `RemoteSyncRequests` (line 71)
- `RemoteSyncConfigDto` (line 71)
- `RemoteSyncConfigInput` (line 71)
- `RemoteSyncRunDto` (line 71)
- `RemoteEntryDto` (line 71)
- `PushDiffEntry` (line 71)
- `ActivityRequests` (line 71)
- `UnreadActivityEntry` (line 71)
- `WebviewSchema` (line 71)


### `src/shared/rpc/integrations.ts`

**Types:**
- `ChannelRow` (line 1)
- `IntegrationsRequests` (line 11)


### `src/shared/rpc/issue-fixer.ts`

**Interfaces:**
- `IssueFixerConfigDto` (line 3)
- `IssueFixRunDto` (line 21)
- `IssueFixerKeywordDto` (line 43)
- `ActiveIssueFixRunDto` (line 50)

**Types:**
- `IssueFixerRequests` (line 63)


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
