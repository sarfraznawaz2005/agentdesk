import * as gitRpc from "../rpc/git";
import * as pullsRpc from "../rpc/pulls";
import * as githubIssuesRpc from "../rpc/github-issues";
import * as issuesRpc from "../rpc/issues";
import { validateGithubToken, getProjectGitHubTokenInfo } from "../rpc/github-api";
import * as branchStrategyRpc from "../rpc/branch-strategy";
import * as analyticsRpc from "../rpc/analytics";
import * as auditRpc from "../rpc/audit";
import * as backupRpc from "../rpc/backup";
import * as exportImportRpc from "../rpc/export-import";
import * as healthRpc from "../rpc/health";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (params: any) => any> = {
	// Git
	getGitStatus: (params) => gitRpc.getGitStatus(params.projectId),
	getGitBranches: (params) => gitRpc.getGitBranches(params.projectId),
	getCurrentBranch: (params) => gitRpc.getCurrentBranch(params.projectId),
	getGitLog: (params) => gitRpc.getGitLog(params.projectId, params.limit),
	getGitDiff: (params) => gitRpc.getGitDiff(params.projectId, params.file),
	getCommitFiles: (params) => gitRpc.getCommitFiles(params.projectId, params.hash),
	gitCheckout: (params) => gitRpc.gitCheckout(params.projectId, params.branch),
	gitCreateBranch: (params) => gitRpc.gitCreateBranch(params.projectId, params.name),
	gitStageFiles: (params) => gitRpc.gitStageFiles(params.projectId, params.files),
	gitCommit: (params) => gitRpc.gitCommit(params.projectId, params.message),
	gitPush: (params) => gitRpc.gitPush(params.projectId),
	gitPull: (params) => gitRpc.gitPull(params.projectId, params.remoteBranch),
	getConflicts: (params) => gitRpc.getConflicts(params.projectId),
	getConflictDiff: (params) => gitRpc.getConflictDiff(params.projectId, params.file),
	gitDeleteBranch: (params) => gitRpc.gitDeleteBranch(params.projectId, params.name),
	gitMergeBranch: (params) => gitRpc.gitMergeBranch(params.projectId, params.branch, params.strategy),
	gitRebaseBranch: (params) => gitRpc.gitRebaseBranch(params.projectId, params.onto),
	gitAbortMerge: (params) => gitRpc.gitAbortMerge(params.projectId),

	// Pull Requests
	getPullRequests: (params) => pullsRpc.getPullRequests(params.projectId, params.state),
	createPullRequest: (params) => pullsRpc.createPullRequest(params),
	updatePullRequest: (params) => pullsRpc.updatePullRequest(params),
	mergePullRequest: (params) => pullsRpc.mergePullRequest(params.id, params.strategy, params.deleteBranch),
	deletePullRequest: (params) => pullsRpc.deletePullRequest(params.id),
	getPrDiff: (params) => pullsRpc.getPrDiff(params.id),
	getPrComments: (params) => pullsRpc.getPrComments(params.prId),
	addPrComment: (params) => pullsRpc.addPrComment(params),
	deletePrComment: (params) => pullsRpc.deletePrComment(params.id),
	generatePrDescription: (params) => pullsRpc.generatePrDescription(params.projectId, params.sourceBranch, params.targetBranch),

	// GitHub Issues (legacy shim — still used by the kanban task-detail modal)
	getGithubIssues: (params) => githubIssuesRpc.getGithubIssues(params.projectId, params.state),
	syncGithubIssues: (params) => githubIssuesRpc.syncGithubIssues(params.projectId),
	createGithubIssueFromTask: (params) => githubIssuesRpc.createGithubIssueFromTask(params.taskId, params.projectId),
	linkIssueToTask: (params) => githubIssuesRpc.linkIssueToTask(params.issueId, params.taskId),
	validateGithubToken: (params) => validateGithubToken(params.token),
	getProjectGitHubTokenInfo: (params) => getProjectGitHubTokenInfo(params.projectId),

	// Multi-source Issues engine
	listIssueSources: (params) => issuesRpc.listIssueSources(params.projectId),
	getIssueSourceConfig: (params) => issuesRpc.getIssueSourceConfig(params.projectId, params.source),
	saveIssueSourceConfig: (params) => issuesRpc.saveIssueSourceConfig(params.projectId, params.source, params.config),
	deleteIssueSourceConfig: (params) => issuesRpc.deleteIssueSourceConfig(params.projectId, params.source),
	testIssueSource: (params) => issuesRpc.testIssueSource(params.projectId, params.source, params.config),
	getExternalIssues: (params) => issuesRpc.getExternalIssues(params.projectId, params.source, params.state),
	syncIssueSource: (params) => issuesRpc.syncIssueSource(params.projectId, params.source),
	linkExternalIssueToTask: (params) => issuesRpc.linkExternalIssueToTask(params.issueId, params.taskId),
	createExternalIssueFromTask: (params) => issuesRpc.createExternalIssueFromTask(params.taskId, params.projectId, params.source),
	getSourceBuckets: (params) => issuesRpc.getSourceBuckets(params.source, params.config),

	// Branch Strategy
	getBranchStrategy: (params) => branchStrategyRpc.getBranchStrategy(params.projectId),
	saveBranchStrategy: (params) => branchStrategyRpc.saveBranchStrategy(params),
	createFeatureBranch: (params) => branchStrategyRpc.createFeatureBranch(params.projectId, params.taskId, params.taskTitle),
	getMergedBranches: (params) => branchStrategyRpc.getMergedBranches(params.projectId),
	cleanupMergedBranches: (params) => branchStrategyRpc.cleanupMergedBranches(params.projectId),

	// Analytics
	getProjectStats: (params) => analyticsRpc.getProjectStats(params.projectId, params.days),
	getAnalyticsSummary: (params) => analyticsRpc.getAnalyticsSummary(params.projectId),

	// Audit Log
	getAuditLog: (params) => auditRpc.getAuditLog(params),
	clearAuditLog: (params) => auditRpc.clearAuditLog(params),

	// Backup/Restore
	createBackup: () => backupRpc.createBackup(),
	listBackups: () => backupRpc.listBackups(),
	deleteBackup: (params) => backupRpc.deleteBackup(params.filename),
	restoreBackup: (params) => backupRpc.restoreBackup(params.filename),

	// Export/Import
	exportProjectData: (params) => exportImportRpc.exportProjectData(params.projectId),
	importProjectData: (params) => exportImportRpc.importProjectData(params.projectId, params.data, params.mode),

	// System Health
	getHealthStatus: () => healthRpc.getHealthStatus(),
	checkDatabase: () => healthRpc.checkDatabase(),
	restartScheduler: () => healthRpc.restartScheduler(),
	cleanupEngines: () => healthRpc.cleanupEngines(),
};
