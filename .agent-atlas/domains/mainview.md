# Domain: mainview

**Directory:** `src/mainview`
**Files:** 168
**Symbols:** 1434

## Files

### `src/mainview/App.tsx`

**Functions:**
- `App` (line 8)


### `src/mainview/components/activity/context-panel.tsx`

**Interfaces:**
- `ContextPanelProps` (line 10)

**Types:**
- `ContextTabId` (line 8)

**Functions:**
- `ContextPanel` (line 15)


### `src/mainview/components/activity/docs-tab.tsx`

**Interfaces:**
- `Note` (line 18)
- `Plan` (line 28)
- `SelectedDoc` (line 35)
- `DocsTabProps` (line 41)
- `DocsTabHandle` (line 45)

**Functions:**
- `refresh` (line 82)
- `onKanbanMove` (line 83)
- `handleViewAllNotes` (line 97)
- `openNote` (line 103)
- `openPlan` (line 116)
- `downloadSelectedDoc` (line 126)

**Methods:**
- `code` (line 339)

**Exports:**
- `DocsTab` (line 49)


### `src/mainview/components/activity/files-tab.tsx`

**Interfaces:**
- `FileEntry` (line 28)
- `TreeNode` (line 36)
- `FilesTabProps` (line 42)
- `FilesTabHandle` (line 46)
- `TreeItemProps` (line 153)

**Functions:**
- `isBinaryFile` (line 66)
- `isImageFile` (line 71)
- `getLanguage` (line 77)
- `FileIcon` (line 127)
- `formatSize` (line 142)
- `TreeItem` (line 161)
- `refresh` (line 292)
- `onKanbanMove` (line 293)
- `toggle` (line 314)
- `findNode` (line 332)
- `inject` (line 356)

**Exports:**
- `FilesTab` (line 242)


### `src/mainview/components/analytics/charts.tsx`

**Interfaces:**
- `HoverTooltip` (line 8)
- `LineChartProps` (line 28)
- `BarChartProps` (line 111)
- `DonutChartProps` (line 201)
- `HeatmapProps` (line 281)
- `StatCardProps` (line 351)

**Functions:**
- `ChartTooltip` (line 14)
- `LineChart` (line 35)
- `BarChart` (line 117)
- `computeSlices` (line 208)
- `DonutChart` (line 219)
- `arcPath` (line 232)
- `ActivityHeatmap` (line 287)
- `showHour` (line 306)
- `StatCard` (line 358)
- `EmptyChart` (line 370)


### `src/mainview/components/chat/chat-input-popover.tsx`

**Interfaces:**
- `PopoverItem` (line 9)
- `UseInputPopoverOptions` (line 51)

**Functions:**
- `buildFileItem` (line 36)
- `useInputPopover` (line 61)

**Exports:**
- `SLASH_COMMANDS` (line 21)


### `src/mainview/components/chat/chat-input.tsx`

**Interfaces:**
- `ChatInputHandle` (line 31)
- `ChatInputProps` (line 37)
- `AttachmentFile` (line 83)

**Types:**
- `AttachmentType` (line 81)

**Functions:**
- `categorizeFile` (line 94)
- `processFiles` (line 112)
- `handleSlashSelect` (line 350)
- `handleFileSelect_mention` (line 411)
- `handleKeyDown` (line 534)

**Exports:**
- `TEXT_EXTENSIONS` (line 59)
- `IMAGE_EXTENSIONS` (line 70)
- `BINARY_DOC_EXTENSIONS` (line 75)
- `ChatInput` (line 136)


### `src/mainview/components/chat/chat-layout.tsx`

**Interfaces:**
- `ChatLayoutProps` (line 20)

**Functions:**
- `ChatLayout` (line 29)
- `handleMouseDown` (line 86)
- `onMouseMove` (line 365)
- `onMouseUp` (line 374)
- `onKeyDown` (line 385)


### `src/mainview/components/chat/code-block.tsx`

**Interfaces:**
- `CodeBlockProps` (line 7)

**Types:**
- `CodeBlockTheme` (line 5)

**Functions:**
- `getHighlighter` (line 24)
- `CodeBlock` (line 52)
- `handleCopy` (line 84)


### `src/mainview/components/chat/context-indicator.tsx`

**Interfaces:**
- `ContextIndicatorProps` (line 9)

**Functions:**
- `estimateTokens` (line 21)
- `formatTokens` (line 25)
- `ContextIndicator` (line 31)


### `src/mainview/components/chat/conversation-cost.tsx`

**Interfaces:**
- `ConversationCostProps` (line 7)
- `TokenTotals` (line 12)

**Functions:**
- `sumTokens` (line 17)
- `formatTokens` (line 35)
- `ConversationCost` (line 41)


### `src/mainview/components/chat/conversation-sidebar.tsx`

**Interfaces:**
- `ConversationSidebarProps` (line 8)

**Functions:**
- `ConversationSidebar` (line 21)
- `exitSelectMode` (line 45)
- `toggleSelected` (line 50)
- `toggleSelectAll` (line 67)
- `handler` (line 94)
- `startRename` (line 99)
- `commitRename` (line 105)
- `handleContextMenu` (line 113)
- `isInArchivedList` (line 119)


### `src/mainview/components/chat/image-lightbox.tsx`

**Functions:**
- `ImageLightbox` (line 4)
- `onKey` (line 6)


### `src/mainview/components/chat/message-actions-context.tsx`

**Interfaces:**
- `MessageActions` (line 12)

**Functions:**
- `MessageActionsProvider` (line 22)
- `useMessageActions` (line 41)


### `src/mainview/components/chat/message-bubble.tsx`

**Interfaces:**
- `MessageBubbleProps` (line 23)

**Functions:**
- `SearchHighlight` (line 37)
- `highlightChildren` (line 56)
- `AttachmentPreviews` (line 67)
- `PlanApprovalFooter` (line 122)
- `handleApprove` (line 133)
- `handleReject` (line 138)
- `onPartCreated` (line 291)
- `onPartUpdated` (line 311)
- `handleCopy` (line 362)
- `handleDeleteClick` (line 368)
- `handleRetry` (line 370)
- `handleBranch` (line 380)
- `h` (line 394)

**Methods:**
- `code` (line 211)
- `code` (line 397)

**Exports:**
- `Message` (line 21)
- `MessageBubble` (line 255)


### `src/mainview/components/chat/message-list.tsx`

**Classes:**
- `MessageErrorBoundary` (line 11)

**Interfaces:**
- `MessageListProps` (line 64)

**Functions:**
- `MessageList` (line 78)
- `handler` (line 99)
- `scrollIfAtBottom` (line 206)
- `StreamingBubble` (line 368)
- `TypingRow` (line 377)
- `WaitingRow` (line 431)

**Methods:**
- `getDerivedStateFromError` (line 20)
- `render` (line 24)


### `src/mainview/components/chat/message-parts.tsx`

**Interfaces:**
- `MessagePartData` (line 23)
- `MessagePartsProps` (line 378)

**Functions:**
- `getAgentBorderColor` (line 60)
- `formatAgentDisplayName` (line 65)
- `ElapsedTimer` (line 118)
- `getAgentBadgeColor` (line 152)
- `TaskPromptCard` (line 159)

**Exports:**
- `ThinkingBlock` (line 84)
- `AGENT_BADGE_COLORS` (line 132)
- `TextBlock` (line 299)
- `MessageParts` (line 389)


### `src/mainview/components/chat/message-search.tsx`

**Interfaces:**
- `MessageSearchProps` (line 5)

**Functions:**
- `MessageSearch` (line 12)
- `handleKeyDown` (line 64)


### `src/mainview/components/chat/model-selector.tsx`

**Interfaces:**
- `ProviderModels` (line 10)
- `ModelSelectorProps` (line 24)

**Functions:**
- `ModelSelector` (line 29)


### `src/mainview/components/chat/plan-diff.tsx`

**Interfaces:**
- `DiffLine` (line 10)
- `SeparatorEntry` (line 19)
- `PlanDiffProps` (line 158)

**Types:**
- `DiffLineKind` (line 8)
- `CollapsedEntry` (line 24)

**Functions:**
- `buildLcsTable` (line 35)
- `buildDiff` (line 58)
- `collapseContext` (line 104)
- `PlanDiff` (line 164)


### `src/mainview/components/chat/prompts-dropdown.tsx`

**Interfaces:**
- `Prompt` (line 13)
- `PromptsDropdownProps` (line 21)

**Functions:**
- `PromptsDropdown` (line 26)


### `src/mainview/components/chat/shell-approval-card.tsx`

**Functions:**
- `formatAgentName` (line 9)
- `ShellApprovalCard` (line 15)
- `handleDecision` (line 19)


### `src/mainview/components/chat/tool-call-card.tsx`

**Interfaces:**
- `ToolCallPartData` (line 50)

