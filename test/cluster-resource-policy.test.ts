import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  acceptSharingManagerTransfer, addSharingMember, commitSharingManagerTransfer,
  createSharingCluster, listResourceShares, prepareSharingManagerTransfer,
  registerOwnedResource, removeSharingMember, setAutoShareProjects,
} from "../src/cluster-sharing-policy.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey, signClusterMessage } from "../src/cluster-identity.js";
import {
  ResourceSharingError, acknowledgeResourcePolicyDelivery, applyResourcePolicy,
  deleteSharedResource, ensureResourceSharingSchema, getResourcePolicyState,
  listResourcePolicyDeliveries, mayForwardResourceContext, queueResourcePolicyBootstrap,
  registerLocalSharingResource, updateResourceSharing, type PolicyBody,
} from "../src/cluster-sharing.js";

const A="00000000-0000-4000-8000-000000000001", B="00000000-0000-4000-8000-000000000002";
const C="00000000-0000-4000-8000-000000000003";
const X="10000000-0000-4000-8000-000000000001", Y="10000000-0000-4000-8000-000000000002";
function db(node:string):DatabaseSync { const value=new DatabaseSync(":memory:"); value.exec("PRAGMA foreign_keys=ON"); ensureResourceSharingSchema(value); getOrCreateClusterIdentity(value,node); return value; }
function topology(value:DatabaseSync, third=false):void { createSharingCluster(value,{id:X,name:"X"},A); addSharingMember(value,X,A,B,1); if(third)addSharingMember(value,X,A,C,1); }
function pin(owner:DatabaseSync, receiver:DatabaseSync):void { pinClusterPublicKey(receiver,A,getOrCreateClusterIdentity(owner,A).publicKey); }
function delivery(owner:DatabaseSync, peer:string, kind:"project"|"secret", operation?:string) {
  return listResourcePolicyDeliveries(owner).find((item)=>item.peerId===peer&&item.statement.body.kind===kind&&(!operation||item.statement.body.operation===operation))!;
}

test("owner registration is idempotent, auto-shares, and CAS is atomic",()=>{
  const value=db(A); try { topology(value); setAutoShareProjects(value,X,A,true);
    assert.deepEqual(registerLocalSharingResource(value,A,{kind:"project",id:"p"}),{kind:"project",resourceId:"p",ownerNodeId:A,generation:1,deleted:false});
    assert.deepEqual(listResourceShares(value,"project","p"),[{clusterId:X,projectId:null}]);
    const first=listResourcePolicyDeliveries(value); assert.equal(first.length,1);
    registerLocalSharingResource(value,A,{kind:"project",id:"p"}); assert.equal(listResourcePolicyDeliveries(value).length,1);
    assert.throws(()=>updateResourceSharing(value,A,"project","p",0,[]),(error)=>error instanceof ResourceSharingError&&error.statusCode===409);
    assert.equal(getResourcePolicyState(value,"project","p").generation,1);
    const next=updateResourceSharing(value,A,"project","p",1,[]); assert.equal(next.generation,2); assert.deepEqual(listResourceShares(value,"project","p"),[]);
    assert.equal(listResourcePolicyDeliveries(value).at(-1)?.statement.body.operation,"unshare");
  } finally { value.close(); }
});

test("signed delivery verifies pinned owner and rejects tampering",()=>{
  const owner=db(A), receiver=db(B); try { topology(owner); topology(receiver); const identity=getOrCreateClusterIdentity(owner,A); pinClusterPublicKey(receiver,A,identity.publicKey);
    registerLocalSharingResource(owner,A,{kind:"project",id:"p"}); updateResourceSharing(owner,A,"project","p",1,[{clusterId:X,projectId:null}]);
    const delivery=listResourcePolicyDeliveries(owner)[0]; applyResourcePolicy(receiver,B,A,delivery.statement);
    assert.deepEqual(getResourcePolicyState(receiver,"project","p"),{kind:"project",resourceId:"p",ownerNodeId:A,generation:2,deleted:false});
    assert.throws(()=>applyResourcePolicy(receiver,B,A,{...delivery.statement,body:{...delivery.statement.body,resourceId:"q"}}),/signature/i);
    acknowledgeResourcePolicyDelivery(owner,delivery.operationId,delivery.peerId); assert.equal(listResourcePolicyDeliveries(owner).length,0);
  } finally { owner.close(); receiver.close(); }
});

test("tickets inherit parent state and reject independent writes",()=>{
  const value=db(A); try { registerLocalSharingResource(value,A,{kind:"project",id:"p"}); registerOwnedResource(value,{kind:"ticket",id:"t",ownerNodeId:A,projectId:"p"},A);
    assert.equal(getResourcePolicyState(value,"ticket","t").resourceId,"p");
    assert.throws(()=>updateResourceSharing(value,A,"ticket","t",1,[]),/inherited/i);
  } finally { value.close(); }
});

