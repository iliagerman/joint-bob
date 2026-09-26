import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { freePort } from "./dev-nodes.js";

export async function startNativeSyncthing(root:string) {
  await mkdir(root,{recursive:true});
  execFileSync("syncthing",["generate","--home",root],{env:{...process.env,HOME:root},stdio:"pipe"});
  const gui=await freePort(),listen=await freePort();
  const config=path.join(root,"config.xml");
  let xml=await readFile(config,"utf8");
  xml=xml.replace(/<listenAddress>[^<]*<\/listenAddress>/g,`<listenAddress>tcp://127.0.0.1:${listen}</listenAddress>`)
    .replace(/<globalAnnounceEnabled>true<\/globalAnnounceEnabled>/g,"<globalAnnounceEnabled>false</globalAnnounceEnabled>")
    .replace(/<localAnnounceEnabled>true<\/localAnnounceEnabled>/g,"<localAnnounceEnabled>false</localAnnounceEnabled>")
    .replace(/<relaysEnabled>true<\/relaysEnabled>/g,"<relaysEnabled>false</relaysEnabled>")
    .replace(/<natEnabled>true<\/natEnabled>/g,"<natEnabled>false</natEnabled>");
  await writeFile(config,xml);
  const url=`http://127.0.0.1:${gui}`,key="disposable-syncthing-test-key";
  const child=spawn("syncthing",["serve","--home",root,"--gui-address",url,"--gui-apikey",key,"--no-browser","--no-restart","--no-upgrade"],{env:{...process.env,HOME:root},stdio:"ignore"});
  const request=async <T>(endpoint:string,body?:unknown):Promise<T>=>{
    const response=await fetch(`${url}/rest/${endpoint}`,{method:body===undefined?"GET":"PUT",headers:{"X-API-Key":key,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok)throw new Error(`Syncthing ${endpoint}: ${response.status} ${await response.text()}`);
    const text=await response.text();return (text?JSON.parse(text):undefined) as T;
  };
  try {
    const deadline=Date.now()+15000;
    while(true){try{await request("system/ping");break;}catch(error){if(Date.now()>deadline)throw error;await new Promise(r=>setTimeout(r,100));}}
    const status=await request<{myID:string}>("system/status");
    return {child,url,key,deviceId:status.myID,address:`tcp://127.0.0.1:${listen}`,request};
  }catch(error){await stopNativeSyncthing(child);throw error;}
}
export async function stopNativeSyncthing(child:ChildProcess):Promise<void>{
  if(child.exitCode!==null)return;
  await new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.kill("SIGTERM");});
}
