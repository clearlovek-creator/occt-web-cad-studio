import type { ModelingCommandInput, ModelingCommandResponse } from "./command-contract";
import { ModelingController } from "./modeling-controller";
import { AGENT_API_ROOT, AGENT_BACKEND } from "../api-config.ts";
import {initialWorkspaceId} from './initial-workspace';


export const modelingController = new ModelingController({ documentId: initialWorkspaceId(), serverDocumentId:'default', agentApiRoot: AGENT_API_ROOT, agentBackend: AGENT_BACKEND, taskControl:true });

export function executeModelingCommand<TResponse extends ModelingCommandResponse = ModelingCommandResponse>(
  request: ModelingCommandInput,
) {
  return modelingController.execute<TResponse>(request);
}
