export const KEYWORDS: Record<string, string[]> = {
  AI: ["=AI", "artificial intelligence", "=KI", "künstliche* Intelligenz"],
  LLM: ["LLM", "LLMs", "large language model", "large language models", "GenAI", "generative AI", "generative KI"],
  RAG: ["=RAG", "retrieval-augmented", "retrieval augmented"],
  "AI agents": ["agent", "agents", "agentic", "AI agent", "AI agents", "KI-Agent*"],
  "multi-agent": ["multi-agent", "multi agent", "Multi-Agenten"],
  "tool use": ["tool use", "tool calling", "function calling"],
  MCP: ["=MCP", "Model Context Protocol"],
  "prompt engineering": ["prompt engineering", "prompting", "prompt design"],
  evals: ["eval", "evals", "LLM-as-judge", "~evaluation", "~evaluations"],
  "fine-tuning": ["fine-tuning", "fine tuning", "finetuning", "LoRA", "SFT", "RLHF", "DPO"],
  embeddings: ["embedding", "embeddings"],
  "vector database": ["vector database", "vector databases", "vector db", "vector store", "pgvector", "Pinecone", "Weaviate", "Qdrant", "Chroma", "Milvus", "Vektordatenbank*"],
  LangChain: ["LangChain"],
  LangGraph: ["LangGraph"],
  LlamaIndex: ["LlamaIndex"],
  OpenAI: ["OpenAI", "GPT", "GPT-4", "GPT-4o", "ChatGPT"],
  Claude: ["Claude", "Anthropic"],
  "Claude Code": ["Claude Code"],
  Codex: ["Codex"],
  "Hugging Face": ["Hugging Face", "HuggingFace"],
  PyTorch: ["PyTorch"],
  TensorFlow: ["TensorFlow"],
  "scikit-learn": ["scikit-learn", "sklearn"],
  "machine learning": ["machine learning", "=ML", "maschinelle* Lernen*"],
  "deep learning": ["deep learning"],
  NLP: ["NLP", "natural language processing"],
  "computer vision": ["computer vision", "OpenCV"],
  "speech AI": ["speech-to-text", "ASR", "speech recognition", "voice AI", "TTS", "text-to-speech"],
  MLOps: ["MLOps", "LLMOps"],
  inference: ["inference", "model serving", "vLLM"],
  "local models": ["Ollama", "MLX", "llama.cpp", "open-source models", "open-weight"],
  observability: ["observability", "Langfuse", "LangSmith", "OpenTelemetry", "Prometheus", "Grafana", "~tracing", "~monitoring"],
  guardrails: ["guardrails", "AI safety", "prompt injection"],

  Python: ["Python"],
  TypeScript: ["TypeScript"],
  JavaScript: ["JavaScript", "Node.js", "NodeJS"],
  Rust: ["Rust"],
  "C++": ["=C++"],
  "C#": ["=C#"],
  ".NET": ["=.NET", "dotnet"],
  Go: ["=Go", "Golang"],
  R: ["=R"],
  Java: ["Java"],
  Kotlin: ["Kotlin"],
  Swift: ["=Swift", "SwiftUI"],
  SQL: ["SQL"],

  FastAPI: ["FastAPI"],
  Django: ["Django"],
  "Spring Boot": ["Spring Boot", "Spring Framework"],
  React: ["=React", "ReactJS", "React.js"],
  Angular: ["=Angular", "AngularJS"],
  Vue: ["=Vue", "Vue.js", "VueJS"],
  "Next.js": ["Next.js", "NextJS"],

  "REST APIs": ["REST", "RESTful", "REST API", "REST APIs"],
  GraphQL: ["GraphQL"],
  gRPC: ["gRPC"],
  "event sourcing": ["event sourcing", "event sourced"],
  CQRS: ["CQRS", "command query responsibility segregation"],
  DDD: ["=DDD", "domain-driven design", "domänengetriebene* Design*", "domain-driven"],
  "hexagonal architecture": ["hexagonal architecture", "hexagonale Architektur"],
  "clean architecture": ["clean architecture"],
  microservices: ["microservice", "microservices", "Microservice-Architektur"],
  Kafka: ["Kafka"],
  Redis: ["Redis"],
  PostgreSQL: ["PostgreSQL", "Postgres"],
  MySQL: ["MySQL"],
  MongoDB: ["MongoDB", "=Mongo"],
  Oracle: ["=Oracle"],
  Elasticsearch: ["Elasticsearch", "OpenSearch"],
  Spark: ["Apache Spark", "PySpark", "=Spark"],
  Airflow: ["Airflow"],
  dbt: ["=dbt"],

  Docker: ["Docker", "~container", "~containers", "~containerized"],
  Kubernetes: ["Kubernetes", "k8s"],
  Helm: ["=Helm"],
  ArgoCD: ["ArgoCD", "Argo CD"],
  AWS: ["AWS", "Amazon Web Services"],
  GCP: ["GCP", "Google Cloud"],
  Azure: ["Azure"],
  Terraform: ["Terraform"],
  "CI/CD": ["CI/CD", "=CI", "continuous integration", "continuous delivery", "continuous deployment"],
  "GitHub Actions": ["GitHub Actions"],
  "GitLab CI": ["GitLab CI", "GitLab CI/CD"],
  Jenkins: ["Jenkins"],
  Git: ["=Git"],
  Linux: ["Linux"],
  "distributed systems": ["distributed systems", "distributed system", "verteilte* System*"],
  "system design": ["system design", "Systemdesign", "~architecture", "~Architektur"],
  testing: ["testing", "unit tests", "integration tests", "test automation", "Testautomatisierung", "automatisierte* Tests"],
  "code review": ["code review", "code reviews"],

  Scrum: ["Scrum"],
  Kanban: ["Kanban"],

  "5G": ["5G", "5G Core", "5GC"],
  IMS: ["=IMS", "IP Multimedia Subsystem"],
  SIP: ["=SIP"],
  Diameter: ["=Diameter"],
  Kamailio: ["Kamailio"],
  "3GPP": ["3GPP"],
  VoIP: ["VoIP", "VoLTE", "VoNR"],
  NFV: ["NFV", "network function virtualization"],
};