test("forwarding requires live owner admission and effective grants for both recipients",()=>{
  const owner=db(A), receiver=db(B); try {
    topology(owner,true); topology(receiver,true); pin(owner,receiver);
    registerLocalSharingResource(owner,A,{kind:"project",id:"p"});
    updateResourceSharing(owner,A,"project","p",1,[{clusterId:X,projectId:null}]);
    const statement=delivery(owner,B,"project","upsert").statement;
    applyResourcePolicy(receiver,B,A,statement);
    const source=statement.body.context;
    assert.equal(source.kind,"cluster");
    if(source.kind!=="cluster")throw new Error("expected cluster context");
    const destination={kind:"cluster" as const,id:X,ownerJoinSequence:1,recipientJoinSequence:3};
    assert.equal(mayForwardResourceContext(receiver,B,C,"project","p",source,destination),true);
    assert.equal(mayForwardResourceContext(receiver,B,C,"project","missing",source,destination),false);
    assert.equal(mayForwardResourceContext(receiver,B,C,"project","p",source,{...destination,ownerJoinSequence:2}),false);
    assert.throws(()=>mayForwardResourceContext(receiver,"bad",C,"project","p",source,destination));
    prepareSharingManagerTransfer(receiver,X,A,B,1,"30000000-0000-4000-8000-000000000001");
    acceptSharingManagerTransfer(receiver,X,B,"30000000-0000-4000-8000-000000000001");
    commitSharingManagerTransfer(receiver,X,A,"30000000-0000-4000-8000-000000000001");
    removeSharingMember(receiver,X,A,A);
    assert.equal(mayForwardResourceContext(receiver,B,C,"project","p",source,destination),false);
    receiver.close();
    assert.throws(()=>mayForwardResourceContext(receiver,B,C,"project","p",source,destination));
  } finally { owner.close(); }
});

test("delete emits one terminal tombstone per admission and every queued tombstone applies",()=>{
  const owner=db(A), receiver=db(B); try {
    topology(owner); topology(receiver); pin(owner,receiver);
    registerLocalSharingResource(owner,A,{kind:"project",id:"p"});
    updateResourceSharing(owner,A,"project","p",1,[{clusterId:X,projectId:null}]);
    const staleUpsert=delivery(owner,B,"project","upsert").statement;
    applyResourcePolicy(receiver,B,A,staleUpsert);
    deleteSharedResource(owner,A,"project","p",2);
    const deletes=listResourcePolicyDeliveries(owner).filter((item)=>item.statement.body.operation==="delete");
    assert.equal(deletes.length,1);
    applyResourcePolicy(receiver,B,A,deletes[0].statement);
    acknowledgeResourcePolicyDelivery(owner,deletes[0].operationId,B);
    assert.equal(listResourcePolicyDeliveries(owner).some((item)=>item.operationId===deletes[0].operationId),false);
    assert.throws(()=>applyResourcePolicy(receiver,B,A,staleUpsert),/deleted|stale/i);
  } finally { owner.close(); receiver.close(); }
});

test("old admission revocation does not cancel a rejoined recipient upsert",()=>{
  const owner=db(A); try {
    topology(owner); registerLocalSharingResource(owner,A,{kind:"project",id:"p"});
    updateResourceSharing(owner,A,"project","p",1,[{clusterId:X,projectId:null}]);
    removeSharingMember(owner,X,B,B); addSharingMember(owner,X,A,B,1);
    queueResourcePolicyBootstrap(owner,A,"project","p");
    updateResourceSharing(owner,A,"project","p",2,[{clusterId:X,projectId:null}]);
    const queued=listResourcePolicyDeliveries(owner).filter((item)=>item.peerId===B);
    assert.ok(queued.some((item)=>item.statement.body.operation==="upsert"&&item.statement.body.context.kind==="cluster"&&item.statement.body.context.recipientJoinSequence===3));
    assert.ok(queued.some((item)=>item.statement.body.operation==="unshare"&&item.statement.body.context.kind==="cluster"&&item.statement.body.context.recipientJoinSequence===2));
  } finally { owner.close(); }
});

test("project revocation permanently prunes that context's secret scope",()=>{
  const owner=db(A), receiver=db(B); try {
    topology(owner); topology(receiver); createSharingCluster(owner,{id:Y,name:"Y"},A); createSharingCluster(receiver,{id:Y,name:"Y"},A);
    addSharingMember(owner,Y,A,B,1); addSharingMember(receiver,Y,A,B,1); pin(owner,receiver);
    registerLocalSharingResource(owner,A,{kind:"project",id:"p"});
    updateResourceSharing(owner,A,"project","p",1,[{clusterId:X,projectId:null}]);
    applyResourcePolicy(receiver,B,A,delivery(owner,B,"project","upsert").statement);
    registerLocalSharingResource(owner,A,{kind:"secret",id:"s"});
    updateResourceSharing(owner,A,"secret","s",1,[{clusterId:X,projectId:"p"}]);
    applyResourcePolicy(receiver,B,A,delivery(owner,B,"secret","upsert").statement);
    updateResourceSharing(owner,A,"project","p",2,[]);
    applyResourcePolicy(receiver,B,A,delivery(owner,B,"project","unshare").statement);
    updateResourceSharing(owner,A,"project","p",3,[{clusterId:X,projectId:null}]);
    applyResourcePolicy(receiver,B,A,listResourcePolicyDeliveries(owner).find((item)=>item.statement.body.kind==="project"&&item.statement.body.generation===4&&item.peerId===B)!.statement);
    const body:PolicyBody={kind:"secret",resourceId:"s",ownerNodeId:A,writerNodeId:A,generation:3,operationId:"40000000-0000-4000-8000-000000000001",operation:"upsert",recipientNodeId:B,context:{kind:"cluster",id:Y,ownerJoinSequence:1,recipientJoinSequence:2},shares:[{clusterId:Y,projectId:null}]};
    applyResourcePolicy(receiver,B,A,{body,signature:signClusterMessage(owner,A,"resource-policy",JSON.stringify(body))});
    assert.deepEqual(listResourceShares(receiver,"secret","s"),[{clusterId:Y,projectId:null}]);
  } finally { owner.close(); receiver.close(); }
});
