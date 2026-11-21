import fs from "node:fs";
import path from "node:path";

const MAX_FILES = 64;
const MAX_FILE_BYTES = 128_000;
const MAX_CONTEXT_BYTES = 240_000;

function safeName(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function readDirectory(directory, kind) {
  fs.mkdirSync(directory, { recursive: true });
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|txt|json)$/i.test(entry.name))
    .slice(0, MAX_FILES)
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_BYTES) return null;
      const content = fs.readFileSync(filePath, "utf8");
      const id = safeName(entry.name.replace(/\.(md|txt|json)$/i, ""));
      return { id, name: entry.name, kind, path: filePath, bytes: stat.size, content, updatedAt: stat.mtime.toISOString() };
    })
    .filter(Boolean);
}

function publicResource(resource) {
  return { id: resource.id, name: resource.name, kind: resource.kind, bytes: resource.bytes, updatedAt: resource.updatedAt };
}

export class AgentResourceStore {
  constructor({ skillsDir, knowledgeDir } = {}) {
    this.skillsDir = skillsDir || process.env.AGENT_SKILLS_DIR || path.resolve(".data", "agent-skills");
    this.knowledgeDir = knowledgeDir || process.env.AGENT_KNOWLEDGE_DIR || path.resolve(".data", "agent-knowledge");
  }

  list() {
    return [...readDirectory(this.skillsDir, "skill"), ...readDirectory(this.knowledgeDir, "knowledge")].map(publicResource);
  }

  load() {
    return { skills: readDirectory(this.skillsDir, "skill"), knowledge: readDirectory(this.knowledgeDir, "knowledge") };
  }

  promptContext() {
    const loaded = this.load();
    const sections = [];
    for (const item of [...loaded.skills, ...loaded.knowledge]) {
      sections.push(`### ${item.kind}: ${item.name}\n${item.content}`);
    }
    let context = sections.join("\n\n");
    if (Buffer.byteLength(context, "utf8") > MAX_CONTEXT_BYTES) {
      context = Buffer.from(context, "utf8").subarray(0, MAX_CONTEXT_BYTES).toString("utf8");
    }
    return { ...loaded, text: context };
  }
}

export function resourceDirectories() {
  return {
    skillsDir: process.env.AGENT_SKILLS_DIR || path.resolve(".data", "agent-skills"),
    knowledgeDir: process.env.AGENT_KNOWLEDGE_DIR || path.resolve(".data", "agent-knowledge"),
  };
}
