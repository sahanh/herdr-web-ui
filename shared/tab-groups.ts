/**
 * Tab groups (fork only: sahanh/herdr-web-ui). A group gathers some of one workspace's tabs under
 * one name in the tab strip; herdr does not know of them. They are kept by the server the browser
 * talks to, one file for every PC it reaches, so every browser and device sees the same groups.
 *
 *   GET    /api/mission-control/tab-groups         -> TabGroupsResponse
 *   PUT    /api/mission-control/tab-groups/<id>    TabGroup -> { group: TabGroup }
 *   DELETE /api/mission-control/tab-groups/<id>    -> { ok: true }
 *
 * A tab is in one group at most: a PUT takes its tabs out of the PC's other groups. A group left
 * with no tab is gone, whether a PUT emptied it or another group took its last tab.
 */
export interface TabGroup {
  machine_id: string;
  workspace_id: string;
  name: string;
  /** herdr tab ids, in no particular order: the strip shows them in herdr's order */
  tab_ids: string[];
}

export interface TabGroupsResponse {
  groups: Record<string, TabGroup>;
}
