import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  acceptMembershipManagerTransfer, acknowledgeManagerTransferDelivery, applyMembershipManagerTransfer, applyMembershipSnapshot,
  commitMembershipManagerTransfer, createMembershipCluster, createMembershipInvitation, getMembershipSnapshot,
  listManagerTransferDeliveries, prepareMembershipJoin, prepareMembershipManagerTransfer, redeemMembershipInvitation,
  removeMembershipMember,
} from "../src/cluster-membership.js";
import { clusterPublicKeyFingerprint, pinnedClusterPublicKey } from "../src/cluster-identity.js";
import { getSharingCluster, listSharingClusterMembers } from "../src/cluster-sharing-policy.js";

const A="00000000-0000-4000-8000-000000000001", B="00000000-0000-4000-8000-000000000002", C="00000000-0000-4000-8000-000000000003";
const CLUSTER="10000000-0000-4000-8000-000000000001", TRANSFER="30000000-0000-4000-8000-000000000001";
const TRANSFER2="30000000-0000-4000-8000-000000000002";
const local=(nodeId:string,port:number)=>({nodeId,name:nodeId===A?"Alpha":nodeId===B?"Beta":"Gamma",url:`http://127.0.0.1:${port}`});
const open=(file=":memory:")=>{const db=new DatabaseSync(file);db.exec("PRAGMA foreign_keys=ON");return db;};
function admit(manager:DatabaseSync, receiver:DatabaseSync, nodeId:string, requestId:string, port:number) {
  const invitation=createMembershipInvitation(manager,A,A,CLUSTER,1,1000);
  const request=prepareMembershipJoin(receiver,local(nodeId,port),invitation,clusterPublicKeyFingerprint(invitation.body.manager.publicKey),requestId,1000);
  return redeemMembershipInvitation(manager,A,request,invitation.secret,1000);
}
function setup(a:DatabaseSync,b:DatabaseSync,c:DatabaseSync) {
  createMembershipCluster(a,local(A,4001),{id:CLUSTER,name:"Team"});
  const joinedB=admit(a,b,B,"20000000-0000-4000-8000-000000000002",4002);
  applyMembershipManagerSnapshot(b,B,joinedB);
  const joinedC=admit(a,c,C,"20000000-0000-4000-8000-000000000003",4003);
  applyMembershipManagerSnapshot(b,B,joinedC); applyMembershipManagerSnapshot(c,C,joinedC);
}
function applyMembershipManagerSnapshot(db:DatabaseSync,nodeId:string,snapshot:ReturnType<typeof getMembershipSnapshot>) {
  applyMembershipSnapshot(db,nodeId,snapshot);
}

test("bilateral certificate is the only activation and preserves ranks",()=>{
  const a=open(),b=open(),c=open(); try {
    setup(a,b,c); const ranks=listSharingClusterMembers(a,CLUSTER).map(x=>x.joinSequence);
    const offer=prepareMembershipManagerTransfer(a,A,CLUSTER,B,1,TRANSFER);
    assert.equal(getSharingCluster(a,CLUSTER).managerNodeId,A);
    const acceptance=acceptMembershipManagerTransfer(b,B,offer);
    assert.equal(getSharingCluster(b,CLUSTER).managerNodeId,A);
    assert.throws(()=>createMembershipInvitation(a,A,A,CLUSTER,1,2000),/pending transfer/i);
    assert.throws(()=>createMembershipInvitation(b,B,B,CLUSTER,2,2000),/authority/i);
    const certificate=commitMembershipManagerTransfer(a,A,acceptance);
    assert.deepEqual(commitMembershipManagerTransfer(a,A,acceptance),certificate);
    assert.throws(()=>commitMembershipManagerTransfer(a,C,acceptance),/current manager/i);
    assert.equal(getSharingCluster(a,CLUSTER).managerNodeId,B);
    applyMembershipManagerTransfer(b,B,certificate); applyMembershipManagerTransfer(c,C,certificate);
    assert.throws(()=>applyMembershipSnapshot(c,C,offer.body.base),/stale|activation certificate/i);
    assert.equal(getSharingCluster(b,CLUSTER).managerNodeId,B);
    assert.deepEqual(listSharingClusterMembers(c,CLUSTER).map(x=>x.joinSequence),ranks);
    assert.equal(listManagerTransferDeliveries(a).length,2);
    assert.throws(()=>createMembershipInvitation(a,A,A,CLUSTER,2,2000),/authority/i);
    assert.doesNotThrow(()=>createMembershipInvitation(b,B,B,CLUSTER,2,2000));
    assert.throws(()=>removeMembershipMember(b,B,B,CLUSTER,A,2),/older|senior|rank|original/i);
    assert.doesNotThrow(()=>removeMembershipMember(b,B,A,CLUSTER,C,2));
    const newer=getMembershipSnapshot(b,CLUSTER);
    applyMembershipManagerTransfer(b,B,certificate);
    assert.deepEqual(getMembershipSnapshot(b,CLUSTER),newer);
  } finally {a.close();b.close();c.close();}
});