**Functions:**
- `InlineImage` (line 32)
- `shortPath` (line 146)
- `truncate` (line 152)
- `parseInput` (line 156)
- `StateIcon` (line 161)
- `isImageTool` (line 176)
- `ToolInputDisplay` (line 258)
- `ToolOutputDisplay` (line 338)
- `PatchDiffCard` (line 428)
- `extToLang` (line 473)
- `detectLanguageFromContent` (line 489)
- `formatDuration` (line 509)
- `formatJson` (line 516)
- `unescapeTerminal` (line 525)
- `ansiToHtml` (line 530)
- `extractShellOutput` (line 567)
- `tryFormatJson` (line 581)

**Exports:**
- `ToolCallCard` (line 180)


### `src/mainview/components/command-palette.tsx`

**Interfaces:**
- `CommandPaletteProps` (line 49)
- `Project` (line 54)
- `SearchResult` (line 59)

**Functions:**
- `getRecentSearches` (line 30)
- `addRecentSearch` (line 39)
- `CommandPalette` (line 67)
- `runCommand` (line 115)
- `getSearchResultIcon` (line 120)
- `navigateToResult` (line 135)


### `src/mainview/components/dashboard/custom-agent-chat-launcher.tsx`

**Interfaces:**
- `ChatAgent` (line 5)

**Functions:**
- `CustomAgentChatLauncher` (line 23)


### `src/mainview/components/dashboard/custom-agent-chat-widget.tsx`

**Interfaces:**
- `ChatMessage` (line 19)
- `CustomAgentChatWidgetProps` (line 137)

**Functions:**
- `sessionStorageKey` (line 87)
- `messagesStorageKey` (line 88)
- `unreadStorageKey` (line 89)
- `loadPersistedUnread` (line 91)
- `persistUnread` (line 95)
- `loadPersistedSession` (line 102)
- `persistMessages` (line 123)
- `persistSessionId` (line 128)
- `CustomAgentChatWidget` (line 144)
- `onMouseDown` (line 221)
- `onChunk` (line 246)
- `onToolCall` (line 258)
- `onComplete` (line 267)
- `onError` (line 282)
- `handleKeyDown` (line 419)
- `handleClear` (line 431)

**Methods:**
- `code` (line 32)


### `src/mainview/components/dashboard/pm-chat-widget.tsx`

**Interfaces:**
- `ChatMessage` (line 19)

**Functions:**
- `loadPersistedUnread` (line 94)
- `persistUnread` (line 98)
- `loadPersistedSession` (line 105)
- `persistMessages` (line 124)
- `persistSessionId` (line 132)
- `PmChatWidget` (line 144)
- `handleMouseDown` (line 201)
- `onChunk` (line 235)
- `onToolCall` (line 249)
- `onComplete` (line 258)
- `onError` (line 272)
- `handleKeyDown` (line 429)
- `handleClear` (line 441)

**Methods:**
- `code` (line 33)


### `src/mainview/components/dashboard/project-card.tsx`

**Interfaces:**
- `Project` (line 25)
- `ProjectCardProps` (line 37)

**Types:**
- `BadgeStatus` (line 63)

**Functions:**
- `toStatus` (line 65)
- `ProjectCard` (line 70)
- `handleCardClick` (line 79)
- `handleDeleteClick` (line 84)
- `handleConfirmDelete` (line 89)


### `src/mainview/components/deploy/deploy-tab.tsx`

**Interfaces:**
- `DeployTabProps` (line 9)
- `Environment` (line 13)
- `DeployHistoryItem` (line 24)

**Functions:**
- `DeployTab` (line 48)
- `resetForm` (line 101)
- `startEdit` (line 106)
- `saveEnvironment` (line 116)
- `deleteEnvironment` (line 138)
- `confirmDeleteEnvironment` (line 143)
- `executeDeploy` (line 155)
- `formatDuration` (line 174)
- `formatDate` (line 180)


### `src/mainview/components/freelance/always-mounted-inbox.tsx`

**Functions:**
- `AlwaysMountedInbox` (line 26)
- `load` (line 35)
- `onSettings` (line 43)


### `src/mainview/components/freelance/auto-earn-help.tsx`

**Functions:**
- `Section` (line 12)
- `Callout` (line 21)
- `Faq` (line 29)
- `AutoEarnHelp` (line 41)


### `src/mainview/components/freelance/auto-earn-settings.tsx`

**Interfaces:**
- `Props` (line 100)

**Functions:**
- `HelpIcon` (line 21)
- `AutonomyHelpModal` (line 45)
- `AutoEarnSettings` (line 105)
- `patch` (line 106)
- `num` (line 108)
- `Field` (line 339)


### `src/mainview/components/freelance/expert-dashboard.tsx`

**Functions:**
- `ExpertDashboard` (line 17)
- `on` (line 35)
- `openTimeline` (line 48)
- `resolve` (line 53)
- `resolveAll` (line 57)
- `approveDelivery` (line 61)
- `Metric` (line 171)
- `formatMinutes` (line 192)


### `src/mainview/components/freelance/find-workable-modal.tsx`

**Interfaces:**
- `ProgressItem` (line 15)
- `BudgetDisplay` (line 26)
- `FindWorkableModalProps` (line 427)

**Types:**
- `WizardStep` (line 13)

**Functions:**
- `convertAmount` (line 32)
- `fmt` (line 47)
- `buildBudgetDisplay` (line 51)
- `ConfigStep` (line 101)
- `AnalyzingStep` (line 157)
- `FailedListingRow` (line 245)
- `ResultsStep` (line 280)
- `FindWorkableModal` (line 433)
- `onProgress` (line 476)
- `onComplete` (line 500)
- `onError` (line 511)
- `onStopped` (line 517)


### `src/mainview/components/freelance/freelance-chat-modal.tsx`

**Interfaces:**
- `StreamingMessage` (line 62)
- `ErrorMessage` (line 69)
- `FreelanceChatModalProps` (line 266)

**Types:**
- `DisplayMessage` (line 75)

**Functions:**
- `isStreaming` (line 77)
- `isError` (line 81)
- `CopyButton` (line 137)
- `handleCopy` (line 140)
- `FetchingBubble` (line 165)
- `MessageBubble` (line 181)
- `FreelanceChatModal` (line 272)
- `onFetching` (line 354)
- `onFetchDone` (line 360)
- `onToolStart` (line 366)
- `onToolDone` (line 377)
- `onToken` (line 389)
- `onComplete` (line 398)
- `onError` (line 415)
- `onStopped` (line 427)
- `handleKeyDown` (line 496)
- `handleClear` (line 536)

**Methods:**
- `code` (line 90)


### `src/mainview/components/freelance/inbox-tab.tsx`

**Types:**
- `WebviewTagEl` (line 153)

**Functions:**
- `parseHostMessage` (line 162)
- `AutoGrowTextarea` (line 180)
- `navUrl` (line 230)
- `hourInTz` (line 243)
- `fmtTime` (line 255)
- `InboxTab` (line 264)
- `maybeFetchProfileSkills` (line 487)
- `inject` (line 498)
- `onNav` (line 509)
- `onHostMessage` (line 521)
- `onUpdated` (line 625)
- `onOutbox` (line 630)
- `onStatus` (line 631)
- `withinActiveHours` (line 660)
- `schedule` (line 666)
- `tick` (line 709)
- `selectThread` (line 739)
- `syncNow` (line 748)
- `setAutonomy` (line 756)
- `disconnect` (line 760)


### `src/mainview/components/freelance/keyword-input.tsx`

**Interfaces:**
- `KeywordInputProps` (line 6)

**Functions:**
- `KeywordInput` (line 13)
- `addKeyword` (line 22)
- `removeKeyword` (line 30)
- `handleKeyDown` (line 34)
- `handleBlur` (line 43)


### `src/mainview/components/freelance/listing-card.tsx`

**Interfaces:**
- `BudgetDisplay` (line 78)
- `FreelanceListingCardProps` (line 341)

**Functions:**
- `convertAmount` (line 24)
- `fmtNum` (line 39)
- `relativeTime` (line 49)
- `formatFullDate` (line 62)
- `buildBudgetDisplay` (line 84)
- `getPlatformColor` (line 163)
- `PlatformBadge` (line 170)
- `SkillChips` (line 183)
- `AnalysisModal` (line 246)
- `FreelanceListingCard` (line 363)
- `onActive` (line 402)
- `onDone` (line 406)
- `handleApprove` (line 440)
- `handleShortlist` (line 449)
- `handleMarkDone` (line 459)
- `handleAnalyze` (line 469)
- `handleDelete` (line 476)
- `handleViewOnPlatform` (line 486)

**Methods:**
- `code` (line 212)


### `src/mainview/components/freelance/listings-tab.tsx`

**Types:**
- `StatusFilter` (line 22)

