export type SkillValidationError = {
  field: string;
  message: string;
};

export interface SkillsChatMessageDto {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export type SkillsRequests = {
  getSkills: {
    params: Record<string, never>;
    response: Array<{
      name: string;
      description: string;
      preferredAgent: string | null;
      allowedTools: string[];
      argumentHint: string | null;
      supportingFileCount: number;
      errors: SkillValidationError[];
      isBundled: boolean;
    }>;
  };
  getSkill: {
    params: { name: string };
    response: {
      name: string;
      description: string;
      preferredAgent: string | null;
      allowedTools: string[];
      argumentHint: string | null;
      content: string;
      supportingFiles: string[];
      dirPath: string;
      errors: SkillValidationError[];
    } | null;
  };
  refreshSkills: {
    params: Record<string, never>;
    response: { count: number };
  };
  getSkillsDirectory: {
    params: Record<string, never>;
    response: { path: string };
  };
  openSkillInEditor: {
    params: { name: string };
    response: { success: boolean; error?: string };
  };
  openSkillsFolder: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  deleteSkill: {
    params: { name: string };
    response: { success: boolean; error?: string };
  };
  getAvailableTools: {
    params: Record<string, never>;
    response: Array<{ name: string; category: string; description: string }>;
  };
  "skillsChat.getMessages": {
    params: Record<string, never>;
    response: { messages: SkillsChatMessageDto[] };
  };
  "skillsChat.sendMessage": {
    params: { content: string };
    response: { success: boolean; messageId: string };
  };
  "skillsChat.regenerate": {
    params: Record<string, never>;
    response: { success: boolean; messageId: string };
  };
  "skillsChat.clearMessages": {
    params: Record<string, never>;
    response: { success: boolean };
  };
  "skillsChat.stop": {
    params: Record<string, never>;
    response: { success: boolean };
  };
};
