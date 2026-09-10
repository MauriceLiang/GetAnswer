export interface SidePanelActionApi {
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void> | void;
}

export async function enableSidePanelOnAction(sidePanel: SidePanelActionApi): Promise<void> {
  await sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