**Functions:**
- `ListingSkeleton` (line 28)
- `ListingsTab` (line 64)
- `loadAutoEarn` (line 100)
- `onScroll` (line 124)
- `handler` (line 172)
- `handler` (line 180)
- `handleFetchNow` (line 203)
- `handleDeleteSelected` (line 303)
- `handleFilterChange` (line 322)
- `handleSearchChange` (line 328)


### `src/mainview/components/freelance/session-webview-host.ts`

**Types:**
- `SessionWebview` (line 22)

**Functions:**
- `runtimeAvailable` (line 35)
- `getSessionWebview` (line 40)
- `syncRect` (line 67)
- `startSync` (line 82)
- `loop` (line 84)
- `stopSync` (line 91)
- `attachSessionWebview` (line 97)
- `detachSessionWebview` (line 112)
- `setSessionWebviewVisible` (line 126)


### `src/mainview/components/freelance/settings-tab.tsx`

**Interfaces:**
- `RssSource` (line 57)
- `ProviderItem` (line 63)
- `SettingsState` (line 69)

**Functions:**
- `CurrencyCombobox` (line 117)
- `handle` (line 141)
- `SettingsTab` (line 223)
- `load` (line 241)
- `formatLastRun` (line 357)


### `src/mainview/components/git/branch-list.tsx`

**Interfaces:**
- `Branch` (line 6)
- `BranchListProps` (line 8)

**Functions:**
- `BranchList` (line 14)
- `handleCreate` (line 20)
- `handleSwitch` (line 29)
- `handleDelete` (line 34)


### `src/mainview/components/git/branch-strategy.tsx`

**Interfaces:**
- `BranchStrategyProps` (line 5)

**Types:**
- `Strategy` (line 10)

**Functions:**
- `BranchStrategy` (line 18)
- `handleSave` (line 51)
- `loadMergedBranches` (line 70)
- `handleCleanup` (line 80)


### `src/mainview/components/git/commit-log.tsx`

**Interfaces:**
- `Commit` (line 5)
- `CommitFile` (line 6)
- `CommitLogProps` (line 76)

**Functions:**
- `CommitRow` (line 16)
- `handleToggle` (line 21)
- `CommitLog` (line 81)


### `src/mainview/components/git/conflict-resolver.tsx`

**Interfaces:**
- `ConflictResolverProps` (line 7)

**Functions:**
- `ConflictResolver` (line 11)
- `onStreamComplete` (line 45)
- `handleAbort` (line 50)
- `handleResolveWithAI` (line 63)
- `colorizeConflictDiff` (line 166)


### `src/mainview/components/git/diff-viewer.tsx`

**Interfaces:**
- `DiffLine` (line 8)
- `DiffHunk` (line 15)
- `DiffFile` (line 20)

**Functions:**
- `parseGitDiff` (line 30)
- `FileBadge` (line 103)
- `FileDiff` (line 113)
- `DiffViewer` (line 194)


### `src/mainview/components/git/git-tab.tsx`

**Interfaces:**
- `GitTabProps` (line 14)

**Types:**
- `GitSubTab` (line 12)

**Functions:**
- `GitTab` (line 22)
- `saveAutoCommitSettings` (line 70)
- `handlePull` (line 79)
- `handlePullWithBranch` (line 100)


### `src/mainview/components/git/pull-requests.tsx`

**Interfaces:**
- `PullRequestsProps` (line 10)

**Types:**
- `PR` (line 7)
- `Comment` (line 8)

**Functions:**
- `stateColor` (line 18)
- `PrDetail` (line 27)
- `handleMerge` (line 42)
- `handleAddComment` (line 55)
- `handleDeleteComment` (line 68)
- `CreatePrForm` (line 217)
- `handleGenerate` (line 260)
- `handleCreate` (line 271)
- `PullRequests` (line 369)
- `toggleFeatureBranches` (line 383)


### `src/mainview/components/git/staged-files.tsx`

**Interfaces:**
- `FileStatus` (line 26)
- `StagedFilesProps` (line 28)

**Functions:**
- `PushDialog` (line 5)
- `StagedFiles` (line 34)
- `toggle` (line 41)
- `showFeedback` (line 47)
- `handleCommit` (line 52)
- `handlePush` (line 73)
- `toggleAll` (line 90)


### `src/mainview/components/inbox/inbox-rules-editor.tsx`

**Interfaces:**
- `InboxRule` (line 23)
- `RuleCondition` (line 34)
- `RuleAction` (line 40)
- `NativeSelectProps` (line 143)
- `ActionValueInputProps` (line 169)
- `RuleFormProps` (line 229)
- `RuleRowProps` (line 524)
- `InboxRulesEditorProps` (line 644)

**Functions:**
- `parseConditions` (line 85)
- `parseActions` (line 94)
- `summarizeConditions` (line 103)
- `summarizeActions` (line 110)
- `makeEmptyCondition` (line 131)
- `makeEmptyAction` (line 135)
- `NativeSelect` (line 148)
- `ActionValueInput` (line 174)
- `RuleForm` (line 246)
- `updateCondition` (line 260)
- `removeCondition` (line 269)
- `updateAction` (line 273)
- `removeAction` (line 293)
- `handleSubmit` (line 297)
- `RuleRow` (line 533)
- `InboxRulesEditor` (line 649)
- `handleToggle` (line 689)
- `handleDelete` (line 704)
- `handleSaveNew` (line 723)
- `handleSaveEdit` (line 761)
- `handleEditClick` (line 802)
- `handleCancelForm` (line 807)


### `src/mainview/components/issue-fixer/issue-fixer-settings.tsx`

**Interfaces:**
- `KeywordDef` (line 30)

**Types:**
- `FormState` (line 45)

**Functions:**
- `OptionHelp` (line 48)
- `Row` (line 115)
- `IssueFixerSettingsTab` (line 151)
- `update` (line 219)
- `toggleKeyword` (line 224)
- `addCustomKeyword` (line 232)
- `addLabel` (line 243)
- `isPredefined` (line 272)


### `src/mainview/components/issue-fixer/issue-fixer-tab.tsx`

**Functions:**
- `toPartData` (line 18)
- `statusVariant` (line 36)
- `IssueFixerProjectTab` (line 43)
- `h` (line 144)


### `src/mainview/components/issues/issue-tracker-tab.tsx`

**Types:**
- `IssueTrackerView` (line 7)

**Functions:**
- `IssueTrackerTab` (line 19)


### `src/mainview/components/issues/issues.tsx`

**Interfaces:**
- `IssuesProps` (line 65)

**Types:**
- `TaskLite` (line 36)
- `BucketGroupT` (line 337)

**Functions:**
- `looksLikeHtml` (line 39)
- `stripHtml` (line 43)
- `displayBody` (line 60)
- `stateColor` (line 86)
- `IssueCard` (line 94)
- `onSelectTask` (line 121)
- `onCreateKanbanTask` (line 133)
- `formatSourceId` (line 308)
- `ConfigureDialog` (line 316)
- `requiredFilled` (line 342)
- `setField` (line 399)
- `toggleBucket` (line 409)
- `toggleGroupBuckets` (line 418)
- `handleTest` (line 429)
- `handleSave` (line 449)
- `handleRemove` (line 468)
- `ConnectPicker` (line 606)
- `Issues` (line 653)
- `handleSync` (line 740)


### `src/mainview/components/kanban/kanban-board.tsx`

**Interfaces:**
- `KanbanBoardProps` (line 28)

**Functions:**
- `KanbanBoard` (line 34)


### `src/mainview/components/kanban/kanban-card.tsx`

**Interfaces:**
- `KanbanCardProps` (line 17)

**Functions:**
- `KanbanCard` (line 22)


### `src/mainview/components/kanban/kanban-column.tsx`

**Interfaces:**
- `KanbanColumnProps` (line 25)

**Functions:**
- `KanbanColumn` (line 32)


### `src/mainview/components/kanban/kanban-filters.tsx`

**Interfaces:**
- `KanbanFiltersProps` (line 8)

**Types:**
- `SortOption` (line 5)
- `PriorityFilter` (line 6)

**Functions:**
- `KanbanFilters` (line 36)


### `src/mainview/components/kanban/kanban-stats-bar.tsx`

**Interfaces:**
- `StatIndicatorProps` (line 4)

**Functions:**
- `StatIndicator` (line 11)
- `KanbanStatsBar` (line 23)


### `src/mainview/components/kanban/task-detail-modal.tsx`

**Interfaces:**
- `AcceptanceCriterionItem` (line 25)
- `TaskDetailModalProps` (line 30)

**Functions:**
- `parseCriteria` (line 85)
- `Section` (line 114)
- `TaskDetailModal` (line 140)
- `saveTitle` (line 191)
- `saveDescription` (line 197)
- `saveImportantNotes` (line 202)
- `saveDueDate` (line 207)
- `savePriority` (line 213)
- `saveColumn` (line 218)
- `toggleCriterion` (line 224)
- `addCriterion` (line 235)
- `removeCriterion` (line 245)
- `handleDelete` (line 251)
- `confirmDelete` (line 255)
- `createGithubIssue` (line 260)


