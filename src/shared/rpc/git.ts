export type GitRequests = {
  // Core git operations
  getGitStatus: {
    params: { projectId: string };
    response: { files: Array<{ status: string; file: string }> };
  };
  getGitBranches: {
    params: { projectId: string };
    response: { branches: Array<{ name: string; isCurrent: boolean; isRemote: boolean }> };
  };
  /** Live current branch (actual checked-out HEAD). null = not a git repo. Fast + non-blocking;
   *  for the navbar branch indicator. Detached HEAD returns "detached@<shortsha>". */
  getCurrentBranch: {
    params: { projectId: string };
    response: { branch: string | null };
  };
  getGitLog: {
    params: { projectId: string; limit?: number };
    response: { commits: Array<{ hash: string; author: string; message: string; date: string }> };
  };
  getGitDiff: {
    params: { projectId: string; file?: string };
    response: { diff: string };
  };
  getCommitFiles: {
    params: { projectId: string; hash: string };
    response: { files: Array<{ status: string; file: string }> };
  };
  gitCheckout: {
    params: { projectId: string; branch: string };
    response: { success: boolean; error?: string };
  };
  gitCreateBranch: {
    params: { projectId: string; name: string };
    response: { success: boolean; error?: string };
  };
  gitDeleteBranch: {
    params: { projectId: string; name: string };
    response: { success: boolean; error?: string };
  };
  gitStageFiles: {
    params: { projectId: string; files: string[] };
    response: { success: boolean; error?: string };
  };
  gitCommit: {
    params: { projectId: string; message: string };
    response: { success: boolean; error?: string };
  };
  gitPush: {
    params: { projectId: string };
    response: { success: boolean; output?: string; error?: string };
  };
  gitPull: {
    params: { projectId: string; remoteBranch?: string };
    response: { success: boolean; output?: string; error?: string; noTracking?: boolean };
  };
  gitMergeBranch: {
    params: { projectId: string; branch: string; strategy?: string };
    response: { success: boolean; hasConflicts?: boolean; conflictFiles?: string[]; error?: string };
  };
  gitRebaseBranch: {
    params: { projectId: string; onto: string };
    response: { success: boolean; error?: string };
  };
  gitAbortMerge: {
    params: { projectId: string };
    response: { success: boolean; error?: string };
  };

  // Conflict resolution
  getConflicts: {
    params: { projectId: string };
    response: { files: string[] };
  };
  getConflictDiff: {
    params: { projectId: string; file: string };
    response: { diff: string };
  };

  // Pull requests
  getPullRequests: {
    params: { projectId: string; state?: string };
    response: Array<{
      id: string;
      projectId: string;
      prNumber: number | null;
      title: string;
      description: string | null;
      sourceBranch: string;
      targetBranch: string;
      state: string;
      authorName: string | null;
      linkedTaskId: string | null;
      mergeStrategy: string | null;
      mergedAt: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  createPullRequest: {
    params: { projectId: string; title: string; description?: string; sourceBranch: string; targetBranch: string; linkedTaskId?: string };
    response: { id: string; error?: string };
  };
  updatePullRequest: {
    params: { id: string; title?: string; description?: string; state?: string };
    response: { success: boolean };
  };
  mergePullRequest: {
    params: { id: string; strategy: "merge" | "squash" | "rebase"; deleteBranch?: boolean };
    response: { success: boolean; error?: string };
  };
  deletePullRequest: {
    params: { id: string };
    response: { success: boolean };
  };
  getPrDiff: {
    params: { id: string };
    response: { diff: string };
  };
  getPrComments: {
    params: { prId: string };
    response: Array<{
      id: string;
      prId: string;
      file: string | null;
      lineNumber: number | null;
      content: string;
      authorName: string;
      authorType: string;
      createdAt: string;
    }>;
  };
  addPrComment: {
    params: { prId: string; content: string; file?: string; lineNumber?: number; authorName?: string; authorType?: string };
    response: { id: string };
  };
  deletePrComment: {
    params: { id: string };
    response: { success: boolean };
  };
  generatePrDescription: {
    params: { projectId: string; sourceBranch: string; targetBranch: string };
    response: { description: string };
  };

  // Branch strategy
  getBranchStrategy: {
    params: { projectId: string };
    response: {
      id: string;
      projectId: string;
      model: string;
      defaultBranch: string;
      featureBranchPrefix: string;
      releaseBranchPrefix: string;
      hotfixBranchPrefix: string;
      namingTemplate: string;
      protectedBranches: string[];
      autoCleanup: boolean;
    } | null;
  };
  saveBranchStrategy: {
    params: {
      projectId: string;
      model?: string;
      defaultBranch?: string;
      featureBranchPrefix?: string;
      releaseBranchPrefix?: string;
      hotfixBranchPrefix?: string;
      namingTemplate?: string;
      protectedBranches?: string[];
      autoCleanup?: boolean;
    };
    response: { success: boolean };
  };
  createFeatureBranch: {
    params: { projectId: string; taskId: string; taskTitle: string };
    response: { success: boolean; branchName?: string; error?: string };
  };
  getMergedBranches: {
    params: { projectId: string };
    response: { branches: string[] };
  };
  cleanupMergedBranches: {
    params: { projectId: string };
    response: { deleted: string[]; errors: string[] };
  };

  getGithubIssues: {
    params: { projectId: string; state?: string };
    response: Array<{ id: string; projectId: string; githubIssueNumber: number; taskId: string | null; title: string; body: string | null; state: string; labels: string[]; githubCreatedAt: string | null; syncedAt: string }>;
  };
  syncGithubIssues: {
    params: { projectId: string };
    response: { synced: number; created: number; closed: number; error?: string };
  };
  createGithubIssueFromTask: {
    params: { taskId: string; projectId: string };
    response: { success: boolean; issueNumber?: number; error?: string };
  };
  linkIssueToTask: {
    params: { issueId: string; taskId: string | null };
    response: { success: boolean };
  };
  validateGithubToken: {
    params: { token: string };
    response: { valid: boolean; username?: string; error?: string };
  };
  /** Per-project GitHub token config for the Project Settings UI (token value never returned). */
  getProjectGitHubTokenInfo: {
    params: { projectId: string };
    response: { source: "global" | "custom"; hasCustomToken: boolean };
  };
};
