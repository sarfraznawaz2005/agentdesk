# Domain: bun

**Directory:** `src/bun`
**Files:** 201
**Symbols:** 1568

## Files

### `src/bun/agents/agent-loop.ts`

**Interfaces:**
- `MessagePart` (line 108)
- `InlineAgentCallbacks` (line 123)
- `InlineAgentOptions` (line 133)
- `InlineAgentResult` (line 178)

**Functions:**
- `logAgent` (line 39)
- `toolResultIsError` (line 75)
- `buildThinkingOptions` (line 196)
- `filterReadOnlyTools` (line 245)
- `pruneToolOutput` (line 261)
- `pruneAgentToolResults` (line 319)
- `compactToolResultsInMessages` (line 376)
- `stripOldAssistantText` (line 411)
- `buildRuleBasedCompaction` (line 446)
- `aiCompactConversation` (line 584)
- `getHookCommand` (line 662)
- `wrapToolsWithHooks` (line 678)
- `shortPath` (line 746)
- `truncate` (line 752)
- `describeToolCall` (line 756)
- `runInlineAgent` (line 784)
- `wrapDirTool` (line 887)
- `hashToolCall` (line 1018)
- `onAbort` (line 1039)

**Exports:**
- `READ_ONLY_AGENTS` (line 239)


### `src/bun/agents/context-notes.ts`

**Functions:**
- `syncContextFilesAsNotes` (line 29)


### `src/bun/agents/context.ts`

**Interfaces:**
- `ContextOptions` (line 7)
- `BuiltContext` (line 15)

**Functions:**
- `estimateTokens` (line 24)
- `buildContext` (line 28)
- `shouldSummarize` (line 90)


### `src/bun/agents/engine-types.ts`

**Interfaces:**
- `MessageMetadata` (line 127)
- `AgentEngineCallbacks` (line 142)
- `PreviousFailureContext` (line 198)
- `QueueEntry` (line 204)

**Functions:**
- `getPluginTools` (line 10)
- `buildPMThinkingOptions` (line 34)
- `extractPMReasoning` (line 66)
- `applyAnthropicCaching` (line 100)

**Exports:**
- `THINKING_BUDGET_TOKENS` (line 28)
- `DEFAULT_METADATA` (line 136)


### `src/bun/agents/engine.ts`

**Classes:**
- `AgentEngine` (line 47)

**Functions:**
- `getPreviewPrompt` (line 6)
- `emit` (line 302)
- `emitActivity` (line 557)
- `emitThinking` (line 602)

**Methods:**
- `sendMessage` (line 86)
- `_runPMProcessing` (line 186)
- `stopAll` (line 945)
- `stopAllAndReset` (line 954)
- `isStopped` (line 960)
- `setAbortAgentsFn` (line 965)
- `getProjectId` (line 970)
- `isProcessing` (line 975)
- `getActiveConversationId` (line 980)
- `getActiveMetadata` (line 985)
- `getQueuedAgentsSnapshot` (line 990)
- `presentPlan` (line 997)
- `moveKanbanTask` (line 1004)
- `postDeterministicMessage` (line 1009)
- `invokePMWithEvent` (line 1020)
- `_handleStatusCommand` (line 1035)
- `getDefaultProviderRow` (line 1047)
- `_loadSummarizationThreshold` (line 1098)
- `triggerSummarization` (line 1110)
- `_touchConversation` (line 1147)
- `autoTitleConversation` (line 1176)

**Exports:**
- `MessageMetadata` (line 40)
- `AgentEngineCallbacks` (line 40)
- `QueueEntry` (line 40)


### `src/bun/agents/handoff.ts`

**Functions:**
- `generateHandoffSummary` (line 14)
- `buildDeterministicSummary` (line 69)


### `src/bun/agents/kanban-integration.ts`

**Classes:**
- `KanbanIntegration` (line 29)

**Interfaces:**
- `KanbanIntegrationCallbacks` (line 10)

**Methods:**
- `handleHumanMove` (line 48)
- `handleAgentMove` (line 104)
- `checkBlocked` (line 134)
- `logActivity` (line 195)
- `getProjectId` (line 222)


### `src/bun/agents/project-snapshot.ts`

**Functions:**
- `clearProjectSnapshotCache` (line 8)
- `getProjectSnapshot` (line 17)


### `src/bun/agents/prompt-logger.ts`

**Types:**
- `PromptLogEntry` (line 137)
- `PromptLogEntryFull` (line 183)

**Functions:**
- `refreshEnabled` (line 29)
- `isPromptLoggingEnabled` (line 38)
- `invalidatePromptLogCache` (line 44)
- `getPromptLogPath` (line 49)
- `rotateIfNeeded` (line 57)
- `estimateTokens` (line 70)
- `logPrompt` (line 82)
- `clearPromptLog` (line 124)
- `getPromptLogStats` (line 150)
- `getPromptLogEntry` (line 193)
- `openPromptLog` (line 239)


### `src/bun/agents/prompts.ts`

**Functions:**
- `loadConstitution` (line 13)
- `loadUserTimezone` (line 29)
- `cityFromTimezone` (line 46)
- `loadUserProfile` (line 55)
- `buildUserSection` (line 77)
- `buildUserProfileSection` (line 90)
- `loadAgentKnowledgeListing` (line 100)
- `isAgentKnowledgeUpdateEnabled` (line 132)
- `filterConstitution` (line 156)
- `extractFirstSentence` (line 217)
- `buildAgentsSection` (line 223)
- `clearWorkspaceInstructionsCache` (line 448)
- `loadWorkspaceInstructions` (line 456)
- `loadDecisionsFile` (line 491)
- `buildGitContext` (line 509)
- `buildProjectContextSection` (line 546)
- `buildProjectContext` (line 579)
- `buildDirectToolsSection` (line 610)
- `buildSkillsDescriptionSection` (line 640)
- `buildPMMcpSection` (line 688)
- `buildAgentMcpSection` (line 714)
- `isFeatureBranchWorkflowEnabled` (line 733)
- `getPMSystemPrompt` (line 781)
- `loadPluginPrompts` (line 992)
- `getAgentSystemPrompt` (line 1017)


### `src/bun/agents/review-cycle.ts`

**Functions:**
- `getMaxReviewRounds` (line 57)
- `getSubmitReviewDetails` (line 80)
- `reviewSummaryHasIssues` (line 118)
- `isAgentCancelled` (line 141)
- `triggerPMAutoContinue` (line 151)
- `spawnReviewAgent` (line 224)
- `ensureGitInit` (line 332)
- `autoCommitTask` (line 349)
- `notifyTaskInReview` (line 460)
- `isReviewActive` (line 637)
- `getActiveReviewCount` (line 645)


### `src/bun/agents/safety.ts`

**Interfaces:**
- `ActionRecord` (line 10)
- `SafetyConfig` (line 16)

**Functions:**
- `hashArgs` (line 48)
- `recordAction` (line 64)
- `clearAgentHistory` (line 104)
- `createActionTimeout` (line 118)
- `getBackoffDelay` (line 143)
- `isTransientError` (line 155)
- `loadSafetyConfig` (line 193)

**Exports:**
- `DEFAULT_CONFIG` (line 27)
- `agentWindows` (line 39)


### `src/bun/agents/summarizer.ts`

**Interfaces:**
- `PartRow` (line 216)

**Functions:**
- `summarizeConversation` (line 50)
- `chunkTranscript` (line 195)
- `buildPrunedContent` (line 224)
- `pruneToolResult` (line 242)
- `truncate` (line 309)
- `safeParseJson` (line 313)


### `src/bun/agents/tools/communication.ts`

**Exports:**
- `communicationTools` (line 5)


### `src/bun/agents/tools/file-ops.ts`

**Interfaces:**
- `PatchHunk` (line 602)

**Types:**
- `FileConflictCallback` (line 954)

**Functions:**
- `writeAndNotify` (line 15)
- `formatDiagnosticsSuffix` (line 25)
- `requireContent` (line 43)
- `requireArg` (line 58)
- `validatePath` (line 79)
- `sliceFileContent` (line 163)
- `applyEditReplace` (line 232)
- `parseUnifiedDiff` (line 614)
- `findHunkOffset` (line 654)
- `createTrackedFileTools` (line 979)
- `vp` (line 986)
- `buildTree` (line 1221)

**Exports:**
- `fileOpsTools` (line 1682)


### `src/bun/agents/tools/file-tracker.ts`

**Classes:**
- `FileTracker` (line 31)

**Interfaces:**
- `TrackedFile` (line 14)

**Types:**
- `FreshnessResult` (line 18)

**Functions:**
- `getMtimeMs` (line 23)

**Methods:**
- `track` (line 39)
- `checkFreshness` (line 53)
- `trackWrite` (line 75)
- `getModifiedFiles` (line 81)
- `remove` (line 86)
- `clear` (line 91)


### `src/bun/agents/tools/git.ts`

**Functions:**
- `getGitSetting` (line 15)
- `formatCommitMessage` (line 28)

**Exports:**
- `gitTools` (line 728)


### `src/bun/agents/tools/ignore.ts`

**Interfaces:**
- `IgnoreFilter` (line 47)

**Functions:**
- `clearIgnoreCache` (line 63)
- `createIgnoreFilter` (line 78)
- `extendIgnoreFilter` (line 102)
- `isPathIgnored` (line 125)
- `loadDirGitignore` (line 161)
- `parseGitignore` (line 177)

**Methods:**
- `isIgnored` (line 85)
- `isIgnored` (line 110)


### `src/bun/agents/tools/index.ts`

