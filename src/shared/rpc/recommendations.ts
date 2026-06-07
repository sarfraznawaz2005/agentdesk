export type DependencyId = "git" | "node" | "bun" | "python";

export type DependencyStatus = {
	id: DependencyId;
	installed: boolean;
	version?: string;
};

export type RecommendationsRequests = {
	checkDependencies: { params: Record<string, never>; response: DependencyStatus[] };
	installDependency:  { params: { dependencyId: DependencyId };  response: { queued: boolean } };
};
