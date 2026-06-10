export const VERSION = "0.1.0";

export interface DeviceInfo {
  uid: string;
  deviceNumber: number | null;
  port: string;
  version: string | null;
}

export interface Capabilities {
  protocolVersion: number;
  maxDio: number;
  outCount: number;
  inCount: number;
  tsResolutionNs: number;
  maxPatternSteps: number;
  tsRingEvents: number;
  features: number;
}