### `src/mainview/components/layout/app-shell.tsx`

**Functions:**
- `AppShell` (line 97)
- `AppShellContent` (line 105)
- `onSettingChanged` (line 135)
- `onFocusEnter` (line 141)
- `onFocusExit` (line 142)
- `handler` (line 234)
- `onFocus` (line 272)
- `onBlur` (line 273)


### `src/mainview/components/layout/project-branch-badge.tsx`

**Functions:**
- `ProjectBranchBadge` (line 15)
- `onWake` (line 38)


### `src/mainview/components/layout/project-switcher.tsx`

**Interfaces:**
- `Project` (line 15)
- `ProjectSwitcherProps` (line 21)

**Functions:**
- `ProjectSwitcher` (line 25)
- `handleSelect` (line 38)
- `handleGoToDashboard` (line 45)


### `src/mainview/components/layout/sidebar.tsx`

**Interfaces:**
- `NavItem` (line 35)
- `SidebarProps` (line 44)

**Types:**
- `UpdateState` (line 136)

**Functions:**
- `NavItemButton` (line 62)
- `resolveIcon` (line 132)
- `Sidebar` (line 138)
- `fetchUnread` (line 170)
- `handler` (line 184)
- `fetchExtensions` (line 194)
- `handler` (line 229)
- `handler` (line 240)
- `handler` (line 270)
- `handleVersionClick` (line 279)
- `handleDownload` (line 309)
- `handleApply` (line 321)


### `src/mainview/components/layout/topnav.tsx`

**Interfaces:**
- `TopNavProps` (line 7)

**Functions:**
- `TopNav` (line 18)


### `src/mainview/components/modals/new-project-modal.tsx`

**Interfaces:**
- `NewProjectModalProps` (line 19)
- `FormState` (line 25)

**Functions:**
- `NewProjectModal` (line 41)
- `updateField` (line 92)
- `validate` (line 99)
- `handleBrowse` (line 114)
- `onResult` (line 117)
- `handleSubmit` (line 135)
- `handleOpenChange` (line 173)


### `src/mainview/components/modals/startup-health-dialog.tsx`

**Interfaces:**
- `HealthStatus` (line 31)
- `RowProps` (line 76)

**Types:**
- `Level` (line 45)

**Functions:**
- `toLevel` (line 47)
- `LevelIcon` (line 53)
- `isAllHealthy` (line 60)
- `Row` (line 85)
- `StartupHealthDialog` (line 129)


### `src/mainview/components/modals/user-question-dialog.tsx`

**Interfaces:**
- `UserQuestionPayload` (line 16)

**Functions:**
- `buildAgentLabel` (line 35)
- `UserQuestionDialog` (line 39)
- `handler` (line 47)
- `cancelHandler` (line 54)
- `QuestionForm` (line 98)


### `src/mainview/components/modals/whats-new-dialog.tsx`

**Interfaces:**
- `WhatsNewDialogProps` (line 7)

**Functions:**
- `WhatsNewDialog` (line 12)


### `src/mainview/components/notes/note-editor.tsx`

**Interfaces:**
- `NoteEditorProps` (line 9)

**Types:**
- `EditorMode` (line 17)

**Functions:**
- `NoteEditor` (line 19)
- `handleSave` (line 32)

**Methods:**
- `code` (line 84)


### `src/mainview/components/notes/notes-tab.tsx`

**Interfaces:**
- `Note` (line 19)
- `Plan` (line 29)
- `NotesTabProps` (line 41)

**Types:**
- `DocItem` (line 37)

**Functions:**
- `Highlight` (line 46)
- `highlightChildren` (line 66)
- `makeMdComponents` (line 74)
- `h` (line 75)
- `getItemKey` (line 129)
- `NotesTab` (line 133)
- `refresh` (line 230)
- `handleSelect` (line 239)
- `startEdit` (line 244)
- `startCreate` (line 255)
- `cancelEdit` (line 263)
- `handleSave` (line 271)
- `handleDelete` (line 292)

**Methods:**
- `code` (line 78)


### `src/mainview/components/project-settings/project-settings-tab.tsx`

**Interfaces:**
- `ProjectData` (line 44)
- `GeneralForm` (line 56)
- `AiForm` (line 65)
- `ProviderItem` (line 77)
- `FieldRowProps` (line 107)
- `DeleteConfirmDialogProps` (line 132)
- `GeneralTabProps` (line 284)
- `AiTabProps` (line 782)
- `ProjectSettingsTabProps` (line 1063)

**Functions:**
- `FieldRow` (line 114)
- `DeleteConfirmDialog` (line 139)
- `handleConfirm` (line 155)
- `ResetConfirmDialog` (line 224)
- `handleConfirm` (line 235)
- `GeneralTab` (line 289)
- `handleChange` (line 361)
- `handleBrowse` (line 369)
- `onResult` (line 373)
- `AiTab` (line 788)
- `handleChange` (line 812)
- `ProjectSettingsTab` (line 1067)
- `load` (line 1078)


### `src/mainview/components/remote-sync/connection-form.tsx`

**Functions:**
- `Row` (line 28)
- `RemoteConnectionForm` (line 42)
- `touch` (line 94)
- `onProtocolChange` (line 97)
- `addExclude` (line 126)
- `removeExclude` (line 132)


### `src/mainview/components/remote-sync/push-diff-dialog.tsx`

**Interfaces:**
- `FileDiff` (line 31)

**Functions:**
- `fmtBytes` (line 19)
- `PushFileRow` (line 41)
- `toggleOpen` (line 56)
- `PushDiffDialog` (line 130)
- `toggle` (line 180)
- `toggleAll` (line 190)
- `confirm` (line 195)


### `src/mainview/components/remote-sync/remote-sync-tab.tsx`

**Functions:**
- `selectionsEqual` (line 33)
- `key` (line 35)
- `runStatusVariant` (line 40)
- `ProgressView` (line 47)
- `RemoteSyncTab` (line 83)
- `onDone` (line 132)
- `onErr` (line 133)


### `src/mainview/components/remote-sync/remote-tree.tsx`

**Interfaces:**
- `TreeState` (line 17)

**Functions:**
- `abs` (line 8)
- `isAncestorOf` (line 13)
- `RemoteTree` (line 24)
- `toggleExpand` (line 86)
- `exactSelected` (line 100)
- `impliedSelected` (line 101)
- `toggleSelect` (line 103)
- `renderNodes` (line 113)


### `src/mainview/components/scheduler/automation-rule-card.tsx`

**Interfaces:**
- `AutomationRule` (line 12)
- `AutomationAction` (line 24)
- `AutomationRuleCardProps` (line 29)

**Functions:**
- `parseJson` (line 40)
- `extractEventType` (line 49)
- `summarizeActions` (line 54)
- `eventTypeBadgeClass` (line 71)
- `AutomationRuleCard` (line 83)


### `src/mainview/components/scheduler/automation-rule-form.tsx`

**Interfaces:**
- `TriggerCondition` (line 24)
- `TriggerConfig` (line 30)
- `ReminderConfig` (line 43)
- `ShellConfig` (line 48)
- `WebhookConfig` (line 53)
- `PmPromptConfig` (line 60)
- `AgentTaskConfig` (line 65)
- `SendChannelMessageConfig` (line 70)
- `NativeSelectProps` (line 178)
- `ActionConfigFieldsProps` (line 203)
- `AutomationRuleFormProps` (line 436)

**Types:**
- `ActionType` (line 35)
- `ActionConfig` (line 75)

**Functions:**
- `parseJson` (line 122)
- `makeTrigger` (line 131)
- `makeCondition` (line 135)
- `makeAction` (line 139)
- `triggerFromRule` (line 156)
- `actionsFromRule` (line 160)
- `triggerFromPrefill` (line 165)
- `actionsFromPrefill` (line 169)
- `NativeSelect` (line 182)
- `ActionConfigFields` (line 209)
- `AutomationRuleForm` (line 448)
- `setEventType` (line 489)
- `addCondition` (line 493)
- `updateCondition` (line 500)
- `removeCondition` (line 509)
- `addAction` (line 520)
- `changeActionType` (line 524)
- `updateAction` (line 530)
- `removeAction` (line 536)
- `handleSubmit` (line 544)


### `src/mainview/components/scheduler/automation-templates.tsx`

**Interfaces:**
- `AutomationTemplate` (line 16)
- `AutomationTemplatesProps` (line 22)
- `TemplateCardProps` (line 82)

**Functions:**
- `parseJson` (line 34)
- `extractEventType` (line 43)
- `buildDescription` (line 48)
- `eventBadgeClass` (line 71)
- `TemplateCard` (line 87)
- `TemplateSkeleton` (line 131)
- `AutomationTemplates` (line 146)
- `load` (line 153)


### `src/mainview/components/scheduler/cron-job-form.tsx`