test("stale cached certificate cannot rewind a later handoff",()=>{
  const a=open(),b=open(),c=open(); try {
    setup(a,b,c);
    const firstOffer=prepareMembershipManagerTransfer(a,A,CLUSTER,B,1,TRANSFER);
    const firstAcceptance=acceptMembershipManagerTransfer(b,B,firstOffer);
    const firstCertificate=commitMembershipManagerTransfer(a,A,firstAcceptance);
    applyMembershipManagerTransfer(b,B,firstCertificate); applyMembershipManagerTransfer(c,C,firstCertificate);
    const secondOffer=prepareMembershipManagerTransfer(b,B,CLUSTER,A,2,TRANSFER2);
    const secondAcceptance=acceptMembershipManagerTransfer(a,A,secondOffer);
    const secondCertificate=commitMembershipManagerTransfer(b,B,secondAcceptance);
    applyMembershipManagerTransfer(a,A,secondCertificate); applyMembershipManagerTransfer(c,C,secondCertificate);
    const before=getMembershipSnapshot(c,CLUSTER);
    const ranks=listSharingClusterMembers(c,CLUSTER).map(member=>member.joinSequence);
    assert.throws(()=>applyMembershipManagerTransfer(c,C,firstCertificate),/stale/i);
    assert.deepEqual(getMembershipSnapshot(c,CLUSTER),before);
    assert.deepEqual([getSharingCluster(c,CLUSTER).managerNodeId,getSharingCluster(c,CLUSTER).managerEpoch],[A,3]);
    assert.deepEqual(listSharingClusterMembers(c,CLUSTER).map(member=>member.joinSequence),ranks);
  } finally {a.close();b.close();c.close();}
});

test("lagging observer learns successor only from verified old-manager base",()=>{
  const a=open(),b=open(),c=open(); try {
    createMembershipCluster(a,local(A,4001),{id:CLUSTER,name:"Team"});
    const joinedC=admit(a,c,C,"20000000-0000-4000-8000-000000000003",4003);
    applyMembershipManagerSnapshot(c,C,joinedC);
    const joinedB=admit(a,b,B,"20000000-0000-4000-8000-000000000002",4002);
    applyMembershipManagerSnapshot(b,B,joinedB);
    assert.equal(pinnedClusterPublicKey(c,B),undefined);
    const offer=prepareMembershipManagerTransfer(a,A,CLUSTER,B,1,TRANSFER);
    const acceptance=acceptMembershipManagerTransfer(b,B,offer);
    const certificate=commitMembershipManagerTransfer(a,A,acceptance);
    const before=getMembershipSnapshot(c,CLUSTER);
    const forged=structuredClone(certificate);
    forged.acceptance.signature=`${forged.acceptance.signature[0]==="A"?"B":"A"}${forged.acceptance.signature.slice(1)}`;
    assert.throws(()=>applyMembershipManagerTransfer(c,C,forged),/acceptance signature/i);
    assert.deepEqual(getMembershipSnapshot(c,CLUSTER),before);
    assert.equal(pinnedClusterPublicKey(c,B),undefined);
    applyMembershipManagerTransfer(c,C,certificate);
    assert.equal(getSharingCluster(c,CLUSTER).managerNodeId,B);
    assert.equal(listSharingClusterMembers(c,CLUSTER).find(member=>member.nodeId===C)?.joinSequence,2);
    assert.equal(pinnedClusterPublicKey(c,B),joinedB.body.members.find(member=>member.nodeId===B)?.publicKey);
    assert.equal(listManagerTransferDeliveries(c).length,0);
  } finally {a.close();b.close();c.close();}
});

test("successor requires its durable local acceptance and signatures are fenced",()=>{
  const a=open(),b=open(),c=open(); try {
    setup(a,b,c); const offer=prepareMembershipManagerTransfer(a,A,CLUSTER,B,1,TRANSFER);
    const acceptance=acceptMembershipManagerTransfer(b,B,offer);
    const alteredOffer=structuredClone(offer); alteredOffer.body.transferId=TRANSFER2;
    assert.throws(()=>acceptMembershipManagerTransfer(b,B,alteredOffer),/signature/i);
    const alteredAcceptance=structuredClone(acceptance); alteredAcceptance.snapshot.body.managerEpoch=3;
    assert.throws(()=>commitMembershipManagerTransfer(a,A,alteredAcceptance),/signature|derived/i);
    const badAcceptanceSignature=structuredClone(acceptance);
    badAcceptanceSignature.signature=`${acceptance.signature[0]==="A"?"B":"A"}${acceptance.signature.slice(1)}`;
    assert.throws(()=>commitMembershipManagerTransfer(a,A,badAcceptanceSignature),/acceptance signature/i);
    assert.throws(()=>applyMembershipSnapshot(c,C,acceptance.snapshot),/activation certificate/i);
    const certificate=commitMembershipManagerTransfer(a,A,acceptance);
    assert.throws(()=>applyMembershipManagerTransfer(c,B,certificate),/acceptance|local|identity/i);
    const forged=structuredClone(certificate); forged.acceptance.snapshot.body.members[0].name="tampered";
    assert.throws(()=>applyMembershipManagerTransfer(c,C,forged),/signature|snapshot|derived|invalid/i);
    applyMembershipManagerTransfer(c,C,certificate);
    assert.throws(()=>applyMembershipManagerTransfer(c,C,forged),/conflict|signature|invalid/i);
  } finally {a.close();b.close();c.close();}
});