export interface Alias {
  re: RegExp;
  key: string;
  resumeOnly: boolean;
}
export interface Term {
  term: string;
  aliases: Alias[];
}
export type Dict = Term[];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const L = "\\p{L}\\p{N}_";

export const spellingKey = (s: string) => s.toLowerCase().replace(/[\s\-.]+/g, "").replace(/s$/, "");

function compile(raw: string): Alias {
  const resumeOnly = raw.startsWith("~");
  const exact = raw.startsWith("=");
  const alias = raw.replace(/^[=~]/, "");

  const body = alias.split("*").map((p) => p.split(/[ -]/).map(escape).join("[\\s-]")).join("\\p{L}*");

  const after = exact ? `(?![${L}+#&'’]|-(?:to|live|getter)\\b)` : `(?![${L}+#])`;
  const before = exact ? `(?<![${L}+#&])` : `(?<![${L}+#])`;
  return { re: new RegExp(`${before}${body}${after}`, exact ? "gu" : "giu"), key: spellingKey(alias.replace(/\*/g, "")), resumeOnly };
}

export function makeDict(extra: Record<string, string[]> = {}): Dict {
  const merged: Record<string, string[]> = { ...KEYWORDS };
  for (const [term, aliases] of Object.entries(extra)) merged[term] = [...(merged[term] ?? []), ...aliases.map(String)];
  return Object.entries(merged).map(([term, aliases]) => ({ term, aliases: aliases.map(compile) }));
}
export const DICT = makeDict();

export interface Hit {
  term: string;
  forms: { text: string; key: string }[];
  count: number;
}

type Match = { term: string; s: number; e: number; key: string; text: string };
const inside = (m: Match, o: Match) => o !== m && o.s <= m.s && o.e >= m.e && o.e - o.s > m.e - m.s;

function matches(text: string, dict: Dict, jdSide: boolean): Match[] {
  const all: Match[] = [];
  for (const { term, aliases } of dict)
    for (const a of aliases)
      if (!(jdSide && a.resumeOnly)) for (const m of text.matchAll(a.re)) all.push({ term, s: m.index, e: m.index + m[0].length, key: a.key, text: m[0] });
  return all.filter((m) => !all.some((o) => o.term !== m.term && inside(m, o)));
}

export function termSpans(text: string, dict: Dict = DICT): { term: string; s: number; e: number; text: string }[] {
  const ms = matches(text, dict, true);
  return ms
    .filter((m) => !ms.some((o) => inside(m, o) || (o !== m && o.s === m.s && o.e === m.e && o.term < m.term)))
    .sort((a, b) => a.s - b.s)
    .map(({ term, s, e, text: t }) => ({ term, s, e, text: t }));
}

export function findHits(text: string, dict: Dict = DICT, jdSide = false): Map<string, Hit> {
  const kept = matches(text, dict, jdSide);
  const out = new Map<string, Hit>();
  for (const { term } of dict) {
    const ms = kept.filter((m) => m.term === term);
    if (!ms.length) continue;
    const longest = ms.filter((m) => !ms.some((o) => inside(m, o))).sort((x, y) => x.s - y.s);
    const forms = new Map<string, string>();
    for (const m of jdSide ? longest : ms) if (!forms.has(m.key)) forms.set(m.key, m.text);
    let count = 0;
    let end = -1;
    for (const m of longest) {
      if (m.s >= end) {
        count++;
        end = m.e;
      }
    }
    out.set(term, { term, forms: [...forms].map(([key, t]) => ({ key, text: t })), count });
  }
  return out;
}

export function findTerms(text: string, dict: Dict = DICT): Set<string> {
  return new Set(findHits(text, dict).keys());
}
