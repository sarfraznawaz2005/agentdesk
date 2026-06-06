export type CustomEnvVar = {
  id: string;
  name: string;
  value: string;
  createdAt: string;
  updatedAt: string;
};

export type EnvVarsRequests = {
  listCustomEnvVars:   { params: Record<string, never>;                         response: CustomEnvVar[] };
  createCustomEnvVar:  { params: { name: string; value: string };               response: CustomEnvVar };
  updateCustomEnvVar:  { params: { id: string; name?: string; value?: string }; response: CustomEnvVar };
  deleteCustomEnvVar:  { params: { id: string };                                response: { success: boolean } };
};