test("prepared, accepted, certificate and precise outbox ack survive reopen",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"manager-wire-"));
  const files=["a.sqlite","b.sqlite","c.sqlite"].map(x=>path.join(root,x)); let a=open(files[0]),b=open(files[1]),c=open(files[2]);
  try {
    setup(a,b,c); const offer=prepareMembershipManagerTransfer(a,A,CLUSTER,B,1,TRANSFER);
    a.close(); a=open(files[0]); assert.deepEqual(prepareMembershipManagerTransfer(a,A,CLUSTER,B,1,TRANSFER),offer);
    const acceptance=acceptMembershipManagerTransfer(b,B,offer); b.close(); b=open(files[1]);
    assert.deepEqual(acceptMembershipManagerTransfer(b,B,offer),acceptance);
    const certificate=commitMembershipManagerTransfer(a,A,acceptance); a.close(); a=open(files[0]);
    assert.deepEqual(commitMembershipManagerTransfer(a,A,acceptance),certificate);
    applyMembershipManagerTransfer(b,B,certificate);
    assert.deepEqual(listManagerTransferDeliveries(b).map(x=>x.peerId),[A,C]);
    b.close(); b=open(files[1]);
    acknowledgeManagerTransferDelivery(b,CLUSTER,A,TRANSFER);
    applyMembershipManagerTransfer(b,B,certificate);
    assert.deepEqual(listManagerTransferDeliveries(b).map(x=>x.peerId),[C]);
    const deliveries=listManagerTransferDeliveries(a); acknowledgeManagerTransferDelivery(a,CLUSTER,B,TRANSFER);
    assert.deepEqual(listManagerTransferDeliveries(a).map(x=>x.peerId),deliveries.map(x=>x.peerId).filter(x=>x!==B));
    a.close(); a=open(files[0]); assert.equal(listManagerTransferDeliveries(a).some(x=>x.peerId===B),false);
  } finally {a.close();b.close();c.close();await rm(root,{recursive:true,force:true});}
});

test("outbox failure rolls back relinquishment and can retry",()=>{
  const a=open(),b=open(),c=open(); try {
    setup(a,b,c); const offer=prepareMembershipManagerTransfer(a,A,CLUSTER,B,1,TRANSFER);
    const acceptance=acceptMembershipManagerTransfer(b,B,offer);
    a.exec(`CREATE TRIGGER fail_manager_outbox BEFORE INSERT ON cluster_v2_manager_deliveries BEGIN SELECT RAISE(ABORT,'outbox failed'); END`);
    assert.throws(()=>commitMembershipManagerTransfer(a,A,acceptance),/outbox failed/);
    assert.deepEqual([getSharingCluster(a,CLUSTER).managerNodeId,getSharingCluster(a,CLUSTER).managerEpoch],[A,1]);
    a.exec("DROP TRIGGER fail_manager_outbox"); const certificate=commitMembershipManagerTransfer(a,A,acceptance);
    assert.deepEqual([getSharingCluster(a,CLUSTER).managerNodeId,getSharingCluster(a,CLUSTER).managerEpoch],[B,2]);
    b.exec(`CREATE TRIGGER fail_successor_outbox BEFORE INSERT ON cluster_v2_manager_deliveries BEGIN SELECT RAISE(ABORT,'successor outbox failed'); END`);
    assert.throws(()=>applyMembershipManagerTransfer(b,B,certificate),/successor outbox failed/);
    assert.deepEqual([getSharingCluster(b,CLUSTER).managerNodeId,getSharingCluster(b,CLUSTER).managerEpoch],[A,1]);
    assert.equal(listManagerTransferDeliveries(b).length,0);
    b.exec("DROP TRIGGER fail_successor_outbox"); applyMembershipManagerTransfer(b,B,certificate);
    assert.deepEqual([getSharingCluster(b,CLUSTER).managerNodeId,getSharingCluster(b,CLUSTER).managerEpoch],[B,2]);
  } finally {a.close();b.close();c.close();}
});
