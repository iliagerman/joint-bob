import {execFileSync} from 'node:child_process';
import type {DevEnvironment,SeededNode} from './dev-nodes.js';

export async function signedNodeRequest(environment:DevEnvironment,sender:SeededNode,recipient:SeededNode,method:string,target:string,payload?:unknown):Promise<Response>{
 const body=payload===undefined?'':JSON.stringify(payload);
 const authorization=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
  import {DatabaseSync} from 'node:sqlite';
  import {signClusterRequest} from './src/cluster-protocol.ts';
  const db=new DatabaseSync(process.env.JOINT_BOB_DATA_DIR+'/node.db');
  process.stdout.write(signClusterRequest(db,${JSON.stringify(sender.nodeId)},${JSON.stringify(recipient.nodeId)},${JSON.stringify(method)},${JSON.stringify(target)},Buffer.from(${JSON.stringify(body)})));db.close();
 `],{env:{...process.env,HOME:environment.home,JOINT_BOB_DATA_DIR:sender.dataDir},encoding:'utf8'});
 return fetch(new URL(target,recipient.url),{method,headers:{'Content-Type':'application/json',Authorization:authorization},...(payload===undefined?{}:{body})});
}
