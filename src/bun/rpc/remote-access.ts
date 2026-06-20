// RPC handlers for the web-app Remote Access feature (TASK-477).
// Thin wrappers over the remote-access manager, shaped to the contract in
// src/shared/rpc/remote-access.ts.

import * as manager from "../remote/manager";

export function getRemoteAccessStatus() {
  return { status: manager.getRemoteAccessStatus() };
}

export async function setRemoteAccessEnabled(params: { enabled: boolean }) {
  return { status: await manager.setRemoteAccessEnabled(params.enabled) };
}

export async function createDevicePairing(params: { name?: string }) {
  return { pairing: await manager.createDevicePairing(params.name) };
}

export function listPairedDevices() {
  return { devices: manager.listPairedDevices() };
}

export function renameDevice(params: { id: string; name: string }) {
  return manager.renameDevice(params.id, params.name);
}

export function revokeDevice(params: { id: string }) {
  return manager.revokeDevice(params.id);
}

export function deleteDevice(params: { id: string }) {
  return manager.deleteDevice(params.id);
}
