/**
 * Other people's running agents in the person's clusters, limited to what they share.
 *
 * Nothing here asks another machine anything. A project shared with a cluster, and every conversation of it, is already on
 * this machine, and a machine only sends the running state of a conversation whose project is shared with the receiver
 * (see sessionShared in runtime-peers.ts). This module only decides which of those conversations are another person's,
 * which cluster each one is shared through, and what to say about them. It takes plain data so the boundary can be tested
 * without a cluster.
 */

/** One of the person's clusters (or a relay's group) and the machines in it. */
export interface ClusterInfo {
  id: string;
  name: string;
  relay: boolean;
  members: Array<{ nodeId: string; name: string }>;
}

/** A conversation of a project this machine has, as its listing shows it. */
export interface SharedConversation {
  projectId: string;
  projectName: string;
  /** The clusters the project is shared through between its owner and this machine. */
  projectClusterIds: string[];
  conversationId: string;
  sessionId: string;
  path: string;
  title: string;
  agentLabel: string;
  agentModel: string | null;
  /** The machine that runs it. */
  executionNodeId: string | null;
  turnRunning: boolean;
  backgroundRunning: boolean;
  updatedAt: string | null;
  /** The running summary, when this machine has one for it. */
  summary: string | null;
}

export interface ClusterViewInput {
  localNodeId: string;
  /** The person's own other machines: their agents are the person's own, not another person's. */
  twinNodeIds: ReadonlySet<string>;
  /** Machines the person blocked: nothing is shared with them any more. */
  blockedNodeIds: ReadonlySet<string>;
  /** Machines that are not answering right now. */
  awayNodeIds: ReadonlySet<string>;
  clusters: ClusterInfo[];
  conversations: SharedConversation[];
}

export interface ClusterAgent {
  projectId: string;
  projectName: string;
  conversationId: string;
  sessionId: string;
  path: string;
  title: string;
  agentLabel: string;
  agentModel: string | null;
  /** `running`: a turn is in progress. `background`: only work the agent left running continues. */
  state: "running" | "background";
  updatedAt: string | null;
  summary: string | null;
  nodeId: string;
  /** The clusters this agent is shared through with the person. */
  clusterIds: string[];
}

export interface ClusterMachine {
  nodeId: string;
  name: string;
  away: boolean;
  clusterIds: string[];
  agents: ClusterAgent[];
}

export interface ClusterChip { id: string; name: string; relay: boolean; machines: number; running: number }

export interface ClusterView {
  clusters: ClusterChip[];
  /** Every machine of other people in the person's clusters, those with nothing running too. */
  machines: ClusterMachine[];
  /** The projects the agents belong to, for the project filter. */
  projects: Array<{ id: string; name: string }>;
}

export const EMPTY_CLUSTER_VIEW: ClusterView = { clusters: [], machines: [], projects: [] };

/**
 * An agent is shown when it runs on another person's machine (not this one, not a twin, not a blocked one), that machine is
 * in one of the person's clusters, the agent's project is shared through that same cluster, and it is running. A
 * conversation that fails any of these is not listed, however it came to be on this machine.
 */
