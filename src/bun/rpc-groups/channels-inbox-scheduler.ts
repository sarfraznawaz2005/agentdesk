import * as discordRpc from "../rpc/discord";
import * as whatsappRpc from "../rpc/whatsapp";
import * as emailRpc from "../rpc/email";
import * as notificationsRpc from "../rpc/notifications";
import * as inboxRpc from "../rpc/inbox";
import * as inboxRulesRpc from "../rpc/inbox-rules";
import * as cronRpc from "../rpc/cron";
import * as automationRpc from "../rpc/automation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (params: any) => any> = {
	// Discord
	getDiscordConfigs: () => discordRpc.getDiscordConfigs(),
	saveDiscordConfig: (params) => discordRpc.saveDiscordConfig(params),
	deleteDiscordConfig: (params) => discordRpc.deleteDiscordConfig(params.id),
	testDiscordConnection: (params) => discordRpc.testDiscordConnection(params.token),
	getDiscordStatus: () => discordRpc.getDiscordStatus(),

	// WhatsApp
	getWhatsAppConfigs: () => whatsappRpc.getWhatsAppConfigs(),
	saveWhatsAppConfig: (params) => whatsappRpc.saveWhatsAppConfig(params),
	deleteWhatsAppConfig: (params) => whatsappRpc.deleteWhatsAppConfig(params.id),
	getWhatsAppStatus: (params) => whatsappRpc.getWhatsAppStatus(params.id),
	connectWhatsApp: (params) => whatsappRpc.connectWhatsApp(params.id),
	getDefaultChannelProject: () => whatsappRpc.getDefaultChannelProject(),
	setDefaultChannelProject: (params) => whatsappRpc.setDefaultChannelProject(params.projectId),

	// Email
	getEmailConfigs: () => emailRpc.getEmailConfigs(),
	saveEmailConfig: (params) => emailRpc.saveEmailConfig(params),
	deleteEmailConfig: (params) => emailRpc.deleteEmailConfig(params.id),
	testEmailConnection: (params) => emailRpc.testEmailConnection(params),

	// Notifications
	getNotificationPreferences: (params) => notificationsRpc.getNotificationPreferences(params),
	saveNotificationPreference: (params) => notificationsRpc.saveNotificationPreference(params),

	// Inbox
	getInboxMessages: (params) => inboxRpc.getInboxMessages(params),
	markAsRead: (params) => inboxRpc.markAsRead(params.id),
	markAsUnread: (params) => inboxRpc.markAsUnread(params.id),
	markAllAsRead: (params) => inboxRpc.markAllAsRead(params.projectId),
	getUnreadCount: (params) => inboxRpc.getUnreadCount(params.projectId),
	deleteInboxMessage: (params) => inboxRpc.deleteInboxMessage(params.id),
	searchInboxMessages: (params) => inboxRpc.searchInboxMessages(params.query, params.projectId),
	archiveInboxMessage: (params) => inboxRpc.archiveInboxMessage(params.id),
	unarchiveInboxMessage: (params) => inboxRpc.unarchiveInboxMessage(params.id),
	bulkArchiveInboxMessages: (params) => inboxRpc.bulkArchiveInboxMessages(params.ids),
	bulkDeleteInboxMessages: (params) => inboxRpc.bulkDeleteInboxMessages(params.ids),
	bulkMarkAsReadInboxMessages: (params) => inboxRpc.bulkMarkAsReadInboxMessages(params.ids),
	replyToInboxMessage: (params) => inboxRpc.replyToInboxMessage(params.id, params.content),

	// Inbox Rules
	getInboxRules: (params) => inboxRulesRpc.getInboxRulesList(params.projectId),
	createInboxRule: (params) => inboxRulesRpc.createInboxRule(params),
	updateInboxRule: (params) => inboxRulesRpc.updateInboxRule(params),
	deleteInboxRule: (params) => inboxRulesRpc.deleteInboxRule(params.id),

	// Cron Jobs
	getCronJobs: (params) => cronRpc.getCronJobs(params),
	createCronJob: (params) => cronRpc.createCronJob(params),
	updateCronJob: (params) => cronRpc.updateCronJob(params),
	deleteCronJob: (params) => cronRpc.deleteCronJob(params.id),
	getCronJobHistory: (params) => cronRpc.getCronJobHistory(params),
	clearCronJobHistory: (params) => cronRpc.clearCronJobHistory(params),
	previewCronSchedule: (params) => cronRpc.previewCronSchedule(params),
	triggerCronJob: (params) => cronRpc.triggerCronJob(params),

	// Automation Rules
	getAutomationRules: (params) => automationRpc.getAutomationRules(params),
	createAutomationRule: (params) => automationRpc.createAutomationRule(params),
	updateAutomationRule: (params) => automationRpc.updateAutomationRule(params),
	deleteAutomationRule: (params) => automationRpc.deleteAutomationRule(params.id),
	getAutomationTemplates: () => automationRpc.getAutomationTemplates(),
};