**Interfaces:**
- `ToolDefinition` (line 24)
- `ToolRegistryEntry` (line 30)

**Types:**
- `ToolCategory` (line 22)

**Functions:**
- `registerTools` (line 58)
- `clearToolCache` (line 79)
- `getToolsForAgent` (line 100)
- `getAllTools` (line 158)
- `getToolDefinitions` (line 169)


### `src/bun/agents/tools/kanban.ts`

**Types:**
- `CriteriaCheckResult` (line 74)

**Functions:**
- `notifyKanban` (line 8)
- `notifyTaskInReviewHandler` (line 21)
- `parseCriteria` (line 40)
- `normalizeTaskCriteria` (line 63)
- `checkAllCriteriaMet` (line 80)
- `createKanbanTools` (line 96)
- `createKanbanToolsImpl` (line 104)
- `resolve` (line 384)
- `resolve` (line 458)

**Exports:**
- `kanbanTools` (line 102)


### `src/bun/agents/tools/lsp.ts`

**Functions:**
- `ensureOpen` (line 16)
- `formatDiagnostics` (line 42)
- `severityLabel` (line 249)
- `symbolKindLabel` (line 259)

**Exports:**
- `lspTools` (line 275)


### `src/bun/agents/tools/notes.ts`

**Functions:**
- `resolveProjectId` (line 18)
- `createDecisionsTool` (line 171)

**Exports:**
- `notesTools` (line 42)


### `src/bun/agents/tools/planning.ts`

**Interfaces:**
- `TaskDefinition` (line 12)

**Functions:**
- `resolveProjectId` (line 35)
- `peekTaskDefinitions` (line 67)
- `drainTaskDefinitions` (line 72)
- `restoreTaskDefinitions` (line 79)

**Exports:**
- `taskDefinitionSchema` (line 22)
- `planningTools` (line 87)


### `src/bun/agents/tools/playground.ts`

**Interfaces:**
- `PlaygroundPreview` (line 23)

**Types:**
- `PlaygroundPreviewKind` (line 21)

**Functions:**
- `isReachable` (line 31)
- `waitReachable` (line 43)
- `broadcast` (line 52)
- `staticUrl` (line 61)
- `createPlaygroundTools` (line 169)


### `src/bun/agents/tools/pm-tools.ts`

**Interfaces:**
- `PMToolsDeps` (line 40)

**Types:**
- `TodoItem` (line 116)

**Functions:**
- `getTodoItems` (line 119)
- `setTodoItems` (line 129)
- `getActiveListId` (line 140)
- `setActiveListId` (line 150)
- `autoMarkTodoDone` (line 165)
- `autoAdvanceTodo` (line 203)
- `getActiveTodoStatus` (line 215)
- `createPMTools` (line 247)
- `checkFile` (line 915)


### `src/bun/agents/tools/preview.ts`

**Interfaces:**
- `PreviewConfig` (line 24)

**Functions:**
- `readText` (line 34)
- `loadSavedConfig` (line 38)
- `invalidateSavedConfig` (line 47)
- `listTopLevel` (line 80)
- `buildWorkspaceContext` (line 87)
- `buildPreviewDetectionPrompt` (line 117)
- `extractJson` (line 159)
- `detectWithAI` (line 169)
- `saveConfig` (line 215)
- `canConnect` (line 235)
- `finish` (line 238)
- `tcpProbe` (line 248)
- `probeOnce` (line 260)
- `isReachable` (line 270)
- `AgentDeskMarkerOn` (line 285)
- `isAgentDeskItself` (line 301)
- `isUsableTarget` (line 314)
- `drainStream` (line 324)
- `startAndWaitForServer` (line 351)
- `ensureRunning` (line 408)
- `buildPreviewUrl` (line 424)
- `createPreviewTool` (line 437)


### `src/bun/agents/tools/process.ts`

**Interfaces:**
- `BackgroundJob` (line 14)
- `StartJobResult` (line 50)
- `RunningJobInfo` (line 391)

**Functions:**
- `pruneOldJobs` (line 32)
- `startBackgroundJob` (line 76)
- `formatElapsed` (line 333)
- `killProcessTree` (line 349)
- `killJobsUnderPath` (line 371)
- `getRunningJobsUnderPath` (line 401)
- `killJobById` (line 427)

**Exports:**
- `processTools` (line 439)


### `src/bun/agents/tools/scheduler.ts`

**Functions:**
- `buildConfig` (line 180)

**Exports:**
- `schedulerTools` (line 42)


### `src/bun/agents/tools/screenshot.ts`

**Functions:**
- `findChrome` (line 32)
- `captureScreenshot` (line 47)
- `getDevServerUrl` (line 112)
- `resizeToFit` (line 210)

**Exports:**
- `screenshotTools` (line 294)


### `src/bun/agents/tools/shell.ts`

**Types:**
- `ShellApprovalHandler` (line 109)

**Functions:**
- `isBlockedCommand` (line 21)
- `which` (line 34)
- `resolveShell` (line 49)
- `setShellApprovalHandler` (line 118)
- `resetShellAutoApprove` (line 122)
- `killProcessTree` (line 130)
- `makeShellTool` (line 174)
- `killProc` (line 216)

**Exports:**
- `autoApprovedShellTool` (line 284)
- `shellTools` (line 286)


### `src/bun/agents/tools/skills.ts`

**Functions:**
- `extractMandatoryFiles` (line 14)

**Exports:**
- `skillTools` (line 38)


### `src/bun/agents/tools/system.ts`

**Exports:**
- `systemTools` (line 179)


### `src/bun/agents/tools/truncation.ts`

**Interfaces:**
- `TruncateOptions` (line 26)
- `TruncateResult` (line 33)

**Functions:**
- `initTruncationDir` (line 48)
- `getTruncationDir` (line 59)
- `truncateOutput` (line 84)
- `truncateReadFile` (line 161)
- `truncateShellOutput` (line 166)
- `truncateSearchResults` (line 171)
- `truncateTree` (line 176)
- `cleanupTruncationFiles` (line 188)


### `src/bun/agents/tools/web.ts`

**Functions:**
- `getIntegrationKey` (line 13)
- `stripHtml` (line 26)
- `ddgSearch` (line 37)
- `tavilySearch` (line 86)

**Exports:**
- `webTools` (line 371)


### `src/bun/agents/types.ts`

**Interfaces:**
- `AgentConfig` (line 26)
- `AgentTask` (line 38)
- `AgentResult` (line 46)
- `AgentActivityEvent` (line 60)
- `RunningAgent` (line 86)

**Types:**
- `AgentRole` (line 1)
- `AgentStatus` (line 17)


### `src/bun/annotations/preview-window.ts`

**Interfaces:**
- `PreviewWindowState` (line 20)
- `OpenPreviewOptions` (line 27)

**Functions:**
- `stateFilePath` (line 54)
- `loadState` (line 58)
- `saveState` (line 78)
- `debounce` (line 85)
- `buildConsoleHookScript` (line 98)
- `startTitlePolling` (line 137)
- `stopTitlePolling` (line 156)
- `stopWatcher` (line 164)
- `startWatcher` (line 172)
- `shouldIgnore` (line 185)
- `reload` (line 195)
- `registerDevShortcut` (line 242)
- `unregisterDevShortcut` (line 253)
- `attachWindowListeners` (line 262)
- `openPreviewWindow` (line 309)
- `closePreviewWindow` (line 340)
- `getPreviewWindow` (line 346)
- `shutdownPreviewWindow` (line 350)


### `src/bun/annotations/server.ts`

**Interfaces:**
- `PreviewEvent` (line 198)

**Functions:**
- `jsonRes` (line 36)
- `mimeFor` (line 77)
- `injectToolbar` (line 86)
- `proxyHttp` (line 105)
- `proxyFile` (line 132)
- `serveLocalFile` (line 169)
- `pushEvent` (line 209)
- `drainEvents` (line 217)
- `formatEvents` (line 223)
- `formatBatchMessage` (line 238)
- `startAnnotationServer` (line 272)
- `shutdownAnnotationServer` (line 448)

**Methods:**
- `fetch` (line 285)
- `error` (line 421)

**Exports:**
- `ANNOTATION_SERVER_PORT` (line 22)


### `src/bun/annotations/toolbar-script.ts`

**Functions:**
- `getToolbarScript` (line 5)


### `src/bun/channels/chunker.ts`

**Functions:**
- `chunkMessage` (line 7)


### `src/bun/channels/discord-adapter.ts`

**Classes:**
- `DiscordAdapter` (line 10)

**Methods:**
- `getStatus` (line 15)
- `onMessage` (line 22)
- `connect` (line 26)
- `disconnect` (line 46)
- `sendMessage` (line 53)


### `src/bun/channels/email-adapter.ts`

**Classes:**
- `EmailAdapter` (line 18)

**Interfaces:**
- `EmailChannelConfig` (line 5)

**Methods:**
- `onMessage` (line 30)
- `getStatus` (line 31)
- `connect` (line 33)
- `startIdleLoop` (line 64)
- `processEmail` (line 137)
- `disconnect` (line 190)
- `sendMessage` (line 197)


### `src/bun/channels/index.ts`

**Exports:**
- `registerAdapter` (line 2)
- `initChannelManager` (line 2)
- `sendChannelMessage` (line 2)
- `getChannelStatuses` (line 2)
- `shutdownChannelManager` (line 2)


### `src/bun/channels/manager.ts`

**Interfaces:**
- `ChannelStatus` (line 43)

**Types:**
- `AdapterFactory` (line 34)
- `GetOrCreateEngine` (line 40)

