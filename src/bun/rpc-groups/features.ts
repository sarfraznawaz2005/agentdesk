import * as playgroundRpc from "../rpc/playground";
import * as issueFixerRpc from "../rpc/issue-fixer";
import * as remoteSyncRpc from "../rpc/remote-sync";
import * as activityRpc from "../rpc/activity";
import * as freelanceRpc from "../rpc/freelance";
import * as freelanceChatRpc from "../rpc/freelance-chat";
import * as freelanceWizardRpc from "../rpc/freelance-wizard";
import * as freelanceInboxRpc from "../rpc/freelance-inbox";
import * as freelanceOutboxRpc from "../rpc/freelance-outbox";
import * as freelanceExpertRpc from "../rpc/freelance-expert";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (params: any) => any> = {
	// Council (dynamic imports — change path from ./rpc/council to ../rpc/council)
	startCouncil: async (params) => {
		const { startCouncilSession } = await import("../rpc/council");
		return startCouncilSession(params.query, params.context);
	},
	stopCouncil: async (params) => {
		const { stopCouncilSession } = await import("../rpc/council");
		stopCouncilSession(params.sessionId);
		return { success: true };
	},
	answerCouncilQuestion: async (params) => {
		const { answerCouncilQuestion } = await import("../rpc/council");
		answerCouncilQuestion(params.sessionId, params.questionId, params.answer);
		return { success: true };
	},

	// Playground
	playgroundSend: (params) => playgroundRpc.playgroundSend(params),
	playgroundStop: () => playgroundRpc.playgroundStop(),
	newPlayground: () => playgroundRpc.newPlayground(),
	getPlaygroundState: () => playgroundRpc.getPlaygroundState(),
	createProjectFromPlayground: () => playgroundRpc.createProjectFromPlayground(),
	exportPlaygroundZip: () => playgroundRpc.exportPlaygroundZip(),
	getPlaygroundSource: () => playgroundRpc.getPlaygroundSource(),
	savePlaygroundFile: (params) => playgroundRpc.savePlaygroundFile(params),
	setPlaygroundPreviewUrl: (params) => playgroundRpc.setPlaygroundPreviewUrl(params),
	getPlaygroundDevServers: () => playgroundRpc.getPlaygroundDevServers(),
	stopPlaygroundDevServer: (params) => playgroundRpc.stopPlaygroundDevServer(params),
	startPlaygroundDevServer: (params) => playgroundRpc.startPlaygroundDevServer(params),
	deployPlayground: () => playgroundRpc.deployPlayground(),

	// Issue Fixer
	getIssueFixerConfig: (params) => issueFixerRpc.getIssueFixerConfig(params),
	saveIssueFixerConfig: (params) => issueFixerRpc.saveIssueFixerConfig(params),
	listIssueFixRuns: (params) => issueFixerRpc.listIssueFixRuns(params),
	getIssueFixRun: (params) => issueFixerRpc.getIssueFixRun(params),
	getActiveIssueFixRun: (params) => issueFixerRpc.getActiveIssueFixRun(params),
	pollIssueFixerNow: (params) => issueFixerRpc.pollIssueFixerNow(params),
	cancelIssueFixRun: (params) => issueFixerRpc.cancelIssueFixRun(params),
	triggerIssueFixManually: (params) => issueFixerRpc.triggerIssueFixManually(params),
	getIssueFixerKeywordCatalog: () => issueFixerRpc.getIssueFixerKeywordCatalog(),

	// Remote Sync
	getRemoteSyncConfig: (params) => remoteSyncRpc.getRemoteSyncConfig(params),
	saveRemoteSyncConfig: (params) => remoteSyncRpc.saveRemoteSyncConfig(params),
	revealRemoteSyncSecret: (params) => remoteSyncRpc.revealRemoteSyncSecret(params),
	testRemoteConnection: (params) => remoteSyncRpc.testRemoteConnection(params),
	browseRemoteDir: (params) => remoteSyncRpc.browseRemoteDir(params),
	computeRemotePullConflicts: (params) => remoteSyncRpc.computeRemotePullConflicts(params),
	startRemotePull: (params) => remoteSyncRpc.startRemotePull(params),
	computeRemotePushDiff: (params) => remoteSyncRpc.computeRemotePushDiff(params),
	getRemotePushFileDiff: (params) => remoteSyncRpc.getRemotePushFileDiff(params),
	startRemotePush: (params) => remoteSyncRpc.startRemotePush(params),
	listRemoteSyncRuns: (params) => remoteSyncRpc.listRemoteSyncRuns(params),
	cancelRemoteSync: (params) => remoteSyncRpc.cancelRemoteSync(params),

	// Unread activity
	getUnreadActivity: () => activityRpc.getUnreadActivity(),
	markActivitySeen: (params) => activityRpc.markActivitySeen(params),

	// Freelance
	"freelance.getFeatureEnabled": () => freelanceRpc.getFeatureEnabled(),
	"freelance.getSettings": () => freelanceRpc.getSettings(),
	"freelance.saveSettings": (params) => freelanceRpc.saveSettings(params),
	"freelance.getListings": (params) => freelanceRpc.getListings(params),
	"freelance.getListingCounts": () => freelanceRpc.getListingCounts(),
	"freelance.approveListing": (params) => freelanceRpc.approveListing(params),
	"freelance.deleteListing": (params) => freelanceRpc.deleteListing(params),
	"freelance.triggerFetch": () => freelanceRpc.triggerFetch(),
	"freelance.deleteAllListings": () => freelanceRpc.deleteAllListings(),
	"freelance.chat.getMessages": (params) => freelanceChatRpc.getMessages(params),
	"freelance.chat.sendMessage": (params) => freelanceChatRpc.sendMessage(params),
	"freelance.chat.regenerate": (params) => freelanceChatRpc.regenerate(params),
	"freelance.chat.clearMessages": (params) => freelanceChatRpc.clearMessages(params),
	"freelance.chat.stop": (params) => freelanceChatRpc.stopChat(params),
	"freelance.wizard.start": (params) => freelanceWizardRpc.startWizard(params),
	"freelance.wizard.stop": (params) => freelanceWizardRpc.stopWizard(params),
	"freelance.wizard.analyzeListing": (params) => freelanceWizardRpc.analyzeListing(params),
	"freelance.shortlistListings": (params) => freelanceWizardRpc.shortlistListings(params),
	"freelance.markListingDone": (params) => freelanceRpc.markListingDone(params),
	"freelance.getCurrencyRates": () => freelanceRpc.getCurrencyRatesHandler(),
	"freelance.inbox.ingest": (params) => freelanceInboxRpc.ingest(params),
	"freelance.inbox.getAccount": (params) => freelanceInboxRpc.getAccount(params),
	"freelance.inbox.getThreads": (params) => freelanceInboxRpc.getThreads(params),
	"freelance.inbox.getMessages": (params) => freelanceInboxRpc.getMessages(params),
	"freelance.inbox.logSync": (params) => freelanceInboxRpc.logSync(params),
	"freelance.account.disconnect": (params) => freelanceInboxRpc.disconnect(params),
	"freelance.account.setAutonomy": (params) => freelanceInboxRpc.setAutonomy(params),
	"freelance.autoearn.isAvailable": () => freelanceInboxRpc.getAutoEarnAvailable(),
	"freelance.autoearn.getSettings": () => freelanceInboxRpc.getAutoEarn(),
	"freelance.autoearn.saveSettings": (params) => freelanceInboxRpc.saveAutoEarn(params),
	"freelance.outbox.list": (params) => freelanceOutboxRpc.list(params),
	"freelance.outbox.draftReply": (params) => freelanceOutboxRpc.draftReply(params),
	"freelance.outbox.draftBid": (params) => freelanceOutboxRpc.draftBid(params),
	"freelance.outbox.updateDraft": (params) => freelanceOutboxRpc.updateDraft(params),
	"freelance.outbox.approveSend": (params) => freelanceOutboxRpc.approveSend(params),
	"freelance.outbox.markResult": (params) => freelanceOutboxRpc.markResult(params),
	"freelance.outbox.retry": (params) => freelanceOutboxRpc.retry(params),
	"freelance.outbox.markBidPrefilled": (params) => freelanceOutboxRpc.markBidPrefilled(params),
	"freelance.outbox.reject": (params) => freelanceOutboxRpc.reject(params),
	"freelance.outbox.killSwitch": () => freelanceOutboxRpc.killSwitch(),
	"freelance.governor.getState": () => freelanceOutboxRpc.governorState(),
	"freelance.governor.pause": (params) => freelanceOutboxRpc.pauseAutonomy(params),
	"freelance.governor.resume": () => freelanceOutboxRpc.resumeAutonomy(),
	"freelance.governor.checkStuck": () => freelanceOutboxRpc.checkStuck(),
	"freelance.expert.getEscalations": (params) => freelanceExpertRpc.getEscalations(params),
	"freelance.expert.resolveEscalation": (params) => freelanceExpertRpc.resolveEscalation(params),
	"freelance.expert.approveDelivery": (params) => freelanceExpertRpc.approveDelivery(params),
	"freelance.expert.getJobs": (params) => freelanceExpertRpc.getJobs(params),
	"freelance.expert.getJobTimeline": (params) => freelanceExpertRpc.getJobTimeline(params),
	"freelance.expert.getEarnings": () => freelanceExpertRpc.getEarningsSummary(),
};
