import * as generalChatRpc from "../rpc/general-chat";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (params: any) => any> = {
	listGeneralChatConversations: () => generalChatRpc.listGeneralChatConversations(),
	listArchivedGeneralChatConversations: () => generalChatRpc.listArchivedGeneralChatConversations(),
	createGeneralChatConversation: (params) => generalChatRpc.createGeneralChatConversation(params),
	renameGeneralChatConversation: (params) => generalChatRpc.renameGeneralChatConversation(params),
	deleteGeneralChatConversation: (params) => generalChatRpc.deleteGeneralChatConversation(params),
	pinGeneralChatConversation: (params) => generalChatRpc.pinGeneralChatConversation(params),
	archiveGeneralChatConversation: (params) => generalChatRpc.archiveGeneralChatConversation(params),
	forkGeneralChatConversation: (params) => generalChatRpc.forkGeneralChatConversation(params),
	getGeneralChatMessages: (params) => generalChatRpc.getGeneralChatMessages(params),
	getGeneralChatStatus: (params) => generalChatRpc.getGeneralChatStatus(params),
	deleteGeneralChatMessage: (params) => generalChatRpc.deleteGeneralChatMessage(params),
	clearGeneralChatConversation: (params) => generalChatRpc.clearGeneralChatConversation(params),
	sendGeneralChatMessage: (params) => generalChatRpc.sendGeneralChatMessage(params),
	stopGeneralChatGeneration: (params) => generalChatRpc.stopGeneralChatGeneration(params),
	setGeneralChatDeepResearchMode: (params) => generalChatRpc.setGeneralChatDeepResearchMode(params),
	compactGeneralChatConversation: (params) => generalChatRpc.compactGeneralChatConversation(params),
	getGeneralChatContextLimit: (params) => generalChatRpc.getGeneralChatContextLimit(params),
};
