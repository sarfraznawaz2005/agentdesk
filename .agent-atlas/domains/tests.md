# Domain: tests

**Directory:** `src/tests`
**Files:** 33
**Symbols:** 63

## Files

### `tests/agents/agent-loop.test.ts`

_No exported symbols detected._

### `tests/agents/review-cycle.test.ts`

**Functions:**
- `reviewSummaryHasIssues` (line 66)
- `isAgentCancelled` (line 88)
- `getVerdict` (line 206)


### `tests/channels/chunker.test.ts`

_No exported symbols detected._

### `tests/channels/manager.test.ts`

**Functions:**
- `createStubAdapter` (line 71)
- `insertChannel` (line 111)
- `insertProject` (line 126)

**Methods:**
- `simulateIncoming` (line 84)
- `connect` (line 87)
- `disconnect` (line 90)
- `getStatus` (line 93)
- `sendMessage` (line 96)
- `onMessage` (line 99)


### `tests/db/conversations.test.ts`

_No exported symbols detected._

### `tests/db/kanban.test.ts`

**Functions:**
- `makeTask` (line 33)


### `tests/db/migrate.test.ts`

_No exported symbols detected._

### `tests/db/projects.test.ts`

**Functions:**
- `makeProject` (line 21)


### `tests/db/settings.test.ts`

**Functions:**
- `saveSetting` (line 26)
- `getSetting` (line 49)
- `saveProjectSetting` (line 59)
- `getProjectSetting` (line 68)


### `tests/frontend/date-utils.test.ts`

**Functions:**
- `isoMinutesAgo` (line 28)
- `isoHoursAgo` (line 32)
- `isoDaysAgo` (line 36)
- `isoMinutesFromNow` (line 40)
- `isoHoursFromNow` (line 45)
- `sqliteDateTime` (line 51)


### `tests/frontend/pricing.test.ts`

_No exported symbols detected._

### `tests/frontend/utils.test.ts`

_No exported symbols detected._

### `tests/helpers/db.ts`

**Types:**
- `TestDb` (line 14)

**Functions:**
- `createTestDb` (line 16)
- `applySchema` (line 28)


### `tests/helpers/git.ts`

**Functions:**
- `initGitRepo` (line 13)
- `gitAddCommit` (line 29)


### `tests/helpers/workspace.ts`

**Interfaces:**
- `TempWorkspace` (line 11)

**Functions:**
- `createTempWorkspace` (line 20)
- `writeFile` (line 36)


### `tests/issue-fixer/shell-guard.test.ts`

_No exported symbols detected._

### `tests/playground/paths.test.ts`

_No exported symbols detected._

### `tests/playground/server.test.ts`

_No exported symbols detected._

### `tests/rpc/agents.test.ts`

**Functions:**
- `seedBuiltinAgent` (line 46)
- `seedCustomAgent` (line 55)


### `tests/rpc/conversations.test.ts`

**Functions:**
- `seedProject` (line 47)


### `tests/rpc/council.test.ts`

**Interfaces:**
- `RoundResponse` (line 196)

**Types:**
- `GenerateTextArgs` (line 44)

**Functions:**
- `generateTextImpl` (line 46)
- `streamTextImpl` (line 50)
- `clearEvents` (line 87)
- `councilEvents` (line 91)
- `eventTypes` (line 97)
- `waitForEvent` (line 101)
- `waitForSessionEnd` (line 115)
- `seedProvider` (line 119)
- `removeAllProviders` (line 126)
- `makeStandardGenerateMock` (line 131)
- `makeStandardStreamMock` (line 149)
- `truncate` (line 162)
- `computeBordaScores` (line 198)
- `makeResponses` (line 220)


### `tests/rpc/kanban.test.ts`

**Functions:**
- `seedProject` (line 51)


### `tests/rpc/projects.test.ts`

**Functions:**
- `randomPath` (line 58)


### `tests/rpc/settings.test.ts`

_No exported symbols detected._

### `tests/scheduler/cron.test.ts`

**Functions:**
- `insertJob` (line 53)
- `getJob` (line 80)
- `getHistory` (line 87)


### `tests/scheduler/event-bus.test.ts`

**Functions:**
- `handler` (line 96)
- `handlerA` (line 111)
- `handlerB` (line 112)


### `tests/scheduler/missed-recovery.test.ts`

**Functions:**
- `shouldRecover` (line 23)


### `tests/tools/file-tracker.test.ts`

**Functions:**
- `writeTmpFile` (line 34)


### `tests/tools/ignore.test.ts`

**Functions:**
- `writeGitignore` (line 49)


### `tests/tools/safety.test.ts`

_No exported symbols detected._

### `tests/tools/system.test.ts`

**Functions:**
- `execTool` (line 27)


### `tests/tools/truncation.test.ts`

_No exported symbols detected._

### `tests/tools/validate-path.test.ts`

_No exported symbols detected._

## Data Flow

Repository → Model/Schema

## Change Recipe

To add a new feature to the **tests** domain:

1. Update the model/schema in `src/tests/`
2. Add or update tests
