export interface ReleaseEntry {
  version: string;
  title: string;
  changes: string[];
}

export type WhatsNewRequests = {
  getWhatsNewStatus: {
    params: Record<string, never>;
    response: {
      shouldShow: boolean;
      /** True when the app version increased since last launch (upgrade, not downgrade). Used to show the "Updated to vX.Y.Z" toast. */
      didUpdate: boolean;
      entries: ReleaseEntry[];
      currentVersion: string;
      /** The version the user was on before this update, or null if no change. */
      previousVersion: string | null;
    };
  };
  markWhatsNewSeen: {
    params: Record<string, never>;
    response: { success: boolean };
  };
};
