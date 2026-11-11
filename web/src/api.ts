export type Role = "player" | "npc";
export type Lethality = "forgiving" | "standard" | "deadly";

export interface CatalogEntry { name: string; description: string }

export interface Route { to: string; minutes: number }
export interface Location {
  routes?: Route[];
  links?: string[];
  name: string;
  description: string;
}

export interface Character {
  id: string;
  name: string;
  role: Role;
  hp: number;
  maxHp: number;
  location: string;
  inventory: Record<string, number>;
  skills: Record<string, number>;
  /** NPC Memory: -10 (hostile) to +10 (devoted). */
  relationship: number;
  portrait?: string | null;
  condition?: "down" | "dying" | "dead" | null;
}

export interface CampaignState {
  travel: Route[];
  clock: number;
  journal: { kind: "quest" | "person" | "place" | "note"; text: string }[];
  combat: { order: string[]; turn: number } | null;
  usage: { input: number; cached: number; output: number };
  suggestions: string[];
  world: { id: string | null; name: string };
  playerCharacterId: string;
  characters: Record<string, Character>;
}

/** A Character Profile as saved in a World. */
export interface CharacterProfile {
  portrait?: string;
  routine?: string[];
  id: string;
  name: string;
  role: Role;
  description: string;
  personality: string;
  goals: string;
  secrets: string;
  maxHp: number;
  skills: Record<string, number>;
  location: string;
  inventory: Record<string, number>;
}

export interface WorldDoc {
  name: string;
  premise: string;
  tone: string;
  contentLimits: string;
  lethality: Lethality;
  startingLocation: string;
  locations: Location[];
  items?: CatalogEntry[];
  quests?: CatalogEntry[];
  characters: CharacterProfile[];
}

export interface World extends WorldDoc {
  id: string;
}

export interface WorldSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export type TranscriptEntry =
  | { kind: "player"; text: string; targets?: { id: string; name: string }[] }
  | { kind: "gm"; text: string }
  | { kind: "npc"; characterId: string; name: string; text: string }
  | {
      kind: "roll";
      characterId: string;
      reason: string;
      roll: number;
      total: number;
      difficulty: number;
      success: boolean;
      critical: "success" | "failure" | null;
    };

export interface CampaignView {
  id: string;
  state: CampaignState;
  transcript: TranscriptEntry[];
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const error = (await res.json().catch(() => null))?.error;
    if (res.status === 401 && error === "Sign in to continue.") window.dispatchEvent(new Event("ai-world:session-expired"));
    throw new ApiError(res.status, error ?? (res.statusText || `HTTP ${res.status}`));
  }
  return res.json() as Promise<T>;
}