export function buildClusterView(input: ClusterViewInput): ClusterView {
  const excluded = new Set([input.localNodeId, ...input.twinNodeIds, ...input.blockedNodeIds]);
  const machines = new Map<string, ClusterMachine>();
  const clusterIdsOf = new Map<string, Set<string>>();
  for (const cluster of input.clusters) {
    for (const member of cluster.members) {
      if (excluded.has(member.nodeId)) continue;
      const known = clusterIdsOf.get(member.nodeId) ?? new Set<string>();
      known.add(cluster.id);
      clusterIdsOf.set(member.nodeId, known);
      if (!machines.has(member.nodeId)) machines.set(member.nodeId, { nodeId: member.nodeId, name: member.name, away: input.awayNodeIds.has(member.nodeId), clusterIds: [], agents: [] });
    }
  }
  for (const [nodeId, machine] of machines) machine.clusterIds = [...clusterIdsOf.get(nodeId)!].sort();

  for (const conversation of input.conversations) {
    const machine = conversation.executionNodeId ? machines.get(conversation.executionNodeId) : undefined;
    if (!machine) continue;
    const state = conversation.turnRunning ? "running" : conversation.backgroundRunning ? "background" : null;
    if (!state) continue;
    const through = machine.clusterIds.filter((id) => conversation.projectClusterIds.includes(id));
    if (!through.length) continue;
    machine.agents.push({
      projectId: conversation.projectId, projectName: conversation.projectName, conversationId: conversation.conversationId, sessionId: conversation.sessionId,
      path: conversation.path, title: conversation.title, agentLabel: conversation.agentLabel, agentModel: conversation.agentModel, state,
      updatedAt: conversation.updatedAt, summary: conversation.summary, nodeId: machine.nodeId, clusterIds: through,
    });
  }
  for (const machine of machines.values()) machine.agents.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.title.localeCompare(b.title));

  const lanes = [...machines.values()].sort((a, b) => b.agents.length - a.agents.length || a.name.localeCompare(b.name));
  const agents = lanes.flatMap((machine) => machine.agents);
  const projects = new Map(agents.map((agent) => [agent.projectId, agent.projectName]));
  return {
    clusters: input.clusters.map((cluster) => ({
      id: cluster.id, name: cluster.name, relay: cluster.relay,
      machines: lanes.filter((machine) => machine.clusterIds.includes(cluster.id)).length,
      running: agents.filter((agent) => agent.clusterIds.includes(cluster.id)).length,
    })),
    machines: lanes,
    projects: [...projects].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ── What Bob says about them ──────────────────────────────────────────────────────────────────────────

/** Words that, with no model to ask, say a message is about other people's work. */
const PEOPLE_WORDS = new Set(["team", "teammate", "teammates", "everyone", "everybody", "colleague", "colleagues", "coworker", "coworkers", "cluster", "clusters"]);
/** Parts of a machine's name that name a kind of machine, not a person: "Matan's Mac" names Matan. */
const MACHINE_WORDS = new Set(["mac", "macbook", "mini", "imac", "pc", "laptop", "desktop", "server", "homeserver", "node", "machine", "computer", "linux", "windows", "ubuntu", "home", "work", "relay", "the", "and", "for", "with"]);

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The words a person is called by in the person's clusters: the names of their machines and clusters, without the machine kind. */
export function personWords(view: ClusterView): Set<string> {
  const names = [...view.machines.map((machine) => machine.name), ...view.clusters.map((cluster) => cluster.name)];
  return new Set(names.flatMap(wordsOf).filter((word) => word.length >= 3 && !MACHINE_WORDS.has(word) && !PEOPLE_WORDS.has(word)));
}

/**
 * The rule Bob falls back on when the decision model is missing or not sure: the message says "team" or "everyone", or names
 * someone in the person's clusters. Kept small on purpose; the decision model reads everything else.
 */
export function namesPeople(message: string, view: ClusterView): boolean {
  const words = wordsOf(message);
  const named = personWords(view);
  return words.some((word) => PEOPLE_WORDS.has(word) || named.has(word));
}

const TITLE_LIMIT = 100;
const SUMMARY_LIMIT = 180;
const AGENT_LIMIT = 25;

function ago(iso: string | null, now: number): string {
  if (!iso) return "no activity time";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 1 ? "active just now" : minutes < 90 ? `active ${minutes} min ago` : `active ${Math.round(minutes / 60)} h ago`;
}

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/**
 * What Bob's agent is told about other people's agents. It has the running ones and nothing else about them, and is told
 * plainly that they are not its to answer.
 */
export function clusterAgentsText(view: ClusterView, now = Date.now()): string {
  const lines = [
    "Other people's agents in the user's clusters. These people shared the projects with the user. The user can read their conversations but cannot act on them, and neither can you: you cannot answer, instruct, stop or message these agents or their people. If asked to, say that only that person can.",
  ];
  const running = view.machines.filter((machine) => machine.agents.length);
  if (!running.length) lines.push("Nothing is running right now in what they share with the user.");
  let listed = 0;
  for (const machine of running) {
    const clusters = view.clusters.filter((cluster) => machine.clusterIds.includes(cluster.id)).map((cluster) => cluster.name).join(", ");
    lines.push(`${machine.name} (${clusters}${machine.away ? "; not answering right now" : ""}):`);
    for (const agent of machine.agents) {
      if (listed >= AGENT_LIMIT) { lines.push("  - …and more not listed here"); break; }
      listed += 1;
      const agentName = [agent.agentLabel, agent.agentModel].filter(Boolean).join(" ");
      const summary = agent.summary ? ` — ${oneLine(agent.summary, SUMMARY_LIMIT)}` : "";
      lines.push(`  - [${agent.projectName}] ${oneLine(agent.title, TITLE_LIMIT)} (${agentName}, ${agent.state === "running" ? "running" : "background work only"}, ${ago(agent.updatedAt, now)})${summary}`);
    }
  }
  const idle = view.machines.filter((machine) => !machine.agents.length).map((machine) => `${machine.name}${machine.away ? " (not answering)" : ""}`);
  if (idle.length) lines.push(`Nothing running that is shared with the user on: ${idle.join(", ")}.`);
  return lines.join("\n");
}