**Functions:**
- `registerAdapter` (line 79)
- `initChannelManager` (line 93)
- `sendChannelMessage` (line 165)
- `broadcastTaskDoneNotification` (line 209)
- `broadcastSchedulerResult` (line 250)
- `getChannelStatuses` (line 282)
- `getAdapterStatus` (line 301)
- `getChannelPlatform` (line 309)
- `getOrCreateProjectChannelConversation` (line 322)
- `disconnectChannel` (line 355)
- `connectSingleChannel` (line 371)
- `_connectSingleChannel` (line 385)
- `shutdownChannelManager` (line 435)
- `broadcastQR` (line 464)
- `handleIncomingMessage` (line 480)
- `getOrCreateChannelConversation` (line 585)
- `parseJsonConfig` (line 644)


### `src/bun/channels/types.ts`

**Interfaces:**
- `IncomingMessage` (line 6)
- `SendOptions` (line 16)
- `ChannelConfig` (line 22)
- `ChannelAdapter` (line 30)

**Types:**
- `ChannelPlatform` (line 3)
- `ConnectionStatus` (line 4)


### `src/bun/channels/whatsapp-adapter.ts`

**Classes:**
- `WhatsAppAdapter` (line 9)

**Methods:**
- `onMessage` (line 21)
- `onQR` (line 22)
- `getStatus` (line 23)
- `getDefaultRecipient` (line 24)
- `connect` (line 31)
- `disconnect` (line 135)
- `sendMessage` (line 141)


### `src/bun/channels/whatsapp-auth-store.ts`

**Functions:**
- `useSQLiteAuthState` (line 5)
- `saveCreds` (line 24)


### `src/bun/claude/feature-flag.ts`

**Functions:**
- `isClaudeSubscriptionEnabled` (line 4)


### `src/bun/db/audit.ts`

**Interfaces:**
- `AuditEntry` (line 10)

**Functions:**
- `getInsertStmt` (line 22)
- `logAudit` (line 35)


### `src/bun/db/connection.ts`

**Functions:**
- `logDbError` (line 18)
- `wrapStatement` (line 36)
- `wrapDatabase` (line 59)
- `openDatabase` (line 107)
- `closeDatabase` (line 144)
- `runWalCheckpoint` (line 155)
- `startWalCheckpointTimer` (line 161)

**Methods:**
- `get` (line 38)
- `get` (line 61)

**Exports:**
- `dbFilePath` (line 11)
- `sqlite` (line 142)


### `src/bun/db/error-logger.ts`

**Functions:**
- `getLogsDir` (line 18)
- `getLogPath` (line 28)
- `rotateIfNeeded` (line 32)
- `logErrorToAudit` (line 61)
- `logError` (line 81)
- `initGlobalErrorHandlers` (line 121)


### `src/bun/db/index.ts`

**Exports:**
- `db` (line 7)
- `closeDatabase` (line 10)


### `src/bun/db/maintenance.ts`

**Functions:**
- `runIncrementalMaintenance` (line 17)
- `runFullVacuum` (line 28)
- `checkpointWal` (line 40)
- `maybeRunStartupMaintenance` (line 57)
- `maybeVacuumInBackground` (line 63)
- `buildVacuumWorkerSrc` (line 77)
- `runVacuumInWorker` (line 100)
- `done` (line 112)
- `pruneOldLogData` (line 146)
- `getLastVacuumTimestamp` (line 172)
- `recordVacuumTimestamp` (line 184)


### `src/bun/db/migrate.ts`

**Interfaces:**
- `Migration` (line 50)

**Functions:**
- `runMigrations` (line 91)
- `ensureRuntimeSchema` (line 153)


### `src/bun/db/migrations/v10_disable-db-viewer-plugin.ts`

**Functions:**
- `run` (line 11)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v11_free-provider.ts`

**Functions:**
- `run` (line 9)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v12_freelance-listings.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v13_freelance-is-deleted.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v14_freelance-chat-messages.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v15_decode-html-entities.ts`

**Functions:**
- `run` (line 6)

**Exports:**
- `name` (line 4)


### `src/bun/db/migrations/v16_freelance-full-description.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v17_freelance-wizard-verdict.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v18_freelance-peopleperhour-default.ts`

**Functions:**
- `run` (line 7)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v19_freelance-polling-interval-minutes.ts`

**Functions:**
- `run` (line 8)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v1_initial-schema.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v20_freelance-wizard-analysis.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v21_freelance-default-keywords.ts`

**Functions:**
- `run` (line 17)

**Exports:**
- `name` (line 1)
- `DEFAULT_KEYWORDS` (line 3)


### `src/bun/db/migrations/v22_freelance-seed-keywords.ts`

**Functions:**
- `run` (line 4)

**Exports:**
- `name` (line 1)


### `src/bun/db/migrations/v23_agent-custom-flags.ts`

**Functions:**
- `run` (line 11)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v24_agent-available-to-pm.ts`

**Functions:**
- `run` (line 9)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v25_redisable-db-viewer-plugin.ts`

**Functions:**
- `run` (line 16)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v26_remove-legacy-general-agent.ts`

**Functions:**
- `run` (line 18)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v27_issue-fixer-tables.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v28_project-activity.ts`

**Functions:**
- `run` (line 8)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v29_remote-sync-tables.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v2_plugin-prompt.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v30_remote-sync-security-excludes.ts`

**Functions:**
- `addColumnIfMissing` (line 6)
- `run` (line 14)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v31_issue-fixer-notify-enabled.ts`

**Functions:**
- `run` (line 7)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v3_agent-sessions.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v4_inline-agents.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v5_message-parts-agent-name.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v6_verification-status.ts`

**Functions:**
- `run` (line 5)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v7_reviewer-tools.ts`

