export interface GameIdentity {
  simulationVersion: number;
  simulationBuild: string;
  contentFormat: number;
  contentHash: string;
  presentationBuild: string;
}

export const SIMULATION_VERSION = 1;
export const CONTENT_FORMAT = 1;
export const CHECKPOINT_FORMAT = 1;
export const REPLAY_FORMAT = 1;
