export type SkillValidationError = {
  field: string;
  message: string;
};

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
};
