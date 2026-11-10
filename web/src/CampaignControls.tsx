import { AiLoading } from "./AiLoading";
import { useEffect, useState } from "react";
import {
  addSnapshot, editLive, generatePortrait, getAiSettings, getCampaign, getCodexAuth, getInspector, getTimeline,
  portraitUrl, rewind, saveAiSettings, startCodexLogin, uploadPortrait,
  type AiSettings, type CampaignView, type Character, type CodexAuthStatus, type Effort, type Timeline,
} from "./api";

export function PortraitPicker({ portrait, onChange, onBusy }: {
  portrait?: string | null;
  onChange: (id: string | null) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [keywords, setKeywords] = useState("");
  const [busy, setBusy] = useState<"upload" | "generate" | null>(null);
  const [error, setError] = useState("");
  async function choose(action: "upload" | "generate", task: () => Promise<{ id: string }>) {
    setBusy(action);
    onBusy?.(true);
    setError("");
    try { onChange((await task()).id); }
    catch (err) { setError((err as Error).message); }
    finally {
      setBusy(null);
      onBusy?.(false);
    }
  }
  return <fieldset className="gc-form" aria-busy={!!busy}>
    <legend>Portrait</legend>
    {portrait && <img className="portrait portrait-player" src={portraitUrl(portrait)} alt="Character portrait" />}
    <label>Upload PNG, JPEG or WebP <input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy} onChange={(e) => {
      const file = e.target.files?.[0];
      if (file) void choose("upload", () => uploadPortrait(file));
    }} /></label>
    <label>Image keywords <input value={keywords} disabled={!!busy} maxLength={500} onChange={(e) => setKeywords(e.target.value)} /></label>
    <div className="quick-replies">
      <button type="button" disabled={!!busy || !keywords.trim()} onClick={() => choose("generate", () => generatePortrait(keywords))}>
        Generate portrait
      </button>
      {portrait && <button type="button" className="ghost" disabled={!!busy} onClick={() => onChange(null)}>Remove portrait</button>}
    </div>
    {busy && <AiLoading>{busy === "generate" ? "Generating portrait…" : "Uploading portrait…"}</AiLoading>}
    {error && <p className="error" role="alert">{error}</p>}
  </fieldset>;
}

export function CampaignControls({ campaign, onCampaign }: { campaign: CampaignView; onCampaign: (next: CampaignView) => void }) {
  const [timeline, setTimeline] = useState<Timeline>();
  const [settings, setSettings] = useState<AiSettings>();
  const [trace, setTrace] = useState<unknown[]>();
  const [aiOpen, setAiOpen] = useState(false);
  const [name, setName] = useState("");
  const [character, setCharacter] = useState<Character>(campaign.state.characters[campaign.state.playerCharacterId]!);
  const [silent, setSilent] = useState(false);
  const [bringToPlayer, setBringToPlayer] = useState(false);
  const [effect, setEffect] = useState<"blessing" | "curse">("blessing");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([getTimeline(campaign.id), getAiSettings()]).then(([nextTimeline, nextSettings]) => {
      if (active) { setTimeline(nextTimeline); setSettings(nextSettings); }
    }).catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [campaign.id]);

  useEffect(() => {
    setCharacter((previous) => campaign.state.characters[previous.id] ?? campaign.state.characters[campaign.state.playerCharacterId]!);
    setBringToPlayer(false);
  }, [campaign]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setStatus("");
    setError("");
    try { await task(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="gc-form campaign-controls">
    <details>
      <summary>Snapshots and Branches</summary>
      <div className="quick-replies">
        <input aria-label="Snapshot name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={busy || !name.trim()} onClick={() => run(async () => {
          await addSnapshot(campaign.id, name);
          setTimeline(await getTimeline(campaign.id));
          setName("");
          setStatus("Snapshot saved.");
        })}>Save snapshot</button>
      </div>
      {timeline?.snapshots.map((snapshot) => <p key={snapshot.id}>
        {snapshot.name} · event {snapshot.seq}{" "}
        <button className="ghost" disabled={busy} onClick={() => run(async () => onCampaign(await rewind(campaign.id, snapshot.id)))}>Rewind</button>
      </p>)}
      {timeline?.branches.map((branch) => <p key={branch.id}>
        <button className="ghost" disabled={busy} onClick={() => run(async () => onCampaign(await getCampaign(branch.id)))}>Continue {branch.name}</button>
      </p>)}
    </details>
    <details>
      <summary>Live Campaign · God’s Blessing</summary>
      <div className="gc-form">
        <label>Character <select disabled={busy} value={character.id} onChange={(e) => {
          setCharacter(campaign.state.characters[e.target.value]!);
          setBringToPlayer(false);
        }}>
          {Object.values(campaign.state.characters).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.location}</option>)}
        </select></label>
        <label>Name <input value={character.name} maxLength={80} onChange={(e) => setCharacter({ ...character, name: e.target.value })} /></label>
        {character.role === "npc" && !campaign.state.combat && character.location !== campaign.state.characters[campaign.state.playerCharacterId]?.location &&
          <label><input type="checkbox" checked={bringToPlayer} onChange={(e) => {
            setBringToPlayer(e.target.checked);
            if (e.target.checked) setSilent(true);
          }} /> Bring to the Player Character’s location</label>}
        <div className="field-row">
          <label>HP <input type="number" min={0} max={character.maxHp} value={character.hp} onChange={(e) => setCharacter({ ...character, hp: Number(e.target.value) })} /></label>
          <label>Maximum HP <input type="number" min={1} max={999} value={character.maxHp} onChange={(e) => setCharacter({ ...character, maxHp: Number(e.target.value) })} /></label>
        </div>
        <Skills key={character.id} character={character} onChange={setCharacter} />
        <PortraitPicker key={character.id + "-portrait"} portrait={character.portrait} onChange={(id) => setCharacter((c) => ({ ...c, portrait: id }))} />
        <label><input type="checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} /> Silent edit</label>
        <label>Effect <select value={effect} disabled={silent} onChange={(e) => setEffect(e.target.value as typeof effect)}>
          <option value="blessing">God’s Blessing</option><option value="curse">God’s Curse</option>
        </select></label>
        <button disabled={busy || !character.name.trim()} onClick={() => run(async () => {
          const next = await editLive(campaign.id, character, silent, effect, bringToPlayer);
          onCampaign(next);
          setCharacter(next.state.characters[character.id]!);
          setStatus("Campaign updated.");
        })}>Apply live edit</button>
      </div>
    </details>
    <details onToggle={(event) => setAiOpen(event.currentTarget.open)}>
      <summary>AI settings</summary>
      {aiOpen && <CodexLogin />}
      {settings && <div className="gc-form">
        <p>{settings.model}</p>
        {(["fast", "strong"] as const).map((tier) => <label key={tier}>{tier} effort <select value={settings[tier]} onChange={(e) => setSettings({ ...settings, [tier]: e.target.value as Effort })}>
          {["none", "low", "medium", "high"].map((effort) => <option key={effort}>{effort}</option>)}
        </select></label>)}
        <button disabled={busy} onClick={() => run(async () => {
          setSettings(await saveAiSettings(settings));
          setStatus("AI settings saved.");
        })}>Save AI settings</button>
      </div>}
    </details>
    <details>
      <summary>AI inspector</summary>
      <button disabled={busy} onClick={() => run(async () => setTrace(await getInspector(campaign.id)))}>Load recent prompts and tool calls</button>
      {trace && (trace.length ? <pre className="ai-trace">{JSON.stringify(trace, null, 2)}</pre> : <p>No AI turns recorded yet.</p>)}
    </details>
    {error && <p className="error" role="alert">{error}</p>}
    <p role="status">{busy ? "Working…" : status}</p>
  </div>;
}