**Interfaces:**
- `ProjectOption` (line 70)
- `CronJob` (line 75)
- `AgentOption` (line 92)
- `TaskConfig` (line 97)
- `CronJobFormProps` (line 116)
- `TaskFieldsProps` (line 172)

**Types:**
- `TaskType` (line 90)

**Functions:**
- `parseTaskConfig` (line 129)
- `buildTaskConfig` (line 137)
- `ProjectSelect` (line 180)
- `TaskFields` (line 196)
- `CronJobForm` (line 381)
- `validate` (line 438)
- `handleSave` (line 449)


### `src/mainview/components/scheduler/schedule-builder.tsx`

**Interfaces:**
- `VisualScheduleState` (line 29)
- `ScheduleBuilderProps` (line 37)
- `VisualEditorProps` (line 152)
- `CronEditorProps` (line 312)

**Types:**
- `ScheduleFrequency` (line 22)

**Functions:**
- `buildCronExpression` (line 68)
- `parseCronToVisual` (line 89)
- `friendlyFrequency` (line 138)
- `VisualEditor` (line 157)
- `set` (line 160)
- `toggleDay` (line 164)
- `CronEditor` (line 318)
- `ScheduleBuilder` (line 416)
- `handleVisualChange` (line 434)
- `handleModeChange` (line 440)


### `src/mainview/components/ui/agent-avatar.tsx`

**Interfaces:**
- `AgentAvatarProps` (line 6)

**Types:**
- `AvatarSize` (line 4)

**Functions:**
- `hashColor` (line 19)
- `stripInstanceId` (line 28)
- `humanizeName` (line 33)
- `deriveInitials` (line 40)
- `AgentAvatar` (line 52)


### `src/mainview/components/ui/badge.tsx`

**Interfaces:**
- `BadgeProps` (line 27)

**Functions:**
- `Badge` (line 31)

**Exports:**
- `Badge` (line 37)
- `badgeVariants` (line 37)


### `src/mainview/components/ui/button.tsx`

**Interfaces:**
- `ButtonProps` (line 38)

**Exports:**
- `Button` (line 58)
- `buttonVariants` (line 58)


### `src/mainview/components/ui/card.tsx`

**Exports:**
- `Card` (line 76)
- `CardHeader` (line 76)
- `CardFooter` (line 76)
- `CardTitle` (line 76)
- `CardDescription` (line 76)
- `CardContent` (line 76)


### `src/mainview/components/ui/command.tsx`

**Functions:**
- `CommandDialog` (line 24)
- `CommandShortcut` (line 125)

**Exports:**
- `Command` (line 141)
- `CommandDialog` (line 141)
- `CommandInput` (line 141)
- `CommandList` (line 141)
- `CommandEmpty` (line 141)
- `CommandGroup` (line 141)
- `CommandItem` (line 141)
- `CommandShortcut` (line 141)
- `CommandSeparator` (line 141)


### `src/mainview/components/ui/confirmation-dialog.tsx`

**Interfaces:**
- `ConfirmationDialogProps` (line 11)

**Functions:**
- `ConfirmationDialog` (line 23)
- `handleCancel` (line 34)
- `handleConfirm` (line 39)


### `src/mainview/components/ui/connection-status.tsx`

**Functions:**
- `ConnectionStatus` (line 10)
- `check` (line 15)


### `src/mainview/components/ui/dialog.tsx`

**Functions:**
- `DialogHeader` (line 55)
- `DialogFooter` (line 69)

**Exports:**
- `Dialog` (line 110)
- `DialogPortal` (line 110)
- `DialogOverlay` (line 110)
- `DialogTrigger` (line 110)
- `DialogClose` (line 110)
- `DialogContent` (line 110)
- `DialogHeader` (line 110)
- `DialogFooter` (line 110)
- `DialogTitle` (line 110)
- `DialogDescription` (line 110)


### `src/mainview/components/ui/dropdown-menu.tsx`

**Functions:**
- `DropdownMenuShortcut` (line 169)

**Exports:**
- `DropdownMenu` (line 182)
- `DropdownMenuTrigger` (line 182)
- `DropdownMenuContent` (line 182)
- `DropdownMenuItem` (line 182)
- `DropdownMenuCheckboxItem` (line 182)
- `DropdownMenuRadioItem` (line 182)
- `DropdownMenuLabel` (line 182)
- `DropdownMenuSeparator` (line 182)
- `DropdownMenuShortcut` (line 182)
- `DropdownMenuGroup` (line 182)
- `DropdownMenuPortal` (line 182)
- `DropdownMenuSub` (line 182)
- `DropdownMenuSubContent` (line 182)
- `DropdownMenuSubTrigger` (line 182)
- `DropdownMenuRadioGroup` (line 182)


### `src/mainview/components/ui/empty-state.tsx`

**Interfaces:**
- `EmptyStateProps` (line 5)

**Functions:**
- `EmptyState` (line 13)

**Exports:**
- `EmptyState` (line 41)
- `EmptyStateProps` (line 42)


### `src/mainview/components/ui/error-boundary.tsx`

**Classes:**
- `ErrorBoundary` (line 15)

**Interfaces:**
- `Props` (line 5)
- `State` (line 10)

**Methods:**
- `getDerivedStateFromError` (line 18)
- `componentDidCatch` (line 22)
- `render` (line 31)


### `src/mainview/components/ui/input.tsx`

**Types:**
- `InputProps` (line 5)

**Exports:**
- `Input` (line 24)


### `src/mainview/components/ui/kbd.tsx`

**Interfaces:**
- `KbdProps` (line 5)

**Functions:**
- `Kbd` (line 10)

**Exports:**
- `Kbd` (line 29)
- `KbdProps` (line 30)


### `src/mainview/components/ui/label.tsx`

**Exports:**
- `Label` (line 24)


### `src/mainview/components/ui/mermaid-diagram.tsx`

**Interfaces:**
- `MermaidDiagramProps` (line 26)

**Functions:**
- `getMermaid` (line 8)
- `MermaidDiagram` (line 37)


### `src/mainview/components/ui/model-input.tsx`

**Interfaces:**
- `ModelInputProps` (line 5)

**Functions:**
- `ModelInput` (line 15)


### `src/mainview/components/ui/password-input.tsx`

**Interfaces:**
- `PasswordInputProps` (line 6)

**Functions:**
- `toggle` (line 21)

**Exports:**
- `PasswordInput` (line 45)


### `src/mainview/components/ui/popover.tsx`

**Exports:**
- `Popover` (line 31)
- `PopoverTrigger` (line 31)
- `PopoverContent` (line 31)
- `PopoverAnchor` (line 31)


### `src/mainview/components/ui/resizable-pane.tsx`

**Interfaces:**
- `ResizablePaneProps` (line 10)

**Functions:**
- `ResizablePane` (line 18)
- `handleMouseMove` (line 45)
- `handleMouseUp` (line 53)


### `src/mainview/components/ui/scroll-area.tsx`

**Exports:**
- `ScrollArea` (line 46)
- `ScrollBar` (line 46)


### `src/mainview/components/ui/search-input.tsx`

**Interfaces:**
- `SearchInputProps` (line 7)

**Functions:**
- `SearchInput` (line 14)
- `handleClear` (line 22)

**Exports:**
- `SearchInput` (line 55)
- `SearchInputProps` (line 56)


### `src/mainview/components/ui/select.tsx`

**Exports:**
- `Select` (line 146)
- `SelectGroup` (line 146)
- `SelectValue` (line 146)
- `SelectTrigger` (line 146)
- `SelectContent` (line 146)
- `SelectLabel` (line 146)
- `SelectItem` (line 146)
- `SelectSeparator` (line 146)
- `SelectScrollUpButton` (line 146)
- `SelectScrollDownButton` (line 146)


### `src/mainview/components/ui/separator.tsx`

**Exports:**
- `Separator` (line 29)


### `src/mainview/components/ui/sheet.tsx`

**Interfaces:**
- `SheetContentProps` (line 50)

**Functions:**
- `SheetHeader` (line 75)
- `SheetFooter` (line 89)

**Exports:**
- `Sheet` (line 127)
- `SheetPortal` (line 127)
- `SheetOverlay` (line 127)
- `SheetTrigger` (line 127)
- `SheetClose` (line 127)
- `SheetContent` (line 127)
- `SheetHeader` (line 127)
- `SheetFooter` (line 127)
- `SheetTitle` (line 127)
- `SheetDescription` (line 127)


### `src/mainview/components/ui/skeleton.tsx`

**Functions:**
- `Skeleton` (line 3)
- `SkeletonCard` (line 12)
- `SkeletonLine` (line 26)

**Exports:**
- `Skeleton` (line 34)
- `SkeletonCard` (line 34)
- `SkeletonLine` (line 34)


### `src/mainview/components/ui/status-badge.tsx`

**Interfaces:**
- `StatusBadgeProps` (line 6)