**Functions:**
- `run` (line 10)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v8_perf-indexes.ts`

**Functions:**
- `run` (line 11)

**Exports:**
- `name` (line 3)


### `src/bun/db/migrations/v9_fix-mcp-config-encoding.ts`

**Functions:**
- `run` (line 18)

**Exports:**
- `name` (line 3)


### `src/bun/db/schema.ts`

**Exports:**
- `settings` (line 9)
- `aiProviders` (line 29)
- `projects` (line 59)
- `agents` (line 83)
- `agentTools` (line 126)
- `conversations` (line 141)
- `messages` (line 152)
- `conversationSummaries` (line 166)
- `notes` (line 178)
- `kanbanTasks` (line 200)
- `kanbanTaskActivity` (line 238)
- `plugins` (line 259)
- `channels` (line 274)
- `deployEnvironments` (line 288)
- `deployHistory` (line 299)
- `prompts` (line 314)
- `inboxMessages` (line 327)
- `whatsappSessions` (line 347)
- `notificationPreferences` (line 355)
- `inboxRules` (line 366)
- `cronJobs` (line 380)
- `cronJobHistory` (line 399)
- `automationRules` (line 413)
- `pullRequests` (line 428)
- `prComments` (line 449)
- `webhookConfigs` (line 463)
- `webhookEvents` (line 478)
- `githubIssues` (line 497)
- `issueFixerConfig` (line 514)
- `issueFixRuns` (line 546)
- `branchStrategies` (line 576)
- `costBudgets` (line 597)
- `auditLog` (line 612)
- `messageParts` (line 626)
- `freelanceListings` (line 648)
- `freelanceChatMessages` (line 675)
- `projectActivity` (line 692)
- `remoteSyncConfig` (line 706)
- `remoteSyncItems` (line 744)
- `remoteSyncRuns` (line 762)


### `src/bun/db/seed.ts`

**Functions:**
- `fnv1a` (line 16)
- `hashAgentDefs` (line 25)
- `loadBuiltinPromptsHash` (line 31)
- `saveBuiltinPromptsHash` (line 37)
- `getDefaultAgentTools` (line 1363)
- `seedDatabase` (line 1378)
- `seedAgentTools` (line 1608)


### `src/bun/db/summaries.ts`

**Functions:**
- `createSummary` (line 9)
- `getLatestSummary` (line 28)
- `deleteSummariesForConversation` (line 50)


### `src/bun/discord/bot.ts`

**Classes:**
- `DiscordBot` (line 5)

**Types:**
- `BotStatus` (line 3)

**Methods:**
- `createClient` (line 20)
- `connect` (line 57)
- `scheduleReconnect` (line 68)
- `sendToChannel` (line 89)
- `getStatus` (line 100)
- `shutdown` (line 104)


### `src/bun/engine-manager.ts`

**Interfaces:**
- `AgentControllerEntry` (line 26)

**Functions:**
- `registerAgentController` (line 32)
- `unregisterAgentController` (line 38)
- `abortAllAgents` (line 43)
- `abortAgentByName` (line 56)
- `getRunningAgentCount` (line 71)
- `getRunningAgentNames` (line 76)
- `getAllRunningAgents` (line 83)
- `getSystemActivity` (line 97)
- `setAppFocused` (line 119)
- `getStatusReport` (line 127)
- `removeEngine` (line 200)
- `evictOldestIdleEngine` (line 215)
- `setMainWindowRef` (line 237)
- `getMainWindowRef` (line 242)
- `broadcastToWebview` (line 252)
- `linkAgentResponseToInbox` (line 268)
- `resolveShellApproval` (line 299)
- `getShellApprovalMode` (line 315)
- `installShellApprovalHandler` (line 333)
- `resolveUserQuestion` (line 388)
- `askUserQuestion` (line 404)
- `getOrCreateEngine` (line 433)

**Methods:**
- `onAgentActivity` (line 585)

**Exports:**
- `engines` (line 19)


### `src/bun/freelance/budget.ts`

**Functions:**
- `formatBudget` (line 4)


### `src/bun/freelance/events.ts`

**Exports:**
- `FREELANCE_EVENTS` (line 4)


### `src/bun/freelance/feature-flag.ts`

**Functions:**
- `isFreelanceEnabled` (line 4)


### `src/bun/freelance/fetcher.ts`

**Functions:**
- `purgeOldDeletedListings` (line 13)
- `trimListingsToMax` (line 24)
- `fetchAllPlatforms` (line 46)
- `startFreelancePoller` (line 161)
- `stopFreelancePoller` (line 181)
- `scheduleNextPoll` (line 188)


### `src/bun/freelance/normalizer.ts`

**Interfaces:**
- `FreelanceListing` (line 4)
- `BudgetInfo` (line 18)

**Functions:**
- `parseBudget` (line 26)
- `cleanDescription` (line 50)
- `normalizeRssItem` (line 54)


### `src/bun/freelance/rss-fetcher.ts`

**Interfaces:**
- `RssItem` (line 40)

**Types:**
- `FeedItem` (line 26)

**Functions:**
- `withRetry` (line 8)
- `categoryToString` (line 51)
- `matchesKeywords` (line 56)
- `fetchRssFeed` (line 61)


### `src/bun/freelance/settings.ts`

**Interfaces:**
- `RssSource` (line 5)
- `FreelanceSettings` (line 11)

**Functions:**
- `getFreelanceSettings` (line 62)
- `get` (line 70)
- `saveFreelanceSetting` (line 92)


### `src/bun/index.ts`

**Interfaces:**
- `WindowState` (line 40)

**Functions:**
- `getWindowStateFilePath` (line 50)
- `loadWindowState` (line 54)
- `saveWindowState` (line 88)
- `debounce` (line 104)
- `getMainViewUrl` (line 113)
- `attachWindowListeners` (line 311)
- `setWindowTitlebarIcon` (line 371)
- `toWide` (line 380)

**Exports:**
- `FREELANCE_ENABLED` (line 143)


### `src/bun/issue-fixer/config.ts`

**Interfaces:**
- `IssueFixerConfigDto` (line 25)

**Types:**
- `ConfigRow` (line 54)
- `IssueFixRunRow` (line 158)

**Functions:**
- `sanitizeAgentdesk` (line 12)
- `parseJsonArray` (line 44)
- `mapConfig` (line 56)
- `getIssueFixerConfig` (line 77)
- `listEnabledConfigs` (line 82)
- `saveIssueFixerConfig` (line 88)
- `setCursor` (line 148)
- `setLastPolled` (line 152)
- `createRun` (line 160)
- `updateRun` (line 194)
- `listRuns` (line 210)
- `getRun` (line 219)
- `mostRecentFinishedAt` (line 225)
- `failInterruptedRuns` (line 242)


### `src/bun/issue-fixer/github.ts`

**Interfaces:**
- `GhIssue` (line 12)
- `GhComment` (line 25)
- `RawIssue` (line 36)
- `RawComment` (line 49)

**Functions:**
- `mapLabels` (line 59)
- `mapIssue` (line 64)
- `issueNumberFromUrl` (line 79)
- `listOpenIssuesSince` (line 88)
- `listIssueCommentsSince` (line 104)
- `getIssue` (line 126)
- `getPullHeadBranch` (line 138)
- `createPullRequest` (line 151)
- `findOpenPullByHead` (line 187)
- `postIssueComment` (line 204)


### `src/bun/issue-fixer/notify.ts`

**Interfaces:**
- `RunResult` (line 6)

**Functions:**
- `buildMessage` (line 18)
- `notifyIssueFixResult` (line 33)


### `src/bun/issue-fixer/orchestrator.ts`

**Interfaces:**
- `IssueFixInput` (line 28)
- `LiveRunSnapshot` (line 52)

**Functions:**
- `getLiveRun` (line 67)
- `enqueueIssueFix` (line 71)
- `slugify` (line 78)
- `resolveProviderConfig` (line 88)
- `serializePart` (line 105)
- `runTestCommand` (line 122)
- `onAbort` (line 125)
- `runIssueFix` (line 135)
- `checkoutExisting` (line 229)


### `src/bun/issue-fixer/poller.ts`

**Interfaces:**
- `PollResult` (line 101)
- `IssueCtx` (line 182)

**Types:**
- `MatchOutcome` (line 206)

**Functions:**
- `startIssueFixerPolling` (line 36)
- `pollAllEnabledOnce` (line 54)
- `stopIssueFixerPolling` (line 71)
- `tick` (line 78)
- `pollProject` (line 108)
- `tally` (line 150)
- `buildCommentContext` (line 190)
- `handleMatch` (line 208)


### `src/bun/issue-fixer/prompts.ts`

**Interfaces:**
- `IntentKeyword` (line 12)
- `IssueContext` (line 56)

**Types:**
- `IssueIntent` (line 10)

**Functions:**
- `intentForKeyword` (line 36)
- `buildIntentDirective` (line 52)
- `buildIssueFixerTask` (line 68)

**Exports:**
- `KEYWORD_PREFIX` (line 19)
- `PREDEFINED_KEYWORDS` (line 25)


### `src/bun/issue-fixer/shell-guard.ts`

**Functions:**
- `escapeRegex` (line 47)
- `pushesToBaseBranch` (line 52)
- `findShellViolation` (line 62)
- `createGuardedShellTool` (line 78)


### `src/bun/issue-fixer/triggers.ts`

**Interfaces:**
- `TriggerConfig` (line 18)
- `TriggerMatch` (line 24)

**Types:**
- `AuthMode` (line 16)

**Functions:**
- `isAuthorizedActor` (line 36)
- `keywordsActive` (line 41)
- `labelsActive` (line 46)
- `findKeyword` (line 51)
- `intentOf` (line 59)
- `matchIssue` (line 67)
- `matchComment` (line 113)
- `alreadyProcessed` (line 136)
- `withinCooldown` (line 171)
- `runsInLastHour` (line 186)


### `src/bun/lib/git-runner.ts`

**Functions:**
- `runGit` (line 4)
- `killProcess` (line 11)


### `src/bun/lsp/client.ts`

**Classes:**
- `LSPClient` (line 48)

**Interfaces:**
- `OpenDocument` (line 31)

**Types:**
- `ClientState` (line 29)

**Functions:**
- `onDiags` (line 235)
- `pathToUri` (line 385)
- `uriToPath` (line 396)
- `normalizeLocations` (line 405)

**Methods:**
- `initialize` (line 70)
- `shutdown` (line 126)
- `openDocument` (line 158)
- `notifyDocumentChanged` (line 171)
- `closeDocument` (line 188)
- `getDiagnostics` (line 202)
- `getAllDiagnostics` (line 217)
- `waitForDiagnostics` (line 226)
- `resolveWaiters` (line 249)
- `removeWaiter` (line 268)
- `hover` (line 279)
- `definition` (line 299)
- `references` (line 316)
- `documentSymbols` (line 334)
- `handleNotification` (line 362)


### `src/bun/lsp/installer.ts`

**Types:**
- `InstallStatus` (line 27)

**Functions:**
- `getManagedDir` (line 13)
- `getManagedBinDir` (line 18)
- `getManagedBinaryDir` (line 23)
- `resolveServerBinary` (line 39)
- `getManagedBinaryPath` (line 74)
- `getInstallStatus` (line 93)
- `installServer` (line 111)
- `uninstallServer` (line 139)
- `checkPrerequisite` (line 174)
- `installViaBun` (line 185)
- `installViaGo` (line 209)
- `installViaGitHub` (line 232)
- `getPlatformString` (line 282)


### `src/bun/lsp/jsonrpc.ts`

**Classes:**
- `JsonRpcTransport` (line 32)

**Interfaces:**
- `StdioProcess` (line 8)
- `PendingRequest` (line 17)

**Types:**
- `NotificationHandler` (line 23)

**Methods:**
- `setNotificationHandler` (line 44)
- `sendRequest` (line 49)
- `sendNotification` (line 67)
- `dispose` (line 74)
- `writeMessage` (line 85)
- `startReading` (line 95)
- `processBuffer` (line 116)
- `handleMessage` (line 149)


### `src/bun/lsp/servers.ts`

**Interfaces:**
- `InstallDef` (line 5)
- `ServerDef` (line 19)

**Functions:**
- `getServerForExtension` (line 184)
- `getAllServerDefs` (line 189)

**Exports:**
- `SERVER_DEFS` (line 40)


### `src/bun/lsp/types.ts`

**Interfaces:**
- `JsonRpcRequest` (line 7)
- `JsonRpcResponse` (line 14)
- `JsonRpcNotification` (line 21)
- `Position` (line 33)
- `Range` (line 38)
- `Location` (line 43)
- `TextDocumentIdentifier` (line 48)
- `TextDocumentPositionParams` (line 52)
- `TextDocumentItem` (line 57)
- `VersionedTextDocumentIdentifier` (line 64)
- `TextDocumentContentChangeEvent` (line 68)
- `Diagnostic` (line 84)
- `DiagnosticRelatedInformation` (line 93)
- `PublishDiagnosticsParams` (line 98)
- `Hover` (line 107)
- `MarkupContent` (line 112)
- `DocumentSymbol` (line 130)
- `SymbolInformation` (line 139)
- `InitializeParams` (line 150)
- `WorkspaceFolder` (line 158)
- `ClientCapabilities` (line 163)
- `InitializeResult` (line 177)
- `ServerCapabilities` (line 182)
- `TextDocumentSyncOptions` (line 190)
- `ReferenceParams` (line 199)

**Types:**
- `JsonRpcMessage` (line 27)
- `LSPServerState` (line 207)


### `src/bun/mcp/client.ts`

**Interfaces:**
- `McpServerConfig` (line 16)
- `McpEntry` (line 44)

**Types:**
- `McpServerStatus` (line 42)

**Functions:**
- `loadMcpServers` (line 23)
- `initMcpClients` (line 65)
- `reloadMcpClients` (line 84)
- `shutdownMcpClients` (line 92)
- `disconnectMcpServer` (line 107)
- `reconnectMcpServer` (line 121)
- `getMcpTools` (line 164)
- `getMcpStatus` (line 177)
- `sanitize` (line 183)
- `connectServer` (line 185)
- `scheduleRetry` (line 259)
- `connectLocal` (line 276)
- `connectRemote` (line 300)


### `src/bun/notifications/desktop.ts`

**Functions:**
- `sendDesktopNotification` (line 16)
- `sendWindowsToast` (line 28)
- `esc` (line 30)


### `src/bun/notifications/native.ts`

**Functions:**
- `sendNativeNotification` (line 8)


### `src/bun/playground/orchestrator.ts`

**Interfaces:**
- `ConvTurn` (line 39)
- `PlaygroundState` (line 186)

**Functions:**
- `loadConversation` (line 60)
- `saveConversation` (line 74)
- `resolveProviderConfig` (line 90)
- `listTopLevel` (line 119)
- `buildWorkspaceContext` (line 132)
- `serializePart` (line 150)
- `bufferPart` (line 167)
- `bufferPartUpdate` (line 173)
- `isPlaygroundRunning` (line 182)
- `getPlaygroundState` (line 201)
- `runPlayground` (line 228)
- `stopPlayground` (line 342)
- `newPlayground` (line 350)
- `shutdownPlayground` (line 382)


### `src/bun/playground/paths.ts`

**Functions:**
- `ensurePlaygroundDirs` (line 35)
- `wipePlayground` (line 41)
- `hasPlaygroundFiles` (line 50)

**Exports:**
- `PLAYGROUND_ROOT` (line 19)
- `PLAYGROUND_FILES_DIR` (line 20)
- `PLAYGROUND_META_DIR` (line 21)
- `CONVERSATION_FILE` (line 22)
- `PREVIEW_FILE` (line 23)
- `DEPLOY_FILE` (line 24)
- `SERVERS_FILE` (line 26)
- `PLAYGROUND_COPY_IGNORE` (line 29)
- `existsSync` (line 58)


### `src/bun/playground/server.ts`

**Functions:**
- `mimeFor` (line 45)
- `injectConsoleCapture` (line 67)
- `resolveSafe` (line 116)
- `startPlaygroundServer` (line 124)
- `shutdownPlaygroundServer` (line 212)
- `broadcastReload` (line 228)
- `startPlaygroundFileWatcher` (line 234)
- `stopPlaygroundFileWatcher` (line 247)
- `restartPlaygroundFileWatcher` (line 254)

**Methods:**
- `fetch` (line 131)
- `error` (line 187)

**Exports:**
- `PLAYGROUND_SERVER_PORT` (line 19)


### `src/bun/plugins/api.ts`

**Functions:**
- `createPluginAPI` (line 20)

**Methods:**
- `registerTool` (line 31)
- `registerHook` (line 37)
- `getSettings` (line 40)
- `setSettings` (line 54)
- `getProjectContext` (line 61)
- `log` (line 64)
- `onFileChange` (line 68)
- `registerSidebarItem` (line 71)
- `registerProjectTab` (line 74)
- `registerSettingsSection` (line 77)
- `registerChatCommand` (line 80)
- `registerTheme` (line 83)


### `src/bun/plugins/extensions.ts`

**Interfaces:**
- `PluginSidebarItem` (line 6)
- `PluginProjectTab` (line 13)
- `PluginSettingsField` (line 19)
- `PluginSettingsSection` (line 27)
- `PluginChatCommand` (line 34)
- `PluginTheme` (line 40)

**Functions:**
- `extRegisterSidebarItem` (line 55)
- `extRegisterProjectTab` (line 59)
- `extRegisterSettingsSection` (line 63)
- `extRegisterChatCommand` (line 67)
- `extRegisterTheme` (line 71)
- `clearPluginExtensions` (line 76)
- `getAllExtensions` (line 86)


### `src/bun/plugins/index.ts`

**Functions:**
- `initPlugins` (line 15)

**Exports:**
- `getPluginInstances` (line 11)
- `enablePlugin` (line 11)
- `disablePlugin` (line 11)
- `uninstallPlugin` (line 11)
- `notifyFileChange` (line 11)
- `PluginManifest` (line 12)
- `PluginInstance` (line 12)
- `PluginAPI` (line 12)


### `src/bun/plugins/loader.ts`

**Interfaces:**
- `LoadedPlugin` (line 7)

**Functions:**
- `scanPluginDirectory` (line 13)


### `src/bun/plugins/lsp-manager/index.ts`

**Types:**
- `SpawnResult` (line 25)

**Functions:**
- `poolKey` (line 21)
- `getOrSpawnServer` (line 30)
- `getServerForFile` (line 79)
- `shutdownAll` (line 94)
- `activate` (line 107)
- `deactivate` (line 368)
- `symbolKindLabel` (line 375)
- `severityLabel` (line 387)

**Exports:**
- `openDocs` (line 19)
- `pluginSettings` (line 105)


### `src/bun/plugins/manifest.ts`

**Functions:**
- `validateManifest` (line 26)


### `src/bun/plugins/registry.ts`

**Functions:**
- `activatePlugin` (line 14)
- `deactivatePlugin` (line 80)
- `uninstallPlugin` (line 98)
- `enablePlugin` (line 115)
- `disablePlugin` (line 125)
- `getPluginInstances` (line 130)
- `getPluginInstance` (line 134)
- `notifyFileChange` (line 139)


### `src/bun/plugins/types.ts`

**Interfaces:**
- `PluginHooks` (line 17)
- `PluginSettingDef` (line 25)
- `PluginManifest` (line 32)
- `PluginModule` (line 48)
- `PluginAPI` (line 61)
- `PluginInstance` (line 79)

**Types:**
- `PluginPermission` (line 14)
- `FileChangeCallback` (line 58)

**Exports:**
- `PluginSidebarItem` (line 11)
- `PluginProjectTab` (line 11)
- `PluginSettingsSection` (line 11)
- `PluginChatCommand` (line 11)
- `PluginTheme` (line 11)


### `src/bun/providers/anthropic.ts`

**Classes:**
- `AnthropicAdapter` (line 20)

**Methods:**
- `createModel` (line 32)
- `listModels` (line 38)
- `testConnection` (line 56)


### `src/bun/providers/claude-subscription.ts`

**Classes:**
- `ClaudeSubscriptionAdapter` (line 55)

**Functions:**
- `loadOAuthToken` (line 24)
- `interceptFetch` (line 71)

**Methods:**
- `createModel` (line 62)
- `listModels` (line 97)
- `testConnection` (line 119)


### `src/bun/providers/deepseek.ts`

**Classes:**
- `DeepSeekAdapter` (line 13)

**Methods:**
- `createModel` (line 25)
- `listModels` (line 29)
- `testConnection` (line 44)


### `src/bun/providers/google.ts`

**Classes:**
- `GoogleAdapter` (line 16)

**Methods:**
- `createModel` (line 28)
- `listModels` (line 32)
- `testConnection` (line 51)


### `src/bun/providers/groq.ts`

**Classes:**
- `GroqAdapter` (line 16)

**Methods:**
- `createModel` (line 28)
- `listModels` (line 32)
- `testConnection` (line 50)


### `src/bun/providers/headers.ts`

**Exports:**
- `PROVIDER_HEADERS` (line 7)


### `src/bun/providers/index.ts`

**Functions:**
- `createProviderAdapter` (line 31)
- `createProviderAdapterWithFallback` (line 71)

**Exports:**
- `ProviderAdapter` (line 14)
- `ProviderConfig` (line 14)
- `getContextLimit` (line 15)
- `getDefaultModel` (line 15)


### `src/bun/providers/models.ts`

**Functions:**
- `getContextLimit` (line 29)
- `clearContextLimitCache` (line 63)
- `getDefaultModel` (line 71)


### `src/bun/providers/ollama.ts`

**Classes:**
- `OllamaAdapter` (line 23)

**Interfaces:**
- `OllamaTagsResponse` (line 19)

**Methods:**
- `createModel` (line 37)
- `listModels` (line 46)
- `testConnection` (line 68)


### `src/bun/providers/openai.ts`

**Classes:**
- `OpenAIAdapter` (line 41)

**Functions:**
- `normalizeBaseUrl` (line 12)
- `joinUrl` (line 21)
- `naturalSort` (line 27)
- `interceptFetch` (line 61)

**Methods:**
- `createModel` (line 53)
- `listModels` (line 97)
- `testConnection` (line 127)


### `src/bun/providers/opencode.ts`

**Classes:**
- `OpenCodeAdapter` (line 80)

**Functions:**
- `fetchFreeModels` (line 12)

**Methods:**
- `createModel` (line 94)
- `listModels` (line 98)
- `testConnection` (line 108)


### `src/bun/providers/openrouter.ts`

**Classes:**
- `OpenRouterAdapter` (line 25)

**Methods:**
- `createModel` (line 39)
- `listModels` (line 43)
- `testConnection` (line 47)


### `src/bun/providers/types.ts`

**Interfaces:**
- `ProviderConfig` (line 3)
- `ProviderAdapter` (line 12)


### `src/bun/providers/xai.ts`

**Classes:**
- `XaiAdapter` (line 15)

**Methods:**
- `createModel` (line 27)
- `listModels` (line 31)
- `testConnection` (line 49)


### `src/bun/providers/zai.ts`

**Classes:**
- `ZaiAdapter` (line 18)

**Methods:**
- `createModel` (line 31)
- `listModels` (line 35)
- `testConnection` (line 39)


### `src/bun/remote-sync/client.ts`

**Classes:**
- `SftpRemoteClient` (line 85)
- `FtpRemoteClient` (line 169)

**Interfaces:**
- `RemoteCredentials` (line 20)
- `RemoteEntry` (line 38)
- `RemoteClient` (line 46)

**Types:**
- `RemoteProtocol` (line 18)

**Functions:**
- `posixJoin` (line 68)
- `posixDirname` (line 76)
- `once` (line 207)
- `transferFailed` (line 218)
- `createRemoteClient` (line 294)

**Methods:**
- `getHostKeyFingerprint` (line 90)
- `connect` (line 94)
- `list` (line 113)
- `stat` (line 123)
- `downloadFile` (line 138)
- `readFile` (line 142)
- `uploadFile` (line 147)
- `ensureRemoteDir` (line 151)
- `disconnect` (line 158)
- `connect` (line 185)
- `list` (line 203)
- `stat` (line 240)
- `downloadFile` (line 252)
- `readFile` (line 256)
- `write` (line 259)
- `uploadFile` (line 268)
- `ensureRemoteDir` (line 272)
- `disconnect` (line 284)


### `src/bun/remote-sync/config.ts`

**Interfaces:**
- `ResolvedRemoteConfig` (line 164)

**Types:**
- `ConfigRow` (line 18)
- `RemoteItemRow` (line 210)
- `RunRow` (line 248)

**Functions:**
- `parseStringArray` (line 20)
- `sanitizeExcludes` (line 31)
- `parseSelections` (line 44)
- `mapConfig` (line 58)
- `getRow` (line 81)
- `getRemoteSyncConfig` (line 86)
- `defaultPort` (line 92)
- `saveRemoteSyncConfig` (line 96)
- `resolveSecret` (line 106)
- `setLastPulled` (line 147)
- `setLastPushed` (line 151)
- `setHostKeyFingerprint` (line 156)
- `resolveRemoteConfig` (line 174)
- `dec` (line 179)
- `getManifest` (line 212)
- `upsertManifestItem` (line 216)
- `mapRun` (line 250)
- `createRun` (line 267)
- `updateRun` (line 280)
- `listRuns` (line 296)
- `failInterruptedRuns` (line 307)


### `src/bun/remote-sync/crypto.ts`

**Functions:**
- `getKey` (line 24)
- `isEncrypted` (line 53)
- `encryptSecret` (line 58)
- `decryptSecret` (line 73)


### `src/bun/remote-sync/engine.ts`

**Classes:**
- `CancelledError` (line 55)

**Interfaces:**
- `RemoteFile` (line 322)
- `PullConflictEntry` (line 654)
- `PushFileDiff` (line 726)

**Functions:**
- `isBusy` (line 44)
- `cancel` (line 48)
- `getWorkspacePath` (line 64)
- `hashFile` (line 73)
- `isSafeSegment` (line 84)
- `isSafeRel` (line 89)
- `toLocalAbs` (line 98)
- `toLocalRel` (line 109)
- `log` (line 113)
- `globToRegExp` (line 120)
- `makeExcluder` (line 143)
- `pinHostKeyIfNew` (line 166)
- `hostKeyMismatchMessage` (line 176)
- `disconnectBrowse` (line 195)
- `evictBrowseCache` (line 204)
- `scheduleBrowseEvict` (line 208)
- `getBrowseClient` (line 215)
- `testConnection` (line 237)
- `browseRemoteDir` (line 264)
- `sortEntries` (line 278)
- `run` (line 290)
- `walkRemote` (line 328)
- `pull` (line 355)
- `runPull` (line 381)
- `walkLocal` (line 484)
- `computePushDiff` (line 511)
- `computePullConflicts` (line 661)
- `looksBinary` (line 720)
- `getPushFileDiff` (line 736)
- `push` (line 787)
- `runPush` (line 826)


### `src/bun/rpc-registration.ts`

**Functions:**
- `onSettingChange` (line 63)
- `withErrorToast` (line 72)
- `walk` (line 548)

**Exports:**
- `rpc` (line 89)


### `src/bun/rpc/activity.ts`

**Interfaces:**
- `UnreadActivityEntry` (line 13)

**Functions:**
- `broadcast` (line 26)
- `recordActivity` (line 36)
- `getUnreadActivity` (line 56)
- `markActivitySeen` (line 85)
- `clearProjectActivity` (line 101)


### `src/bun/rpc/agents.ts`

**Interfaces:**
- `AgentListItem` (line 7)

**Functions:**
- `getAgentsList` (line 29)
- `updateAgent` (line 57)
- `resetAgent` (line 102)
- `createAgent` (line 140)
- `deleteAgent` (line 207)
- `getAgentToolsList` (line 225)
- `setAgentToolsList` (line 237)
- `getAllToolDefinitions` (line 267)
- `resetAgentToolsToDefaults` (line 274)


### `src/bun/rpc/analytics.ts`

**Interfaces:**
- `DayRow` (line 14)
- `ColRow` (line 23)
- `PriRow` (line 28)
- `AvgRow` (line 33)
- `SummaryRow` (line 56)

**Functions:**
- `getProjectStats` (line 10)
- `getAnalyticsSummary` (line 55)


### `src/bun/rpc/audit.ts`

**Interfaces:**
- `AuditLogEntry` (line 6)

**Functions:**
- `getAuditLog` (line 18)
- `clearAuditLog` (line 86)


### `src/bun/rpc/automation.ts`

**Functions:**
- `getAutomationRules` (line 6)
- `createAutomationRule` (line 15)
- `updateAutomationRule` (line 34)
- `deleteAutomationRule` (line 53)
- `getAutomationTemplates` (line 59)


### `src/bun/rpc/backup.ts`

**Functions:**
- `getBackupsDir` (line 10)
- `getDbPath` (line 18)
- `createBackup` (line 25)
- `listBackups` (line 41)
- `deleteBackup` (line 58)
- `restoreBackup` (line 71)


### `src/bun/rpc/branch-strategy.ts`

**Functions:**
- `getBranchStrategy` (line 8)
- `saveBranchStrategy` (line 30)
- `createFeatureBranch` (line 90)
- `getMergedBranches` (line 122)
- `cleanupMergedBranches` (line 126)


### `src/bun/rpc/conversations.ts`

**Interfaces:**
- `ConversationListItem` (line 7)
- `MessageListItem` (line 238)

**Functions:**
- `getConversations` (line 20)
- `getArchivedConversations` (line 40)
- `createConversation` (line 62)
- `deleteMessage` (line 114)
- `clearConversationMessages` (line 122)
- `deleteConversation` (line 135)
- `renameConversation` (line 172)
- `pinConversation` (line 186)
- `archiveConversation` (line 200)
- `restoreConversation` (line 213)
- `archiveOldConversations` (line 226)
- `getMessages` (line 279)
- `branchConversation` (line 324)
- `getMessageParts` (line 396)
- `mapConversation` (line 434)
- `mapMessage` (line 446)


### `src/bun/rpc/council.ts`

**Interfaces:**
- `CouncilSession` (line 54)
- `RoundResponse` (line 158)

**Types:**
- `AgentEntry` (line 156)

**Functions:**
- `emit` (line 66)
- `resolveProvider` (line 70)
- `truncate` (line 92)
- `startCouncilSession` (line 102)
- `stopCouncilSession` (line 130)
- `answerCouncilQuestion` (line 138)
- `runParallelRound` (line 169)
- `runBordaRanking` (line 245)
- `runSession` (line 305)


### `src/bun/rpc/cron.ts`

**Functions:**
- `getGlobalTimezone` (line 11)
- `getCronJobs` (line 26)
- `createCronJob` (line 38)
- `updateCronJob` (line 67)
- `deleteCronJob` (line 91)
- `getCronJobHistory` (line 98)
- `clearCronJobHistory` (line 107)
- `previewCronSchedule` (line 116)
- `triggerCronJob` (line 120)


### `src/bun/rpc/dashboard-agent.ts`

**Functions:**
- `getProviderForAgent` (line 33)
- `getChatEnabledAgents` (line 49)
- `sendDashboardAgentMessage` (line 66)
- `abortDashboardAgentMessage` (line 163)
- `clearDashboardAgentSession` (line 173)


### `src/bun/rpc/dashboard.ts`

**Functions:**
- `buildDashboardSystemPrompt` (line 52)
- `createDashboardTools` (line 114)
- `checkFile` (line 507)
- `getDefaultProviderRow` (line 549)
- `sendDashboardMessage` (line 563)
- `abortDashboardMessage` (line 683)
- `clearDashboardSession` (line 693)


### `src/bun/rpc/db-viewer.ts`

**Functions:**
- `dbViewerGetTables` (line 38)
- `dbViewerGetRows` (line 44)
- `dbViewerDeleteRow` (line 76)


### `src/bun/rpc/deploy.ts`

**Functions:**
- `getEnvironments` (line 11)
- `saveEnvironment` (line 15)
- `deleteEnvironment` (line 45)
- `getDeployHistory` (line 50)
- `executeDeploy` (line 58)
- `fail` (line 91)
- `reconcileStuckDeploys` (line 173)


### `src/bun/rpc/discord.ts`

**Functions:**
- `setDiscordStatusGetter` (line 9)
- `getDiscordConfigs` (line 13)
- `saveDiscordConfig` (line 17)
- `deleteDiscordConfig` (line 65)
- `testDiscordConnection` (line 70)
- `getDiscordStatus` (line 94)


### `src/bun/rpc/email.ts`

**Functions:**
- `getEmailConfigs` (line 5)
- `saveEmailConfig` (line 9)
- `deleteEmailConfig` (line 58)
- `testEmailConnection` (line 63)


### `src/bun/rpc/export-import.ts`

**Functions:**
- `exportProjectData` (line 12)
- `importProjectData` (line 68)
- `insertRows` (line 121)


### `src/bun/rpc/freelance-chat.ts`

**Functions:**
- `buildFreelanceTools` (line 31)
- `fetchPageText` (line 52)
- `extractDescription` (line 70)
- `buildSystemPrompt` (line 93)
- `getDefaultProviderAndModel` (line 216)
- `getMessages` (line 243)
- `clearMessages` (line 264)
- `isAbortError` (line 277)
- `streamAndPersist` (line 286)
- `sendMessage` (line 405)
- `regenerate` (line 450)
- `stopChat` (line 493)


### `src/bun/rpc/freelance-wizard.ts`

**Types:**
- `Verdict` (line 345)

**Functions:**
- `getAnalysisProviderAndModel` (line 25)
- `isObviouslyNonSoftware` (line 82)
- `buildWizardTools` (line 102)
- `isAbortError` (line 119)
- `fetchPageText` (line 127)
- `extractDescription` (line 148)
- `buildAnalysisSystemPrompt` (line 177)
- `buildUserMessage` (line 244)
- `buildAnalysisWritePrompt` (line 297)
- `coerceVerdict` (line 347)
- `extractJsonFromText` (line 388)
- `formatToolOutput` (line 407)
- `clean` (line 411)
- `analyzeListingWorkability` (line 423)
- `collectToolResults` (line 448)
- `normalizeNewlines` (line 553)
- `isCacheValid` (line 567)
- `runWizard` (line 577)
- `startWizard` (line 780)
- `stopWizard` (line 786)
- `runAutoShortlist` (line 800)
- `analyzeListing` (line 950)
- `shortlistListings` (line 1014)


### `src/bun/rpc/freelance.ts`

**Functions:**
- `getFeatureEnabled` (line 18)
- `getSettings` (line 23)
- `saveSettings` (line 28)
- `getListings` (line 55)
- `getListingCounts` (line 133)
- `markListingDone` (line 157)
- `deleteListing` (line 185)
- `deleteAllListings` (line 212)
- `triggerFetch` (line 236)
- `approveListing` (line 257)


### `src/bun/rpc/git.ts`

**Functions:**
- `getProject` (line 7)
- `getWorkspacePath` (line 13)
- `ensureRemote` (line 18)
- `getGitStatus` (line 27)
- `getCurrentBranch` (line 42)
- `getGitBranches` (line 59)
- `getGitLog` (line 70)
- `getGitDiff` (line 80)
- `getCommitFiles` (line 87)
- `gitCheckout` (line 97)
- `gitCreateBranch` (line 103)
- `gitStageFiles` (line 109)
- `gitCommit` (line 115)
- `gitPush` (line 121)
- `gitPull` (line 132)
- `getConflicts` (line 162)
- `getConflictDiff` (line 169)
- `gitDeleteBranch` (line 175)
- `gitMergeBranch` (line 186)
- `gitRebaseBranch` (line 224)
- `gitAbortMerge` (line 230)
- `getMergedBranches` (line 239)
- `cleanupMergedBranches` (line 251)


### `src/bun/rpc/github-api.ts`

**Functions:**
- `getGitHubPAT` (line 10)
- `getProjectGitHubToken` (line 26)
- `getLegacyGitToken` (line 42)
- `getProjectIdByWorkspace` (line 54)
- `resolveGitHubToken` (line 72)
- `gitAuthArgs` (line 96)
- `githubAuthPrefix` (line 115)
- `redactToken` (line 131)
- `pushBranchAuthenticated` (line 152)
- `githubFetch` (line 191)
- `parseGithubUrl` (line 220)
- `getProjectGithubRepo` (line 229)
- `validateGithubToken` (line 247)
- `getGithubConfigError` (line 264)


### `src/bun/rpc/github-issues.ts`

**Functions:**
- `getGithubIssues` (line 19)
- `syncGithubIssues` (line 45)
- `createGithubIssueFromTask` (line 136)
- `linkIssueToTask` (line 204)
- `closeGithubIssueForTask` (line 215)


### `src/bun/rpc/health.ts`

**Interfaces:**
- `HealthStatus` (line 63)

**Functions:**
- `setSchedulerRunning` (line 55)
- `checkDatabaseSubsystem` (line 109)
- `checkAiProviderSubsystem` (line 164)
- `checkWorkspaceSubsystem` (line 205)
- `checkSchedulerSubsystem` (line 238)
- `checkIntegrationsSubsystem` (line 256)
- `checkEnginesSubsystem` (line 291)
- `checkBackendSubsystem` (line 320)
- `getHealthStatus` (line 336)
- `checkDatabase` (line 365)
- `restartScheduler` (line 390)
- `cleanupEngines` (line 408)


### `src/bun/rpc/inbox-rules.ts`

**Interfaces:**
- `RuleCondition` (line 5)
- `RuleAction` (line 11)
- `InboxMessageParams` (line 16)

**Functions:**
- `matchesCondition` (line 27)
- `applyInboxRules` (line 39)
- `getInboxRulesList` (line 78)
- `createInboxRule` (line 83)
- `updateInboxRule` (line 94)
- `deleteInboxRule` (line 107)


### `src/bun/rpc/inbox.ts`

**Functions:**
- `getInboxMessages` (line 9)
- `markAsRead` (line 38)
- `markAsUnread` (line 43)
- `markAllAsRead` (line 48)
- `getUnreadCount` (line 59)
- `deleteInboxMessage` (line 66)
- `searchInboxMessages` (line 71)
- `archiveInboxMessage` (line 101)
- `unarchiveInboxMessage` (line 106)
- `bulkArchiveInboxMessages` (line 111)
- `bulkDeleteInboxMessages` (line 117)
- `bulkMarkAsReadInboxMessages` (line 123)
- `replyToInboxMessage` (line 129)
- `updateAgentResponse` (line 154)
- `writeInboxMessage` (line 158)


### `src/bun/rpc/issue-fixer.ts`

**Functions:**
- `mapRun` (line 22)
- `getIssueFixerConfig` (line 46)
- `saveIssueFixerConfig` (line 51)
- `listIssueFixRuns` (line 59)
- `getIssueFixRun` (line 64)
- `getActiveIssueFixRun` (line 69)
- `pollIssueFixerNow` (line 73)
- `cancelIssueFixRun` (line 89)
- `triggerIssueFixManually` (line 101)
- `getIssueFixerKeywordCatalog` (line 132)


### `src/bun/rpc/kanban.ts`

**Interfaces:**
- `KanbanTask` (line 15)
- `CreateKanbanTaskParams` (line 34)
- `UpdateKanbanTaskParams` (line 47)

**Functions:**
- `getKanbanTasks` (line 71)
- `getKanbanTask` (line 84)
- `createKanbanTask` (line 97)
- `updateKanbanTask` (line 146)
- `moveKanbanTask` (line 179)
- `deleteKanbanTask` (line 233)
- `getTaskActivity` (line 245)
- `getProjectTaskStats` (line 256)
- `mapTask` (line 271)
- `logActivity` (line 292)


### `src/bun/rpc/lsp.ts`

**Functions:**
- `getLspSettings` (line 16)
- `getLspStatus` (line 29)
- `installLspServerHandler` (line 70)
- `uninstallLspServerHandler` (line 85)


### `src/bun/rpc/maintenance.ts`

**Functions:**
- `optimizeDatabase` (line 13)
- `vacuumDatabase` (line 18)
- `pruneDatabase` (line 23)


### `src/bun/rpc/mcp.ts`

**Interfaces:**
- `McpServerConfig` (line 4)

**Functions:**
- `getMcpConfig` (line 12)
- `getMcpStatusRpc` (line 46)
- `reconnectMcpServerRpc` (line 51)
- `disconnectMcpServerRpc` (line 57)
- `saveMcpConfig` (line 63)


### `src/bun/rpc/notes.ts`

**Functions:**
- `getProjectNotes` (line 8)
- `getNote` (line 16)
- `createNote` (line 26)
- `updateNote` (line 43)
- `deleteNote` (line 55)
- `getWorkspacePlans` (line 60)
- `deleteWorkspacePlan` (line 105)
- `searchNotes` (line 114)


### `src/bun/rpc/notifications.ts`

**Functions:**
- `getNotificationPreferences` (line 5)
- `saveNotificationPreference` (line 12)
- `shouldNotify` (line 41)


### `src/bun/rpc/playground.ts`

**Interfaces:**
- `PersistedServer` (line 337)

**Functions:**
- `playgroundSend` (line 28)
- `playgroundStop` (line 40)
- `newPlayground` (line 45)
- `getPlaygroundState` (line 50)
- `readSourceFiles` (line 71)
- `getPlaygroundSource` (line 99)
- `generateProjectName` (line 107)
- `createProjectFromPlayground` (line 144)
- `resolveDownloadsDir` (line 205)
- `projectNameFromPreview` (line 225)
- `exportPlaygroundZip` (line 237)
- `savePlaygroundFile` (line 294)
- `setPlaygroundPreviewUrl` (line 317)
- `readPersistedServers` (line 339)
- `writePersistedServers` (line 349)
- `getPlaygroundDevServers` (line 356)
- `stopPlaygroundDevServer` (line 381)
- `startPlaygroundDevServer` (line 387)
- `readSurgeNetrc` (line 402)
- `cacheSurgeToken` (line 427)
- `getSurgeToken` (line 440)
- `deployPlayground` (line 502)


### `src/bun/rpc/plugin-extensions.ts`

**Functions:**
- `getPluginExtensions` (line 4)


### `src/bun/rpc/plugins.ts`

**Functions:**
- `getPluginsList` (line 6)
- `togglePlugin` (line 33)
- `getPluginSettings` (line 42)
- `savePluginSettings` (line 48)
- `savePluginPrompt` (line 57)


### `src/bun/rpc/projects.ts`

**Interfaces:**
- `ProjectListItem` (line 13)
- `CreateProjectParams` (line 60)

**Types:**
- `StmtCache` (line 508)

**Functions:**
- `getProjectsList` (line 30)
- `createProjectHandler` (line 80)
- `getProjectRepoState` (line 251)
- `cloneProjectRepo` (line 268)
- `deleteProjectHandler` (line 325)
- `cleanupProjectWorkspaceFolder` (line 339)
- `permanentDeleteProjectHandler` (line 390)
- `getProject` (line 445)
- `updateProject` (line 465)
- `buildStmts` (line 511)
- `getStmts` (line 543)
- `deleteProjectCascade` (line 552)
- `resetProjectData` (line 601)
- `saveProjectSetting` (line 634)
- `getProjectSettings` (line 664)
- `detectVerifyCommand` (line 683)
- `exists` (line 700)
- `readJson` (line 701)
- `listWorkspaceFiles` (line 825)
- `readWorkspaceFile` (line 897)
- `readWorkspaceImageFile` (line 936)
- `syncWorkspaceFolders` (line 976)


### `src/bun/rpc/prompts.ts`

**Functions:**
- `getPrompts` (line 5)
- `getPrompt` (line 9)
- `savePrompt` (line 14)
- `deletePrompt` (line 45)
- `searchPrompts` (line 50)


### `src/bun/rpc/providers.ts`

**Interfaces:**
- `ProviderListItem` (line 29)
- `SaveProviderParams` (line 62)

**Functions:**
- `normalizeBaseUrl` (line 16)
- `normalizeUrlForComparison` (line 24)
- `getProvidersList` (line 43)
- `saveProviderHandler` (line 76)
- `getProviderApiKeyHandler` (line 162)
- `testProviderWithCredentialsHandler` (line 172)
- `testProviderHandler` (line 198)
- `deleteProviderHandler` (line 244)
- `getConnectedProviderModelsHandler` (line 256)
- `listProviderModelsHandler` (line 296)
- `checkModelToolSupportHandler` (line 325)
- `getClaudeSubscriptionEnabledHandler` (line 372)
- `listProviderModelsByIdHandler` (line 379)


### `src/bun/rpc/pulls.ts`

**Functions:**
- `mapPr` (line 9)
- `getPullRequests` (line 30)
- `createPullRequest` (line 42)
- `updatePullRequest` (line 97)
- `mergePullRequest` (line 113)
- `deletePullRequest` (line 175)
- `getPrDiff` (line 180)
- `getPrComments` (line 194)
- `addPrComment` (line 212)
- `deletePrComment` (line 233)
- `generatePrDescription` (line 240)
- `runGitInProject` (line 262)


### `src/bun/rpc/remote-sync.ts`

**Functions:**
- `getRemoteSyncConfig` (line 29)
- `saveRemoteSyncConfig` (line 33)
- `revealRemoteSyncSecret` (line 44)
- `testRemoteConnection` (line 55)
- `browseRemoteDir` (line 61)
- `computeRemotePullConflicts` (line 68)
- `startRemotePull` (line 74)
- `computeRemotePushDiff` (line 80)
- `getRemotePushFileDiff` (line 86)
- `startRemotePush` (line 93)
- `listRemoteSyncRuns` (line 100)
- `cancelRemoteSync` (line 107)


### `src/bun/rpc/reset.ts`

**Functions:**
- `resetApplication` (line 23)


### `src/bun/rpc/search.ts`

**Interfaces:**
- `SearchResult` (line 3)

**Functions:**
- `globalSearch` (line 15)


### `src/bun/rpc/settings-export.ts`

**Interfaces:**
- `SettingsBundle` (line 15)

**Functions:**
- `exportSettings` (line 70)
- `importSettings` (line 188)


### `src/bun/rpc/settings.ts`

**Functions:**
- `getSettings` (line 11)
- `getRawSetting` (line 37)
- `getSetting` (line 57)
- `saveSetting` (line 86)


### `src/bun/rpc/skills.ts`

**Functions:**
- `getSkills` (line 7)
- `getSkill` (line 20)
- `refreshSkills` (line 36)
- `getSkillsDirectory` (line 41)
- `openSkillsFolder` (line 45)
- `openSkillInEditor` (line 64)
- `deleteSkill` (line 84)
- `getAvailableTools` (line 88)


### `src/bun/rpc/updater.ts`

**Functions:**
- `relayStatus` (line 7)
- `checkForUpdate` (line 20)
- `downloadUpdate` (line 53)
- `applyUpdate` (line 66)
- `applyLog` (line 95)
- `windowsDownloadSetup` (line 101)
- `windowsApplySetup` (line 160)
- `esc` (line 172)
- `psLog` (line 224)


### `src/bun/rpc/whatsapp.ts`

**Functions:**
- `getWhatsAppConfigs` (line 5)
- `saveWhatsAppConfig` (line 9)
- `deleteWhatsAppConfig` (line 34)
- `getWhatsAppStatus` (line 40)
- `getDefaultChannelProject` (line 50)
- `setDefaultChannelProject` (line 58)
- `connectWhatsApp` (line 71)


### `src/bun/scheduler/automation-engine.ts`

**Interfaces:**
- `TriggerCondition` (line 10)
- `TriggerConfig` (line 16)
- `AutomationAction` (line 21)

**Functions:**
- `matchesCondition` (line 26)
- `evaluateRules` (line 42)
- `initAutomationEngine` (line 87)
- `shutdownAutomationEngine` (line 103)


### `src/bun/scheduler/cron-scheduler.ts`

**Interfaces:**
- `ManagedJob` (line 14)

**Functions:**
- `triggerJobNow` (line 21)
- `runJob` (line 25)
- `startJob` (line 83)
- `stopJob` (line 95)
- `initCronScheduler` (line 103)
- `shutdownCronScheduler` (line 133)
- `refreshJob` (line 140)
- `getNextRuns` (line 152)


### `src/bun/scheduler/event-bus.ts`

**Classes:**
- `EventBusImpl` (line 15)

**Types:**
- `AgentDeskEvent` (line 4)

**Methods:**
- `emit` (line 22)
- `on` (line 27)
- `off` (line 31)
- `onAny` (line 35)
- `removeAllListeners` (line 39)

**Exports:**
- `eventBus` (line 44)


### `src/bun/scheduler/index.ts`

**Exports:**
- `eventBus` (line 2)
- `AgentDeskEvent` (line 2)
- `executeTask` (line 3)
- `setTaskExecutorEngine` (line 3)
- `TaskType` (line 3)
- `TaskResult` (line 3)
- `initCronScheduler` (line 4)
- `shutdownCronScheduler` (line 4)
- `refreshJob` (line 4)
- `getNextRuns` (line 4)
- `triggerJobNow` (line 4)
- `initAutomationEngine` (line 5)
- `shutdownAutomationEngine` (line 5)


### `src/bun/scheduler/task-executor.ts`

**Interfaces:**
- `TaskResult` (line 15)

**Types:**
- `TaskType` (line 13)
- `GetOrCreateEngine` (line 22)

**Functions:**
- `setTaskExecutorEngine` (line 26)
- `executeTask` (line 30)


### `src/bun/skills/loader.ts`

**Interfaces:**
- `SkillValidationError` (line 10)
- `Skill` (line 15)
- `SkillFrontmatter` (line 32)

**Functions:**
- `scanSkillsDirectory` (line 49)
- `parseSkillFile` (line 77)
- `validateSkill` (line 134)
- `resolveSkillName` (line 180)
- `extractFirstParagraph` (line 193)
- `loadSupportingFiles` (line 217)
- `collectFiles` (line 227)
- `loadAllSkills` (line 243)
- `executeBashInjections` (line 267)
- `substituteArguments` (line 294)
- `resolveSkillContent` (line 336)


### `src/bun/skills/registry.ts`

**Classes:**
- `SkillRegistry` (line 13)

**Methods:**
- `loadAll` (line 51)
- `reload` (line 88)
- `getAll` (line 93)
- `getByName` (line 98)
- `search` (line 106)
- `resolveContent` (line 117)
- `deleteSkill` (line 125)

**Exports:**
- `Skill` (line 7)
- `skillRegistry` (line 152)


### `src/bun/windows-registry.ts`

**Functions:**
- `registerWindowsUninstaller` (line 12)


## Data Flow

Router/Controller → Repository → Model/Schema

## Change Recipe

To add a new feature to the **bun** domain:

1. Update the model/schema in `src/bun/`