const send = (method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export type Session = { required: boolean; email: string | null };
export const getSession = () => fetch("/api/auth/session").then(json<Session>);
export const signIn = (email: string, password: string) => send("POST", "/api/auth/login", { email, password }).then(json<Session>);
export const signOut = () => send("POST", "/api/auth/logout").then(json<Session>);

export type CampaignSetup = Pick<WorldDoc, "premise" | "tone" | "contentLimits" | "lethality" | "startingLocation" | "characters"> & {
  worldId: string;
};

export const createCampaign = (setup: CampaignSetup) =>
  send("POST", "/api/campaigns", setup).then(json<CampaignView>);

export const travel = (campaign: CampaignView, from: string, to: string) =>
  send("POST", `/api/campaigns/${encodeURIComponent(campaign.id)}/travel`, {
    from, to, clock: campaign.state.clock,
  }).then(json<CampaignView>);

export const listWorlds = () => fetch("/api/worlds").then(json<WorldSummary[]>);
export const getWorld = (id: string) => fetch(`/api/worlds/${id}`).then(json<World>);
export const createWorld = (doc: WorldDoc) => send("POST", "/api/worlds", doc).then(json<World>);
export const updateWorld = (id: string, doc: WorldDoc) => send("PUT", `/api/worlds/${id}`, doc).then(json<World>);
export async function deleteWorld(id: string) {
  const res = await send("DELETE", `/api/worlds/${id}`);
  if (!res.ok) await json(res);
}

export const draftWorld = (keywords: string) =>
  send("POST", "/api/drafts/world", { keywords }).then(json<WorldDoc>);
export const draftCharacter = (keywords: string, role: Role, world: WorldDoc) =>
  send("POST", "/api/drafts/character", { keywords, role, world }).then(json<CharacterProfile>);

export interface Timeline {
  snapshots: { id: string; name: string; seq: number }[];
  branches: { id: string; name: string }[];
}
export type Effort = "none" | "low" | "medium" | "high";
export interface AiSettings { model: string; fast: Effort; strong: Effort }
const campaignPath = (id: string) => `/api/campaigns/${encodeURIComponent(id)}`;
export const getTimeline = (id: string) => fetch(campaignPath(id) + "/timeline").then(json<Timeline>);
export const addSnapshot = (id: string, name: string) => send("POST", campaignPath(id) + "/snapshots", { name }).then(json);
export const rewind = (id: string, snapshotId: string) => send("POST", campaignPath(id) + "/rewind", { snapshotId }).then(json<CampaignView>);
export const getInspector = (id: string) => fetch(campaignPath(id) + "/inspector").then(json<unknown[]>);
type WaitingForCodex = { state: "preparing" | "other-session" | "canceling" | "finishing" };
export interface CodexAuthStatus {
  credentials: "present" | "missing" | "unknown";
  login: "pending" | "succeeded" | "failed" | null;
  hosted?: true;
  device?: WaitingForCodex | { state: "ready"; url: string; code: string };
  browser?: WaitingForCodex | { state: "ready"; url: string };
}
const codexAuthPath = "/api/ai/codex-auth";
export const getCodexAuth = (signal: AbortSignal) => fetch(codexAuthPath, { signal }).then(json<CodexAuthStatus>);
export const startCodexLogin = (method: "browser" | "device") => send("POST", codexAuthPath, { method }).then(json<{ login: "pending" }>);
export const cancelCodexLogin = () => send("DELETE", codexAuthPath).then(json<{ login: "pending" }>);
export const finishCodexLogin = (address: string) => send("POST", codexAuthPath + "/callback", { address }).then(json<{ login: "pending" }>);

export const getAiSettings = () => fetch("/api/ai/settings").then(json<AiSettings>);
export const saveAiSettings = (settings: AiSettings) => send("PUT", "/api/ai/settings", settings).then(json<AiSettings>);
export const editLive = (id: string, character: Character, silent: boolean, effect: "blessing" | "curse", bringToPlayer = false) =>
  send("PATCH", campaignPath(id) + "/characters/" + encodeURIComponent(character.id), {
    name: character.name, hp: character.hp, maxHp: character.maxHp, skills: character.skills, bringToPlayer,
    portrait: character.portrait ?? null, silent, effect,
  }).then(json<CampaignView>);
export const applyCharacterProfile = (id: string, character: CharacterProfile) =>
  send("PATCH", campaignPath(id) + "/characters/" + encodeURIComponent(character.id), {
    name: character.name, maxHp: character.maxHp, skills: character.skills,
    portrait: character.portrait ?? null, silent: true, effect: "blessing",
    profile: { description: character.description, personality: character.personality, goals: character.goals, secrets: character.secrets },
  }).then(json<CampaignView>);
export const portraitUrl = (id: string) => "/api/portraits/" + encodeURIComponent(id);
export const uploadPortrait = (file: File) => fetch("/api/portraits", { method: "POST", body: file }).then(json<{ id: string }>);
export const generatePortrait = (keywords: string) => send("POST", "/api/portraits/generate", { keywords }).then(json<{ id: string }>);

export const getCampaign = (id: string) => fetch(`/api/campaigns/${id}`).then(json<CampaignView>);

/** Send a player message; streams narration deltas, resolves with the updated campaign. */
export async function takeTurn(
  id: string,
  text: string,
  onText: (delta: string) => void,
  targetIds: string[] = [],
): Promise<Omit<CampaignView, "id">> {
  const res = await fetch(`/api/campaigns/${id}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, targetIds }),
  });
  if (!res.ok || !res.body) await json(res);

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (event === "text") onText(JSON.parse(data));
      if (event === "done") return JSON.parse(data);
      if (event === "error") throw new Error(JSON.parse(data).message);
    }
  }
  throw new Error("The connection closed before the turn finished.");
}