**Types:**
- `Status` (line 3)
- `Size` (line 4)

**Functions:**
- `StatusBadge` (line 49)


### `src/mainview/components/ui/switch.tsx`

**Exports:**
- `Switch` (line 27)


### `src/mainview/components/ui/tabs.tsx`

**Exports:**
- `Tabs` (line 53)
- `TabsList` (line 53)
- `TabsTrigger` (line 53)
- `TabsContent` (line 53)


### `src/mainview/components/ui/textarea.tsx`

**Types:**
- `TextareaProps` (line 5)

**Exports:**
- `Textarea` (line 23)


### `src/mainview/components/ui/toast.tsx`

**Interfaces:**
- `Toast` (line 11)
- `ToastStore` (line 17)
- `ToastItemProps` (line 82)

**Functions:**
- `toast` (line 38)
- `ToastItem` (line 87)
- `Toaster` (line 152)

**Exports:**
- `useToastStore` (line 23)


### `src/mainview/components/ui/tooltip.tsx`

**Functions:**
- `Tip` (line 35)

**Exports:**
- `Tooltip` (line 54)
- `TooltipTrigger` (line 54)
- `TooltipContent` (line 54)
- `TooltipProvider` (line 54)
- `Tip` (line 54)


### `src/mainview/components/ui/unified-diff.tsx`

**Interfaces:**
- `DiffLine` (line 10)

**Functions:**
- `shortPath` (line 17)
- `computeUnifiedDiff` (line 23)
- `computeInlineHighlights` (line 66)
- `computeCharHighlights` (line 94)
- `HighlightedContent` (line 121)
- `UnifiedDiffCard` (line 146)


### `src/mainview/components/ui/unread-dot.tsx`

**Functions:**
- `UnreadDot` (line 11)


### `src/mainview/lib/date-utils.ts`

**Functions:**
- `parseDbDate` (line 9)
- `relativeTime` (line 20)
- `relativeTimeVerbose` (line 46)
- `formatDateTime` (line 59)
- `relativeTimeFuture` (line 75)


### `src/mainview/lib/global-error-handler.ts`

**Functions:**
- `initClientErrorHandler` (line 10)


### `src/mainview/lib/header-context.tsx`

**Interfaces:**
- `HeaderContextValue` (line 11)

**Functions:**
- `HeaderProvider` (line 21)
- `useHeaderActions` (line 65)
- `useHeaderContext` (line 80)


### `src/mainview/lib/pricing.ts`

**Interfaces:**
- `ModelPrice` (line 8)

**Functions:**
- `getModelPrice` (line 54)
- `estimateCost` (line 69)
- `formatCost` (line 85)


### `src/mainview/lib/rpc.ts`

**Exports:**
- `electroview` (line 331)
- `rpc` (line 340)


### `src/mainview/lib/theme.ts`

**Types:**
- `Theme` (line 3)

**Functions:**
- `getStoredTheme` (line 6)
- `applyTheme` (line 10)
- `initTheme` (line 15)
- `setTheme` (line 19)
- `syncThemeFromDB` (line 27)


### `src/mainview/lib/types.ts`

**Interfaces:**
- `ActivityEvent` (line 6)

**Functions:**
- `assignActivityId` (line 38)


### `src/mainview/lib/use-agent-colors.ts`

**Functions:**
- `ensureFetched` (line 9)
- `useAgentColorMap` (line 24)


### `src/mainview/lib/use-conv-font-size.ts`

**Functions:**
- `useConvFontSize` (line 10)
- `zoomIn` (line 23)
- `zoomOut` (line 24)
- `reset` (line 25)

**Exports:**
- `CONV_FONT_SIZE_KEY` (line 8)


### `src/mainview/lib/utils.ts`

**Functions:**
- `cn` (line 4)
- `displayAgentName` (line 11)


### `src/mainview/main.tsx`

**Functions:**
- `stripHrefs` (line 13)


### `src/mainview/pages/agents.tsx`

**Interfaces:**
- `Agent` (line 33)
- `Provider` (line 51)
- `ToolDef` (line 77)
- `AgentToolsTabProps` (line 101)
- `AgentSettingsDialogProps` (line 310)
- `CreateAgentDialogProps` (line 744)
- `DeleteAgentDialogProps` (line 1048)
- `AgentCardProps` (line 1105)

**Functions:**
- `getInitials` (line 65)
- `AgentToolsTab` (line 107)
- `AgentSettingsDialog` (line 318)
- `handleSave` (line 368)
- `handleReset` (line 423)
- `CreateAgentDialog` (line 752)
- `resetForm` (line 765)
- `handleClose` (line 778)
- `handleCreate` (line 783)
- `DeleteAgentDialog` (line 1055)
- `handleDelete` (line 1060)
- `AgentCard` (line 1111)
- `AgentCardSkeleton` (line 1203)
- `AgentsPage` (line 1221)
- `openDialog` (line 1241)
- `closeDialog` (line 1246)
- `handleSaved` (line 1251)
- `openDeleteDialog` (line 1257)
- `closeDeleteDialog` (line 1262)
- `handleDeleted` (line 1267)
- `handleCreated` (line 1271)


### `src/mainview/pages/analytics.tsx`

**Types:**
- `ProjectStats` (line 14)
- `SubTab` (line 16)
- `LogEntry` (line 149)
- `LogEntryFull` (line 158)

**Functions:**
- `fmtHours` (line 20)
- `DashboardTab` (line 28)
- `formatSize` (line 163)
- `formatTokens` (line 169)
- `timeAgo` (line 174)
- `formatTime` (line 184)
- `agentColor` (line 211)
- `TokenBarChart` (line 217)
- `PromptDetailDialog` (line 307)
- `PromptsTab` (line 390)
- `init` (line 406)
- `Loading` (line 548)
- `NoData` (line 556)
- `AnalyticsPage` (line 565)


### `src/mainview/pages/council.tsx`

**Interfaces:**
- `AgentInfo` (line 20)
- `Message` (line 26)
- `CouncilEvent` (line 51)

**Types:**
- `SessionState` (line 17)
- `AgentState` (line 18)

**Functions:**
- `ThinkingDots` (line 163)
- `QuestionCard` (line 187)
- `handleSubmit` (line 198)
- `MessageBubble` (line 240)
- `handleCopy` (line 251)
- `handleDownload` (line 258)
- `CouncilPage` (line 488)
- `handleSend` (line 783)
- `handleAnswer` (line 832)
- `handleStop` (line 839)

**Methods:**
- `code` (line 93)


### `src/mainview/pages/dashboard.tsx`

**Interfaces:**
- `Project` (line 21)

**Types:**
- `SortKey` (line 33)
- `StatusFilter` (line 34)

**Functions:**
- `DashboardPage` (line 36)
- `toggleCardsCollapsed` (line 57)
- `fetchCounts` (line 109)
- `handleDeleteProject` (line 187)
- `handlePermanentDeleteProject` (line 201)
- `handleRestoreProject` (line 216)
- `handleStatusChange` (line 230)
- `ProjectGridSkeleton` (line 414)


### `src/mainview/pages/freelance.tsx`

**Functions:**
- `FreelancePage` (line 18)
- `load` (line 33)
- `onSettings` (line 38)
- `onOpenInbox` (line 42)


### `src/mainview/pages/inbox.tsx`

**Interfaces:**
- `InboxMessage` (line 48)
- `Project` (line 64)
- `MessageDetailDialogProps` (line 127)
- `BulkActionBarProps` (line 313)

**Types:**
- `ChannelFilter` (line 69)
- `CategoryFilter` (line 70)
- `ReadFilter` (line 71)
- `ArchiveFilter` (line 72)

**Functions:**
- `getChannelSource` (line 78)
- `getSourceBadgeStyle` (line 82)
- `getSourceLabel` (line 92)
- `MessageRowSkeleton` (line 106)
- `MessageDetailDialog` (line 137)
- `BulkActionBar` (line 321)
- `InboxPage` (line 353)
- `handler` (line 439)
- `handleMarkAsRead` (line 481)
- `handleRowClick` (line 494)
- `handleDeleteMessage` (line 500)
- `handleArchiveMessage` (line 514)
- `handleMarkAllRead` (line 535)
- `toggleSelect` (line 551)
- `toggleSelectAll` (line 560)
- `handleBulkMarkRead` (line 574)
- `handleBulkArchive` (line 587)
- `handleBulkDelete` (line 601)


### `src/mainview/pages/onboarding.tsx`

**Interfaces:**
- `FormData` (line 32)
- `ValidationState` (line 42)

**Types:**
- `ProviderType` (line 29)
- `WizardStep` (line 30)

