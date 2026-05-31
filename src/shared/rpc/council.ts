export type CouncilRequests = {
  startCouncil: {
    params: { query: string; context?: string };
    response: { sessionId: string };
  };
  stopCouncil: {
    params: { sessionId: string };
    response: { success: boolean };
  };
  answerCouncilQuestion: {
    params: { sessionId: string; questionId: string; answer: string };
    response: { success: boolean };
  };
};
