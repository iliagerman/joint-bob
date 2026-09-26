import type { DatabaseSync } from "node:sqlite";
import { ensureResourceSharingSchema, getResourcePolicyState, registerLocalSharingResource, ResourceSharingError, updateResourceSharing } from "./cluster-sharing.js";
import { ensureProjectMetadataSchema } from "./cluster-project-metadata.js";
import { listResourceShares } from "./cluster-sharing-policy.js";

export function ensureSelectedSharingSchema(db: DatabaseSync): void {
  ensureResourceSharingSchema(db);
  ensureProjectMetadataSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_share_selections(
    cluster_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('project','workspace')),
    resource_id TEXT NOT NULL, PRIMARY KEY(cluster_id,kind,resource_id));
    CREATE TABLE IF NOT EXISTS cluster_v2_workspace_inherited_shares(
      cluster_id TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(cluster_id,project_id))`);
}

export function clusterSharingView(db: DatabaseSync, local: string, clusterId: string) {
  ensureSelectedSharingSchema(db);
  if (!db.prepare("SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?").get(clusterId, local)) {
    throw new ResourceSharingError("Local node is not a cluster member", 403);
  }
  const projects = db.prepare(`SELECT p.id,p.name,p.workspace_id workspaceId FROM projects p
    LEFT JOIN sharing_resource_owners o ON o.kind='project' AND o.resource_id=p.id
    WHERE o.owner_node_id IS NULL OR o.owner_node_id=? ORDER BY p.name,p.id`).all(local) as unknown as Array<{id:string;name:string;workspaceId:string}>;
  const workspaces = db.prepare(`SELECT w.id,w.label FROM workspaces w WHERE NOT EXISTS
    (SELECT 1 FROM cluster_v2_project_workspaces r WHERE r.workspace_id=w.id) ORDER BY w.label,w.id`).all() as unknown as Array<{id:string;label:string}>;
  const selections = db.prepare("SELECT kind,resource_id id FROM cluster_v2_share_selections WHERE cluster_id=? ORDER BY resource_id").all(clusterId) as unknown as Array<{kind:string;id:string}>;
  const pending = db.prepare("SELECT count(*) count FROM cluster_v2_resource_deliveries WHERE context_kind='cluster' AND context_id=?").get(clusterId) as {count:number};
  const workspaceIds=selections.filter(s=>s.kind==='workspace').map(s=>s.id);
  const projectIds=new Set(selections.filter(s=>s.kind==='project').map(s=>s.id));
  const granted=db.prepare("SELECT resource_id id FROM sharing_resource_shares WHERE kind='project' AND cluster_id=?").all(clusterId) as unknown as Array<{id:string}>;
  for(const row of granted){
    const project=projects.find(project=>project.id===row.id);
    if(project&&!workspaceIds.includes(project.workspaceId))projectIds.add(project.id);
  }
  return {projects,workspaces,projectIds:[...projectIds].sort(),workspaceIds,pendingDeliveries:pending.count};
}

export function inheritWorkspaceSharing(db: DatabaseSync, local: string, projectId: string, workspaceId: string): void {
  ensureSelectedSharingSchema(db);
  const state = getResourcePolicyState(db,"project",projectId);
  if(state.ownerNodeId!==local||state.deleted)return;
  const clusters = db.prepare(`SELECT s.cluster_id FROM cluster_v2_share_selections s JOIN sharing_memberships m
    ON m.cluster_id=s.cluster_id AND m.node_id=? WHERE s.kind='workspace' AND s.resource_id=?`).all(local,workspaceId) as unknown as Array<{cluster_id:string}>;
  const inherited=db.prepare('SELECT cluster_id FROM cluster_v2_workspace_inherited_shares WHERE project_id=?').all(projectId) as unknown as Array<{cluster_id:string}>;
  let shares = listResourceShares(db,"project",projectId),changed=false;
  for(const row of inherited){
    if(clusters.some(cluster=>cluster.cluster_id===row.cluster_id))continue;
    const explicit=db.prepare("SELECT 1 FROM cluster_v2_share_selections WHERE cluster_id=? AND kind='project' AND resource_id=?").get(row.cluster_id,projectId);
    if(!explicit){shares=shares.filter(share=>share.clusterId!==row.cluster_id);changed=true;}
    db.prepare('DELETE FROM cluster_v2_workspace_inherited_shares WHERE cluster_id=? AND project_id=?').run(row.cluster_id,projectId);
  }
  for (const row of clusters) if (!shares.some(s=>s.clusterId===row.cluster_id)) {
    shares.push({clusterId:row.cluster_id,projectId:null});changed=true;
    db.prepare('INSERT OR IGNORE INTO cluster_v2_workspace_inherited_shares VALUES(?,?)').run(row.cluster_id,projectId);
  }
  if(changed)updateResourceSharing(db,local,"project",projectId,state.generation,shares);
}

export function updateClusterSelection(db: DatabaseSync, local: string, clusterId: string, projectIds: string[], workspaceIds: string[]) {
  const view = clusterSharingView(db,local,clusterId);
  if (projectIds.some(id=>!view.projects.some(p=>p.id===id)) || workspaceIds.some(id=>!view.workspaces.some(w=>w.id===id))) {
    throw new ResourceSharingError("Selection must contain local-owned projects and local workspaces",403);
  }
  db.exec("SAVEPOINT cluster_selection");
  try {
    db.prepare("INSERT OR IGNORE INTO sharing_explicit_project_selections VALUES(?)").run(clusterId);
    db.prepare("UPDATE sharing_memberships SET auto_share_projects=0 WHERE cluster_id=? AND node_id=?").run(clusterId,local);
    db.prepare("DELETE FROM cluster_v2_share_selections WHERE cluster_id=?").run(clusterId);
    db.prepare('DELETE FROM cluster_v2_workspace_inherited_shares WHERE cluster_id=?').run(clusterId);
    const insert = db.prepare("INSERT INTO cluster_v2_share_selections VALUES(?,?,?)");
    for (const id of new Set(projectIds)) insert.run(clusterId,'project',id);
    for (const id of new Set(workspaceIds)) insert.run(clusterId,'workspace',id);
    for (const project of view.projects) {
      const selected = projectIds.includes(project.id) || workspaceIds.includes(project.workspaceId);
      if(!projectIds.includes(project.id)&&workspaceIds.includes(project.workspaceId))db.prepare('INSERT INTO cluster_v2_workspace_inherited_shares VALUES(?,?)').run(clusterId,project.id);
      const exists = db.prepare("SELECT 1 FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(project.id);
      if (!exists && !selected) continue;
      const state = exists ? getResourcePolicyState(db,"project",project.id) : registerLocalSharingResource(db,local,{kind:"project",id:project.id});
      if (state.deleted) continue;
      const previous = listResourceShares(db,"project",project.id);
      if (previous.some(s=>s.clusterId===clusterId) === selected) continue;
      const shares = previous.filter(s=>s.clusterId!==clusterId);
      if (selected) shares.push({clusterId,projectId:null});
      updateResourceSharing(db,local,"project",project.id,state.generation,shares);
    }
    db.exec("RELEASE cluster_selection");
  } catch (error) { db.exec("ROLLBACK TO cluster_selection; RELEASE cluster_selection"); throw error; }
  return clusterSharingView(db,local,clusterId);
}