**Functions:**
- `isValidEmail` (line 80)
- `isValidUrl` (line 84)
- `normalizeBaseUrl` (line 97)
- `StepIndicator` (line 118)
- `StepWelcome` (line 179)
- `handleImportClick` (line 188)
- `StepAboutYou` (line 264)
- `handleBrowseWorkspace` (line 286)
- `onResult` (line 287)
- `StepSelectProvider` (line 382)
- `StepConfigure` (line 472)
- `fetchModels` (line 513)
- `StepValidate` (line 697)
- `StepConfirmation` (line 780)
- `OnboardingPage` (line 855)
- `goNext` (line 876)
- `goBack` (line 878)
- `updateForm` (line 881)
- `validate` (line 908)
- `onResult` (line 943)
- `handleImportSettings` (line 991)
- `parseSetting` (line 1016)
- `handleProviderSelect` (line 1049)
- `handleRetry` (line 1055)
- `handleFinish` (line 1077)


### `src/mainview/pages/playground.tsx`

**Functions:**
- `toPartData` (line 53)
- `pick` (line 84)
- `buildLandingPagePrompt` (line 136)
- `buildChartPrompt` (line 173)
- `buildDashboardPrompt` (line 204)
- `buildInvoicePrompt` (line 234)
- `buildPaintPrompt` (line 253)
- `buildMapPrompt` (line 274)
- `PlaygroundPage` (line 331)
- `onRunStarted` (line 353)
- `onPart` (line 354)
- `onPartUpdated` (line 358)
- `onAgentComplete` (line 368)
- `onRunComplete` (line 376)
- `onRunError` (line 384)
- `onPreviewReady` (line 392)
- `onRejected` (line 396)
- `onReset` (line 400)
- `onFilesChanged` (line 406)
- `onMessage` (line 412)
- `matches` (line 633)
- `ErrorBlock` (line 1063)
- `Transcript` (line 1102)
- `getSourceLang` (line 1128)
- `SourceDialog` (line 1141)
- `startEdit` (line 1166)
- `cancelEdit` (line 1172)
- `handleSave` (line 1177)
- `handleOpenChange` (line 1192)
- `SourceViewer` (line 1248)
- `RejectionCard` (line 1312)
- `EmptyState` (line 1328)


### `src/mainview/pages/plugin-db-viewer.tsx`

**Types:**
- `TableMeta` (line 13)
- `Row` (line 14)

**Functions:**
- `colLabel` (line 17)
- `formatDbDateTime` (line 25)
- `cellDisplay` (line 47)
- `RowViewDialog` (line 54)
- `DbViewerPage` (line 96)
- `handleDelete` (line 147)


### `src/mainview/pages/plugins.tsx`

**Interfaces:**
- `PluginInfo` (line 16)
- `PluginSettingsDialogProps` (line 35)
- `PluginPromptDialogProps` (line 183)
- `LspServerStatus` (line 257)

**Functions:**
- `formatSettingLabel` (line 42)
- `groupSettings` (line 52)
- `PluginSettingsDialog` (line 71)
- `handleChange` (line 75)
- `handleSave` (line 79)
- `renderField` (line 85)
- `PluginPromptDialog` (line 189)
- `handleSave` (line 195)
- `handleReset` (line 207)
- `statusBadge` (line 266)
- `LspManagerCard` (line 283)
- `handleInstall` (line 304)
- `handleUninstall` (line 318)
- `handleToggleLanguage` (line 331)
- `PluginsPage` (line 461)
- `handleToggle` (line 474)
- `handleSettingsSave` (line 482)


### `src/mainview/pages/project.tsx`

**Interfaces:**
- `PluginTab` (line 24)

**Types:**
- `ProjectTab` (line 22)

**Functions:**
- `ProjectPage` (line 31)
- `handler` (line 77)
- `handleCreateTask` (line 172)


### `src/mainview/pages/prompts.tsx`

**Interfaces:**
- `Prompt` (line 14)

**Functions:**
- `PromptForm` (line 24)
- `handleSubmit` (line 38)
- `PromptsPage` (line 96)
- `handleSave` (line 128)
- `handleDelete` (line 140)
- `PromptCard` (line 293)


### `src/mainview/pages/scheduler.tsx`

**Interfaces:**
- `CronJobHistoryEntry` (line 42)
- `HistorySectionProps` (line 169)
- `CronJobCardProps` (line 314)
- `CronJobsTabProps` (line 494)
- `AutomationRulesTabProps` (line 598)

**Functions:**
- `humanizeCron` (line 57)
- `getTaskTypeLabel` (line 85)
- `CronJobCardSkeleton` (line 102)
- `LastRunBadge` (line 129)
- `HistorySection` (line 175)
- `load` (line 186)
- `handleClear` (line 210)
- `CronJobCard` (line 322)
- `handleRunNow` (line 327)
- `handleToggle` (line 344)
- `CronJobsTab` (line 504)
- `handleClearAll` (line 515)
- `AutomationRulesTab` (line 608)
- `SchedulerPage` (line 681)
- `handleAddJob` (line 742)
- `handleEditJob` (line 747)
- `handleDeleteJob` (line 752)
- `confirmDeleteJob` (line 757)
- `handleToggleEnabled` (line 772)
- `handleAddRule` (line 788)
- `handleEditRule` (line 794)
- `handleDeleteRule` (line 800)
- `confirmDeleteRule` (line 805)
- `handleToggleRule` (line 820)
- `handleUseTemplate` (line 833)


### `src/mainview/pages/settings.tsx`

**Functions:**
- `SubTabs` (line 22)
- `SettingsPage` (line 47)


### `src/mainview/pages/settings/ai-debug.tsx`

**Functions:**
- `AiDebugSettings` (line 16)
- `load` (line 25)
- `handleToggle` (line 50)
- `handleClear` (line 63)
- `handleOpen` (line 76)


### `src/mainview/pages/settings/appearance.tsx`

**Types:**
- `SidebarDefault` (line 20)

**Functions:**
- `AppearanceSettings` (line 22)
- `handler` (line 48)
- `handleThemeSelect` (line 58)


### `src/mainview/pages/settings/audit-log.tsx`

**Interfaces:**
- `AuditEntry` (line 21)

**Functions:**
- `AuditLogSettings` (line 44)


### `src/mainview/pages/settings/constitution.tsx`

**Functions:**
- `ConstitutionSettings` (line 33)
- `loadConstitution` (line 44)


### `src/mainview/pages/settings/data.tsx`

**Interfaces:**
- `ProjectOption` (line 291)

**Functions:**
- `DatabaseMaintenanceCard` (line 27)
- `BackupsCard` (line 131)
- `formatSize` (line 202)
- `SettingsExportImportCard` (line 300)
- `DataSettings` (line 382)


### `src/mainview/pages/settings/discord-settings.tsx`

**Interfaces:**
- `DiscordConfig` (line 22)
- `ParsedConfig` (line 32)
- `Project` (line 38)
- `Server` (line 43)
- `ConfigFormProps` (line 76)

**Types:**
- `BotStatus` (line 48)

**Functions:**
- `BotStatusIndicator` (line 54)
- `ConfigForm` (line 83)
- `DiscordSettings` (line 335)
- `parseConfig` (line 391)
- `projectName` (line 399)


### `src/mainview/pages/settings/email-settings.tsx`

**Interfaces:**
- `EmailChannel` (line 63)
- `ParsedEmailConfig` (line 73)
- `Project` (line 86)
- `ConfigFormProps` (line 218)

**Functions:**
- `parseEmailConfig` (line 95)
- `ToggleSwitch` (line 118)
- `PasswordInput` (line 167)
- `ConfigForm` (line 230)
- `EmailSettings` (line 629)
- `projectName` (line 680)


### `src/mainview/pages/settings/env-vars.tsx`

**Interfaces:**
- `AddRowProps` (line 23)
- `EnvRowProps` (line 82)

**Functions:**
- `AddRow` (line 27)
- `EnvRow` (line 88)
- `EnvVarsSettings` (line 214)


### `src/mainview/pages/settings/general.tsx`

**Interfaces:**
- `UserProfile` (line 29)
- `ApplicationSettings` (line 34)
- `FieldRowProps` (line 183)

**Functions:**
- `isValidEmail` (line 53)
- `ResetApplicationCard` (line 97)
- `FieldRow` (line 190)
- `GeneralSettings` (line 208)
- `loadSettings` (line 220)
- `onResult` (line 400)


### `src/mainview/pages/settings/github.tsx`

**Interfaces:**
- `StatusIndicatorProps` (line 28)

**Types:**
- `ConnectionStatus` (line 22)

**Functions:**
- `StatusIndicator` (line 33)
- `GithubSettings` (line 81)


### `src/mainview/pages/settings/health.tsx`

**Interfaces:**
- `HealthStatus` (line 25)
- `SubsystemCardProps` (line 131)

**Types:**
- `StatusLevel` (line 67)