function CodexLogin() {
  const [status, setStatus] = useState<CodexAuthStatus>();
  const [refresh, setRefresh] = useState(0);
  const [checking, setChecking] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const pending = status?.login === "pending";

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        const next = await getCodexAuth(controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        if (next.login === "pending") timer = setTimeout(check, 2_000);
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    }
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);

  function checkAgain() {
    setChecking(true);
    setError("");
    setRefresh((value) => value + 1);
  }

  async function signIn() {
    setStarting(true);
    setError("");
    try {
      await startCodexLogin();
      setStatus({ credentials: "unknown", login: "pending" });
      checkAgain();
    } catch (error) {
      setError((error as Error).message);
      setRefresh((value) => value + 1);
    } finally {
      setStarting(false);
    }
  }

  const message = pending
    ? "Finish signing in in your default browser. This status updates automatically."
    : checking
      ? "Checking Codex login…"
      : status?.credentials === "present"
        ? "Codex credentials are available on this PC."
        : status?.credentials === "missing"
          ? "Codex is signed out."
          : "Couldn’t check Codex login. Confirm the CLI is installed.";
  return <fieldset className="gc-form">
    <legend>Codex login</legend>
    <p role="status">{message}</p>
    {status?.login === "failed" && !checking && (
      <p className="error" role="alert">The browser sign-in did not complete. Try again or run <code>codex login</code> in PowerShell.</p>
    )}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="quick-replies">
      <button type="button" disabled={starting || pending} onClick={signIn}>
        {starting ? "Opening…" : status?.credentials === "present" ? "Sign in again" : "Sign in with ChatGPT"}
      </button>
      <button type="button" className="ghost" disabled={checking || starting} onClick={checkAgain}>Check status</button>
    </div>
  </fieldset>;
}

function Skills({ character, onChange }: { character: Character; onChange: (next: Character) => void }) {
  const [newSkill, setNewSkill] = useState("");
  return <fieldset className="gc-form"><legend>Skills</legend>
    {Object.entries(character.skills).map(([name, modifier]) => <div className="quick-replies" key={name}>
      <label>{name} <input type="number" min={-5} max={10} value={modifier} onChange={(e) =>
        onChange({ ...character, skills: { ...character.skills, [name]: Number(e.target.value) } })} /></label>
      <button className="ghost" aria-label={`Remove ${name}`} onClick={() => {
        const { [name]: removed, ...skills } = character.skills;
        onChange({ ...character, skills });
      }}>Remove</button>
    </div>)}
    <div className="quick-replies">
      <input aria-label="New skill" maxLength={40} value={newSkill} onChange={(e) => setNewSkill(e.target.value)} />
      <button className="ghost" disabled={!newSkill.trim() || Object.hasOwn(character.skills, newSkill.trim())} onClick={() => {
        onChange({ ...character, skills: { ...character.skills, [newSkill.trim()]: 0 } });
        setNewSkill("");
      }}>Add skill</button>
    </div>
  </fieldset>;
}
