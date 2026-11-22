// The @slime-cloud/core/models entry: what a model provider outside core needs.
// Implement ModelClient, then modelRoles(client) gives the Generator, Reviewer and Optimizer.
export type { ModelCall, ModelClient, ModelReply, OutputMode } from './model-client.js';
export { modelRoles, providerRoles, type ModelRoles, type ProviderRoles } from './roles.js';
export { parseJsonReply } from './json-reply.js';
