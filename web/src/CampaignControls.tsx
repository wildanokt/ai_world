import { AiLoading } from "./AiLoading";
import { useEffect, useState, type FormEvent } from "react";
import {
  addSnapshot, editLive, generatePortrait, getAiSettings, getCampaign, getCodexAuth, getInspector, getTimeline,
  cancelCodexLogin, finishCodexLogin, portraitUrl, rewind, saveAiSettings, startCodexLogin, uploadPortrait,
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
  const [canceling, setCanceling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [copiedCode, setCopiedCode] = useState("");
  const pending = status?.login === "pending";
  const device = status?.device;
  const browser = status?.browser;
  const challenge = browser ?? device;

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

  async function signIn(method: "browser" | "device") {
    setStarting(true);
    setError("");
    try {
      await startCodexLogin(method);
      checkAgain();
    } catch (error) {
      setError((error as Error).message);
      setRefresh((value) => value + 1);
    } finally {
      setStarting(false);
    }
  }

  async function submitBrowserResult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const form = event.currentTarget;
    const address = String(new FormData(form).get("address") ?? "");
    setSubmitting(true);
    setError("");
    try {
      await finishCodexLogin(address);
      form.reset();
      checkAgain();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    setCanceling(true);
    setError("");
    try {
      await cancelCodexLogin();
      checkAgain();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setCanceling(false);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
    } catch {
      setError("Select the code and copy it manually.");
    }
  }

  const pendingMessages = {
    preparing: browser ? "Preparing browser sign-in…" : "Getting a one-time code…",
    "other-session": "Codex sign-in is open in another browser session.",
    canceling: "Canceling sign-in…",
    finishing: "Finishing sign-in…",
    ready: "Waiting for you to sign in.",
  };
  const message = pending && challenge ? pendingMessages[challenge.state]
    : pending ? "Finish signing in in your default browser."
    : checking ? "Checking Codex login…"
    : status?.credentials === "present" ? "Codex is signed in."
    : status?.credentials === "missing" ? "Codex is signed out."
    : "Couldn’t check Codex login. Confirm the CLI is installed.";
  return <fieldset className="gc-form">
    <legend>Codex login</legend>
    <p role="status">{message}</p>
    {status?.login === "failed" && !checking && (
      <p className="error" role="alert">Sign-in expired or did not complete. Try again.</p>
    )}
    {browser?.state === "ready" && <>
      <a className="codex-sign-in-link" href={browser.url} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a>
      <p>Sign in on this device. When the last tab opens a <code>127.0.0.1</code> address, copy its full address, even if the page can’t load.</p>
      <form className="gc-form" onSubmit={submitBrowserResult}>
        <label className="field">
          <span className="field-label">Address from the last tab</span>
          <input type="password" name="address" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={8000} required />
        </label>
        <div className="quick-replies">
          <button type="submit" disabled={submitting || canceling}>{submitting ? "Finishing…" : "Finish sign-in"}</button>
        </div>
      </form>
    </>}
    {device?.state === "ready" && <>
      <a className="codex-sign-in-link" href={device.url} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a>
      <p>Choose your ChatGPT account and enter this one-time code within 15 minutes.</p>
      <div className="quick-replies">
        <code className="codex-device-code">{device.code}</code>
        <button type="button" className="ghost" onClick={() => void copyCode(device.code)}>
          {copiedCode === device.code ? "Copied" : "Copy code"}
        </button>
      </div>
      <p className="muted">If prompted, enable device code sign-in in your ChatGPT security settings.</p>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="quick-replies">
      {!pending && <>
        <button type="button" disabled={starting || checking} onClick={() => void signIn("browser")}>
          {starting ? "Starting…" : status?.credentials === "present" ? "Sign in again" : "Sign in with ChatGPT"}
        </button>
        {status?.hosted && <button type="button" className="ghost" disabled={starting || checking}
          onClick={() => void signIn("device")}>Use device code</button>}
      </>}
      {(challenge?.state === "ready" || challenge?.state === "preparing") &&
        <button type="button" className="ghost" disabled={canceling || submitting} onClick={cancel}>Cancel sign-in</button>}
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