**Functions:**
- `resolveLevel` (line 69)
- `StatusIcon` (line 81)
- `StatusBadge` (line 89)
- `formatUptime` (line 110)
- `SubsystemCard` (line 139)
- `DatabaseCard` (line 172)
- `AiProviderCard` (line 220)
- `WorkspaceCard` (line 248)
- `SchedulerCard` (line 278)
- `IntegrationsCard` (line 326)
- `EnginesCard` (line 363)
- `BackendCard` (line 413)
- `HealthSettings` (line 428)


### `src/mainview/pages/settings/mcp.tsx`

**Interfaces:**
- `McpServer` (line 49)

**Types:**
- `McpServerStatus` (line 14)

**Functions:**
- `prettify` (line 35)
- `statusDot` (line 60)
- `statusLabel` (line 67)
- `ServerList` (line 75)
- `McpSettings` (line 129)
- `handleChange` (line 168)
- `handleSave` (line 187)
- `handleLoadTemplate` (line 202)


### `src/mainview/pages/settings/notification-settings.tsx`

**Interfaces:**
- `PlatformPref` (line 28)
- `ToggleRowProps` (line 140)
- `PlatformCardProps` (line 190)

**Types:**
- `PlatformKey` (line 22)
- `PrefsMap` (line 36)
- `DirtyMap` (line 37)

**Functions:**
- `buildDefaultPrefs` (line 50)
- `buildDefaultDirty` (line 56)
- `getMuteValue` (line 68)
- `muteValueToTimestamp` (line 92)
- `formatMuteRemaining` (line 116)
- `ToggleRow` (line 148)
- `PlatformCard` (line 199)
- `NotificationSettings` (line 277)
- `load` (line 297)


### `src/mainview/pages/settings/providers.tsx`

**Interfaces:**
- `Provider` (line 39)
- `FormData` (line 49)
- `ProviderCardProps` (line 182)
- `ProviderDialogProps` (line 324)

**Functions:**
- `isValidUrl` (line 89)
- `normalizeBaseUrl` (line 102)
- `providerTypeBadgeClass` (line 114)
- `providerTypeLabel` (line 118)
- `ProviderCardSkeleton` (line 130)
- `EmptyProviders` (line 159)
- `ProviderCard` (line 190)
- `ProviderDialog` (line 331)
- `updateField` (line 451)
- `handleSave` (line 455)
- `handleTestInDialog` (line 506)
- `handleCancel` (line 530)
- `ProvidersSettings` (line 748)
- `loadProviders` (line 767)
- `handleAdd` (line 786)
- `handleEdit` (line 791)
- `handleDeleteRequest` (line 796)
- `handleDeleteConfirm` (line 800)
- `handleTest` (line 819)
- `onResult` (line 823)


### `src/mainview/pages/settings/recommendations.tsx`

**Interfaces:**
- `DepMeta` (line 23)
- `CardStatus` (line 61)
- `DependencyCardProps` (line 225)

**Types:**
- `CardState` (line 59)

**Functions:**
- `buildInitialCards` (line 65)
- `applyCheckResult` (line 69)
- `RecommendationsSettings` (line 84)
- `handler` (line 116)
- `DependencyCard` (line 232)


### `src/mainview/pages/settings/tavily-settings.tsx`

**Types:**
- `KeyStatus` (line 18)

**Functions:**
- `StatusDot` (line 20)
- `TavilySettings` (line 37)


### `src/mainview/pages/settings/whatsapp-settings.tsx`

**Interfaces:**
- `WhatsAppConfig` (line 21)
- `Project` (line 31)
- `AddConfigFormProps` (line 77)

**Types:**
- `WhatsAppStatus` (line 36)

**Functions:**
- `ConnectionStatusIndicator` (line 49)
- `AddConfigForm` (line 83)
- `WhatsAppSettings` (line 188)
- `onQR` (line 232)
- `onStatus` (line 237)
- `projectName` (line 311)


### `src/mainview/pages/skills.tsx`

**Interfaces:**
- `SkillValidationError` (line 13)
- `SkillSummary` (line 18)
- `SkillDetail` (line 29)
- `ToolDef` (line 35)

**Functions:**
- `ToolsReferenceDialog` (line 41)
- `SkillCard` (line 97)
- `SkillDetailDialog` (line 202)
- `SkillErrorsDialog` (line 273)
- `SkillsPage` (line 301)

**Methods:**
- `code` (line 172)


### `src/mainview/router.tsx`

**Interfaces:**
- `Register` (line 141)

**Exports:**
- `router` (line 134)


### `src/mainview/stores/chat-event-handlers.ts`

**Functions:**
- `markStreamCompleted` (line 18)
- `flushTokenBuffer` (line 46)
- `onStreamToken` (line 83)
- `onStreamReset` (line 105)
- `onStreamComplete` (line 148)
- `resolveMetadata` (line 186)
- `onStreamError` (line 271)
- `onAgentStatus` (line 311)
- `onPlanPresented` (line 323)
- `onConversationTitleChanged` (line 347)
- `onConversationUpdated` (line 360)
- `onSwitchToConversation` (line 400)
- `bumpToTop` (line 414)
- `doSwitch` (line 425)
- `persistShellApprovalDecision` (line 443)
- `onNewMessage` (line 451)
- `onShellApprovalRequest` (line 513)
- `onAgentInlineStart` (line 534)
- `onAgentInlineComplete` (line 554)
- `onCompactionStarted` (line 599)
- `onConversationCompacted` (line 606)
- `onPmThinking` (line 627)
- `initChatEventHandlers` (line 655)

**Exports:**
- `buffers` (line 34)


### `src/mainview/stores/chat-store.ts`

**Interfaces:**
- `ChatState` (line 25)

**Functions:**
- `sortConversations` (line 98)

**Exports:**
- `ActiveInlineAgent` (line 13)
- `AgentStatusValue` (line 13)
- `Conversation` (line 13)
- `Message` (line 13)
- `ShellApprovalRequest` (line 13)
- `useChatStore` (line 134)


### `src/mainview/stores/chat-types.ts`

**Interfaces:**
- `Conversation` (line 8)
- `Message` (line 18)
- `ActiveInlineAgent` (line 36)
- `ShellApprovalRequest` (line 49)

**Types:**
- `AgentStatusValue` (line 42)

**Exports:**
- `ActivityEvent` (line 2)


### `src/mainview/stores/freelance-engine-store.ts`

**Interfaces:**
- `FreelanceEngineState` (line 18)

**Exports:**
- `useFreelanceEngineStore` (line 23)


### `src/mainview/stores/issue-fixer-store.ts`

**Interfaces:**
- `IssueFixerPart` (line 3)
- `IssueFixerRunState` (line 17)
- `IssueFixerStore` (line 30)
- `StartedDetail` (line 77)
- `PartDetail` (line 84)
- `PartUpdatedDetail` (line 89)
- `CompleteDetail` (line 95)
- `ErrorDetail` (line 102)

**Functions:**
- `initIssueFixerListeners` (line 111)
- `patch` (line 116)

**Exports:**
- `useIssueFixerStore` (line 38)


### `src/mainview/stores/kanban-store.ts`

**Interfaces:**
- `KanbanTask` (line 8)
- `KanbanState` (line 32)

**Types:**
- `KanbanColumn` (line 25)
- `TaskPriority` (line 26)

**Functions:**
- `sortTasksByPosition` (line 74)

**Exports:**
- `useKanbanStore` (line 93)


### `src/mainview/stores/message-queue.ts`

**Interfaces:**
- `QueuedMessage` (line 5)
- `MessageQueueState` (line 12)

**Exports:**
- `MESSAGE_QUEUE_MAX` (line 3)
- `useMessageQueueStore` (line 27)


### `src/mainview/stores/playground-store.ts`

**Interfaces:**
- `PlaygroundRejection` (line 5)
- `PlaygroundTokens` (line 10)
- `PlaygroundConsoleEntry` (line 16)
- `PlaygroundTurn` (line 21)
- `PlaygroundState` (line 26)

**Exports:**
- `usePlaygroundStore` (line 102)


### `src/mainview/stores/remote-sync-store.ts`

**Interfaces:**
- `RemoteSyncLogLine` (line 3)
- `RemoteSyncRunState` (line 9)
- `RemoteSyncStore` (line 23)
- `StartedDetail` (line 62)
- `ProgressDetail` (line 68)
- `CompleteDetail` (line 78)
- `ErrorDetail` (line 88)
- `LogDetail` (line 93)

**Functions:**
- `initRemoteSyncListeners` (line 104)

**Exports:**
- `useRemoteSyncStore` (line 34)


### `src/mainview/stores/unread-store.ts`

**Interfaces:**
- `UnreadStore` (line 16)

**Functions:**
- `key` (line 11)
- `hasUnread` (line 60)
- `hasUnreadPrefix` (line 63)
- `hasAnyUnread` (line 67)
- `initUnreadListeners` (line 73)

**Exports:**
- `useUnreadStore` (line 26)


## Data Flow

Router/Controller → Model/Schema

## Change Recipe

To add a new feature to the **mainview** domain:

1. Update the model/schema in `src/mainview/`
