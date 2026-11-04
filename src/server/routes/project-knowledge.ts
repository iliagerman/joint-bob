import { z } from "zod";
import {
  KnowledgeError, addRule, deleteProposal, listProposals, normalizedRuleText, readNotes, readProposal, readSubjects, removeRule, writeNote,
} from "../../project-knowledge.js";
import { getProject, projectVisible } from "../../store.js";
import type { ProjectRecord } from "../../types.js";
import { sendError } from "../http-auth.js";
import { assertProjectEditable } from "../projects.js";
import { app } from "../state.js";

const acceptSchema = z.object({
  subject: z.string().trim().min(1).max(60).optional(),
  text: z.string().trim().min(1).max(600).optional(),
}).strict();

async function visibleProject(projectId: string): Promise<ProjectRecord> {
  const project = await getProject(projectId);
  if (!project || !await projectVisible(project.id)) throw new KnowledgeError(404, "Project not found");
  return project;
}

function knowledgeView(root: string) {
  return { subjects: readSubjects(root), proposals: listProposals(root) };
}

function sendKnowledgeError(response: Parameters<typeof sendError>[0], error: unknown): boolean {
  if (error instanceof KnowledgeError) { sendError(response, error.status, error.message); return true; }
  if (error instanceof z.ZodError) { sendError(response, 400, error.message); return true; }
  return false;
}

/** The project's rules by subject and the rule proposals waiting for a person. */
app.get("/api/projects/:projectId/knowledge", async (request, response, next) => {
  try {
    response.json(knowledgeView((await visibleProject(request.params.projectId)).path));
  } catch (error) { if (!sendKnowledgeError(response, error)) next(error); }
});

/** Anyone who can edit the project may accept: an add writes the rule, a remove or merge deletes the rule it names. */
app.post("/api/projects/:projectId/knowledge/proposals/:id/accept", async (request, response, next) => {
  try {
    const edits = acceptSchema.parse(request.body ?? {});
    const project = await visibleProject(request.params.projectId);
    await assertProjectEditable(project);
    const proposal = readProposal(project.path, request.params.id);
    if (!proposal) throw new KnowledgeError(404, "Proposal not found");
    if (proposal.action === "add") {
      addRule(project.path, { subject: edits.subject ?? proposal.subject, text: edits.text ?? proposal.text, evidence: proposal.evidence });
    } else if (!proposal.ruleId || !removeRule(project.path, proposal.subject, proposal.ruleId)) {
      throw new KnowledgeError(409, "The rule this proposal names no longer exists");
    }
    deleteProposal(project.path, proposal.id);
    response.json(knowledgeView(project.path));
  } catch (error) { if (!sendKnowledgeError(response, error)) next(error); }
});

/** Drops the proposal and remembers it in the source conversation's note, so the same rule is not proposed again. */
app.post("/api/projects/:projectId/knowledge/proposals/:id/dismiss", async (request, response, next) => {
  try {
    const project = await visibleProject(request.params.projectId);
    await assertProjectEditable(project);
    const proposal = readProposal(project.path, request.params.id);
    if (!proposal) throw new KnowledgeError(404, "Proposal not found");
    const note = readNotes(project.path).find((candidate) => candidate.conversationId === proposal.source);
    if (note && proposal.action === "add") writeNote(project.path, { ...note, dismissed: [...new Set([...note.dismissed, normalizedRuleText(proposal.text)])] });
    deleteProposal(project.path, proposal.id);
    response.json(knowledgeView(project.path));
  } catch (error) { if (!sendKnowledgeError(response, error)) next(error); }
});
