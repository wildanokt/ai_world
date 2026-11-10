import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, getCampaign, portraitUrl, takeTurn, type CampaignView, type Character, type TranscriptEntry } from "./api";
import { AiLoading } from "./AiLoading";
import { GodConsole } from "./GodConsole";
import { CampaignSetup } from "./CampaignSetup";
import { TravelDialog } from "./TravelDialog";
import { campaignTime } from "./campaign-time";

const GAME_MASTER_PORTRAIT = new URL("./assets/game-master.webp", import.meta.url).href;
const CAMPAIGN_KEY = "ai-rpg.campaignId";
const STARTER_ACTIONS = ["Look around.", "Talk to someone nearby.", "Check my belongings."];
const JOURNAL_SECTIONS = [["quest", "Quests"], ["person", "People"], ["place", "Places"], ["note", "Notes"]] as const;

function readSavedId() {
  try { return localStorage.getItem(CAMPAIGN_KEY); } catch { return null; }
}

function saveId(id: string) {
  try { localStorage.setItem(CAMPAIGN_KEY, id); } catch { /* Storage may be unavailable. */ }
}

// Share the first request across StrictMode's double effect.
let initialCampaign: Promise<CampaignView | null> | undefined;
function loadInitialCampaign() {
  const id = readSavedId();
  if (!id) return Promise.resolve(null);
  return initialCampaign ??= getCampaign(id).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }).finally(() => { initialCampaign = undefined; });
}

export function App() {
  const [campaign, setCampaign] = useState<CampaignView | null>(null);
  const [pending, setPending] = useState<{ player: string; narration: string; targets: { id: string; name: string }[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [atLatest, setAtLatest] = useState(true);
  const [setup, setSetup] = useState<{ worldId?: string } | null>(null);
  const [travelOpen, setTravelOpen] = useState(false);
  const followLog = useRef(true);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const draftMirror = useRef<HTMLDivElement>(null);
  const targetPicker = useRef<HTMLDetailsElement>(null);
  const sending = useRef(false);
  const sheetDialog = useRef<HTMLDialogElement>(null);
  const navigationDialog = useRef<HTMLDialogElement>(null);

  async function connect() {
    setLoading(true);
    setError("");
    try {
      const current = await loadInitialCampaign();
      setCampaign(current);
      if (!current) setSetup({});
    }
    catch { setError("Couldn’t connect to the game. Check that the local server is running, then retry."); }
    finally { setLoading(false); }
  }

  useEffect(() => { void connect(); }, []);
  useEffect(() => {
    if (followLog.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [campaign, pending]);
  useEffect(() => {
    const allowed = new Set(availableAddressees(campaign).map(({ id }) => id));
    setTargetIds((ids) => ids.every((id) => allowed.has(id)) ? ids : ids.filter((id) => allowed.has(id)));
  }, [campaign]);
  useEffect(() => {
    if (draftMirror.current && input.current) draftMirror.current.scrollTop = input.current.scrollTop;
  }, [draft]);

  function acceptCampaign(next: CampaignView) {
    if (next.id !== campaign?.id) setTargetIds([]);
    saveId(next.id);
    followLog.current = true;
    setAtLatest(true);
    setCampaign(next);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!campaign || !text || sending.current || pending || loading) return;
    sending.current = true;
    setDraft("");
    setError("");
    followLog.current = true;
    setAtLatest(true);
    setPending({ player: text, narration: "", targets: selectedTargets });
    try {
      const next = await takeTurn(campaign.id, text, (delta) =>
        setPending((current) => current ? { ...current, narration: current.narration + delta } : current),
        selectedTargets.map(({ id }) => id));
      setCampaign({ id: campaign.id, ...next });
    } catch (err) {
      setError(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Lost connection to the game. Try again when the server is back.");
      setDraft(text);
      try {
        const recovered = await getCampaign(campaign.id);
        setCampaign(recovered);
        const lastAction = recovered.transcript.filter((entry) => entry.kind === "player").at(-1);
        if (recovered.transcript.length > campaign.transcript.length && lastAction?.text === text) {
          setDraft("");
          setError("");
        }
      } catch { /* Keep the original action available to retry. */ }
    } finally {
      setPending(null);
      sending.current = false;
    }
  }

  function openSetup(worldId = campaign?.state.world.id ?? undefined) {
    if (!pending && !loading) setSetup({ worldId });
  }

  function chooseAction(text: string) {
    setDraft(text);
    input.current?.focus();
  }

  function openJournal() {
    const dialog = sheetDialog.current;
    if (!dialog) return;
    dialog.showModal();
    const journal = dialog.querySelector<HTMLDetailsElement>(".sheet-journal");
    if (journal) {
      journal.open = true;
      journal.querySelector("summary")?.focus();
    }
  }

  function toggleTarget(id: string) {
    setTargetIds((current) => current.includes(id) ? current.filter((target) => target !== id) : [...current, id]);
  }

  function talkTo(id: string) {
    toggleTarget(id);
    sheetDialog.current?.close();
    input.current?.focus();
  }

  const pc = campaign?.state.characters[campaign.state.playerCharacterId];
  const availableTargets = availableAddressees(campaign);
  const selectedTargets = availableTargets.filter(({ id }) => targetIds.includes(id));
  const transcript = useMemo(() => withoutRepeatedReplies(campaign?.transcript ?? []), [campaign?.transcript]);
  const showDraftFormatting = draft.includes("**");
  const isBeginning = campaign?.transcript.length === 0 && !pending;
  const blocked = loading || !!pending;
  const suggestions = isBeginning ? STARTER_ACTIONS : campaign?.state.suggestions ?? [];
  const hasCustomDraft = !!draft.trim() && !suggestions.includes(draft);

  function fromNavigation(action: () => void) {
    navigationDialog.current?.close();
    action();
  }

  const navigation = (
    <nav className="header-actions" aria-label="Game navigation">
      <a className="nav-item" href="#story" aria-current="page" onClick={() => navigationDialog.current?.close()}><NavIcon name="story" />Story</a>
      {pc && <button className="nav-item mobile-sheet" onClick={() => fromNavigation(() => sheetDialog.current?.showModal())} aria-haspopup="dialog"><NavIcon name="campaign" />Campaign</button>}
      {pc && <button className="nav-item" onClick={() => fromNavigation(openJournal)} aria-haspopup="dialog"><NavIcon name="journal" />Journal</button>}
      {pc && <button className="nav-item" onClick={() => fromNavigation(() => setTravelOpen(true))} disabled={blocked || !!campaign?.state.combat || pc.hp <= 0}
        title={campaign?.state.combat ? "End combat before travelling" : undefined} aria-haspopup="dialog"><NavIcon name="travel" />Travel</button>}
      <button className="nav-item" onClick={() => fromNavigation(() => setConsoleOpen(true))} disabled={blocked} aria-haspopup="dialog"><NavIcon name="console" />God Console</button>
      <button className="nav-item new-campaign" onClick={() => fromNavigation(() => openSetup())} disabled={blocked || !campaign} aria-haspopup="dialog"><NavIcon name="new" />New campaign</button>
    </nav>
  );

  return (
    <div className="layout">
      <header className="chat-header">
        <div className="campaign-title">
          <span className="world-mark" aria-hidden="true">
            <svg viewBox="0 0 28 28" fill="none"><path d="M14 2 25 14 14 26 3 14 14 2Z"/><path d="M14 6v16M6 14h16m-12-4 8 8m0-8-8 8"/></svg>
          </span>
          <p className="app-name">AI World</p>
        </div>
        {navigation}
        <button type="button" className="ghost menu-toggle" onClick={() => navigationDialog.current?.showModal()}
          aria-haspopup="dialog"><NavIcon name="menu" />Menu</button>
      </header>

      <dialog ref={navigationDialog} className="navigation-drawer" aria-labelledby="navigation-title">
        <header>
          <h2 id="navigation-title">AI World</h2>
          <button type="button" className="ghost" onClick={() => navigationDialog.current?.close()}>Close</button>
        </header>
        {navigation}
      </dialog>

      <main id="story" className="chat" aria-label="Story" tabIndex={-1}>
        <section className="scene-banner" aria-label={pc ? "Current location" : "Campaign setting"}>
          <div className="scene-title">
            {campaign && <p>{campaign.state.world.name} · {campaignTime(campaign.state.clock)}</p>}
            <h1>{pc?.location ?? "Your next adventure"}</h1>
          </div>
        </section>
        <div ref={log} className="log" role="log" aria-label="Story transcript" tabIndex={0} onScroll={(event) => {
          const el = event.currentTarget;
          const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          followLog.current = nearEnd;
          setAtLatest(nearEnd);
        }}>
          {isBeginning && pc && (
            <section className="story-opening">
              <svg className="story-seal" viewBox="0 0 80 80" fill="none" aria-hidden="true">
                <circle cx="40" cy="40" r="35" /><circle cx="40" cy="40" r="29" strokeDasharray="1 4" />
                <path d="m40 16 6 18 18 6-18 6-6 18-6-18-18-6 18-6zM40 33v14m-7-7h14" />
              </svg>
              <h2>Your story begins</h2>
              <p>You’re playing as <strong>{pc.name}</strong>. Tell the Game Master what you do, or pick an action to start.</p>
              <div className="quick-replies starter-actions" aria-label="Starting actions">
                {STARTER_ACTIONS.map((action) => <button className="ghost" key={action} disabled={blocked || hasCustomDraft} onClick={() => chooseAction(action)}>{action}</button>)}
              </div>
            </section>
          )}
          {!campaign && !loading && !error && <section className="connect-state"><h2>Your story begins here</h2><p>Choose a World and create your starting cast.</p><button onClick={() => openSetup()}>Set up a Campaign</button></section>}
          {!campaign && loading && <p className="connect-state" role="status">Opening your Campaign…</p>}
          {!campaign && !loading && error && (
            <section className="connect-state">
              <h2>Game unavailable</h2>
              <p role="alert">{error}</p>
              <button onClick={connect}>Retry connection</button>
            </section>
          )}
          {transcript.map((entry, index) => <Entry key={index} entry={entry} player={pc} npc={entry.kind === "npc" ? campaign?.state.characters[entry.characterId] : undefined} />)}
          {pending && <>
            <Entry entry={{ kind: "player", text: pending.player, targets: pending.targets }} player={pc} />
            <Entry
              entry={{ kind: "gm", text: pending.narration || "Considering your action…" }}
              thinking={!pending.narration}
            />
          </>}
        </div>
        <div className="composer-area">
          {!atLatest && <button className="ghost jump-latest" onClick={() => {
            if (log.current) log.current.scrollTop = log.current.scrollHeight;
            followLog.current = true;
            setAtLatest(true);
          }}>Jump to latest</button>}
          {campaign && error && <p className="error turn-error" role="alert">{error}</p>}
          {!!campaign?.state.suggestions.length && !blocked && !isBeginning && !hasCustomDraft && (
            <div className="suggested">
              <span className="control-label">Suggested actions</span>
              <div className="quick-replies">
                {campaign.state.suggestions.map((reply, index) =>
                  <button className="ghost" key={index} onClick={() => chooseAction(reply)}>{reply}</button>
                )}
              </div>
            </div>
          )}
          <form className="composer" onSubmit={send}>
            {availableTargets.length > 0 && <div className="target-controls">
              <details ref={targetPicker} className="target-picker" onKeyDown={(event) => {
                if (event.key === "Escape" && event.currentTarget.open) {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary")?.focus();
                }
              }}>
                <summary>Talk to{selectedTargets.length ? ` (${selectedTargets.length})` : ""}</summary>
                <div className="target-options" role="group" aria-label="NPC dialogue targets">
                  {availableTargets.map(({ id, name, portrait }) => <button key={id} type="button" className="ghost"
                    aria-pressed={targetIds.includes(id)} disabled={blocked} onClick={() => toggleTarget(id)}>
                    {portrait && <img className="portrait" src={portraitUrl(portrait)} alt="" />}
                    {name}
                  </button>)}
                </div>
              </details>
              {selectedTargets.length > 0 && <>
                <span className="target-label" aria-live="polite">To {selectedTargets.map(({ name }) => name).join(", ")}</span>
                <button type="button" className="ghost clear-targets" disabled={blocked} onClick={() => setTargetIds([])}>Clear</button>
              </>}
            </div>}
            <label className="control-label" htmlFor="player-action">Your action or dialogue</label>
            <div className="composer-row">
              <div className="action-field">
                {showDraftFormatting && <div ref={draftMirror} className="action-mirror" aria-hidden="true">
                  {formatDraft(draft)}{"\u200b"}
                </div>}
                <textarea
                  id="player-action"
                  ref={input}
                  className={showDraftFormatting ? "with-draft-formatting" : undefined}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={() => { if (targetPicker.current) targetPicker.current.open = false; }}
                  onScroll={(event) => {
                    if (draftMirror.current) draftMirror.current.scrollTop = event.currentTarget.scrollTop;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      if (!blocked) event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="What do you do or say?"
                  aria-describedby="chat-format-hint"
                  rows={2}
                  maxLength={4000}
                  disabled={!campaign}
                  readOnly={blocked}
                />
              </div>
              <button type="submit" disabled={!campaign || blocked || !draft.trim()}>
                {pending ? "Waiting…" : "Act"}
                {!pending && <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11m-5-5 5 5-5 5" /></svg>}
              </button>
            </div>
            <p className="chat-format-hint" id="chat-format-hint"><code>**action**</code> for actions · <code>Name, dialogue</code> to address an NPC</p>
            <p className="keyboard-hint"><kbd>Enter</kbd> to act <span>·</span> <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</p>
          </form>
        </div>
      </main>

      {campaign && pc && <>
        <aside className="sheet desktop-sheet" aria-label="Campaign details"><CampaignSheet campaign={campaign} targetIds={targetIds} onTalk={blocked ? undefined : talkTo} /></aside>
        <dialog ref={sheetDialog} className="sheet-dialog" aria-label="Campaign details">
          <header>
            <h2>Campaign details</h2>
            <button className="ghost" onClick={() => sheetDialog.current?.close()}>Close</button>
          </header>
          <div className="sheet"><CampaignSheet campaign={campaign} targetIds={targetIds} onTalk={blocked ? undefined : talkTo} /></div>
          <footer><button className="ghost" disabled={blocked} onClick={() => {
            sheetDialog.current?.close();
            openSetup();
          }}>New campaign</button></footer>
        </dialog>
      </>}

      {setup && <CampaignSetup worldId={setup.worldId} onCancel={() => setSetup(null)} onStart={(next) => {
        acceptCampaign(next);
        setDraft("");
        setError("");
        setSetup(null);
      }} />}
      {travelOpen && campaign && <TravelDialog campaign={campaign} onClose={() => setTravelOpen(false)} onTravel={acceptCampaign} />}
      {consoleOpen && <GodConsole
        campaign={campaign}
        onCampaign={acceptCampaign}
        currentWorldId={campaign?.state.world.id ?? null}
        onClose={() => setConsoleOpen(false)}
        onPlay={(worldId) => {
          setConsoleOpen(false);
          openSetup(worldId);
        }}
      />}
    </div>
  );
}

const navigationPaths = {
  story: "M4 5h16v11H9l-5 4V5Zm4 4h8m-8 3h6",
  campaign: "M5 4h14v16H5V4Zm4 11a3 3 0 0 1 6 0m-3-4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  journal: "M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Zm0 13h14M9 8h6m-6 4h6",
  travel: "m12 3 8 9-8 9-8-9 8-9Zm0 5 2.5 4-2.5 4-2.5-4L12 8Z",
  console: "M4 7h16M4 17h16M8 4v6m8 4v6",
  new: "M12 5v14M5 12h14",
  menu: "M4 6h16M4 12h16M4 18h16",
};

function NavIcon({ name }: { name: keyof typeof navigationPaths }) {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={navigationPaths[name]} /></svg>;
}

function CampaignSheet({ campaign, targetIds, onTalk }: { campaign: CampaignView; targetIds: string[]; onTalk?: (id: string) => void }) {
  const { state } = campaign;
  const pc = state.characters[state.playerCharacterId]!;
  const npcs = Object.values(state.characters).filter((c) => c.role === "npc");
  const present = npcs.filter((c) => c.location === pc.location);
  const inventory = Object.entries(pc.inventory);
  const { input, cached, output } = state.usage;
  const cost = (Math.max(0, input - cached) * 0.10 + cached * 0.01 + output * 0.50) / 1_000_000;
  return <>
    <div className="sheet-character">
      {pc.portrait ? <img className="portrait portrait-player" src={portraitUrl(pc.portrait)} alt="" /> :
        <span className="character-monogram" aria-hidden="true">{Array.from(pc.name.trim())[0] ?? "?"}</span>}
      <div><h2>{pc.name}</h2><p className="muted">Player Character</p></div>
    </div>
    <div className="vitals">
      <div><span>Health</span><strong>{pc.hp} / {pc.maxHp} HP</strong></div>
      <meter min={0} max={pc.maxHp} value={pc.hp} aria-label="Health" />
      {pc.condition && <p className="condition">{pc.condition}</p>}
    </div>
    {state.combat && <section className="sheet-section combat-order">
      <h3>Combat order</h3>
      <ol>{state.combat.order.map((id, index) => <li key={id} aria-current={index === state.combat?.turn ? "step" : undefined}>
        {state.characters[id]?.name ?? id}{index === state.combat?.turn && <span>Up next</span>}
      </li>)}</ol>
    </section>}
    <section className="sheet-section">
      <h3>People here</h3>
      {present.length ? <ul>{present.map((npc) => {
        const stance = attitude(npc.relationship);
        return <li key={npc.id}>
          {npc.portrait && <img className="portrait" src={portraitUrl(npc.portrait)} alt="" />}
          <span className="npc-name">{npc.name}</span><span className={`attitude ${stance}`}>{stance}</span>
          {npc.hp > 0 && <button type="button" className="ghost talk-button" disabled={!onTalk}
            aria-pressed={targetIds.includes(npc.id)} aria-label={`Talk to ${npc.name}`}
            onClick={() => onTalk?.(npc.id)}>Talk</button>}
        </li>;
      })}</ul> : <p className="muted">{npcs.length ? "No NPCs at this location." : "This Campaign has no NPCs."}</p>}
      {npcs.length > present.length && <p className="muted">NPCs elsewhere: {npcs.length - present.length}</p>}
    </section>
    <SheetDisclosure title="Inventory" count={inventory.length} open>
      {inventory.length ? <ul>{inventory.map(([item, qty]) => <li key={item}>{item}<span className="qty">×{qty}</span></li>)}</ul>
        : <p className="muted">Your inventory is empty.</p>}
    </SheetDisclosure>
    <SheetDisclosure title="Journal" count={state.journal.length} className="sheet-journal">
      {JOURNAL_SECTIONS.map(([kind, title]) => {
        const entries = state.journal.filter((entry) => entry.kind === kind);
        return entries.length > 0 && <section key={kind}><h3>{title}</h3>
          <ul>{entries.map(({ text }) => <li key={text}>{text}</li>)}</ul>
        </section>;
      })}
      {!state.journal.length && <p className="muted">Discoveries and quests appear here as you play.</p>}
    </SheetDisclosure>
    <SheetDisclosure title="AI usage">
      <p>{input.toLocaleString()} input · {output.toLocaleString()} output tokens</p>
      <p className="muted">API equivalent ≈ ${cost.toFixed(4)} USD</p>
    </SheetDisclosure>
  </>;
}

function SheetDisclosure({ title, count, open, className = "", children }: { title: string; count?: number; open?: boolean; className?: string; children: ReactNode }) {
  return <details className={`sheet-disclosure ${className}`} open={open}>
    <summary>{title}{count !== undefined && <span className="qty">{count}</span>}</summary>
    <div>{children}</div>
  </details>;
}

/** Same bands as the Game Master's context. Old campaigns may lack a relationship score. */
function attitude(score = 0) {
  if (score <= -6) return "hostile";
  if (score <= -2) return "wary";
  if (score < 2) return "neutral";
  if (score < 6) return "friendly";
  return "devoted";
}

function availableAddressees(campaign: CampaignView | null) {
  if (!campaign) return [];
  const { characters, playerCharacterId } = campaign.state;
  const location = characters[playerCharacterId]?.location;
  return Object.values(characters).filter((npc) => npc.role === "npc" && npc.location === location && npc.hp > 0);
}

function withoutRepeatedReplies(transcript: TranscriptEntry[]) {
  const seen = new Set<string>();
  return transcript.filter((entry) => {
    if (entry.kind === "player") seen.clear();
    if (entry.kind !== "npc") return true;
    const key = JSON.stringify([entry.characterId, entry.text.trim().replace(/\s+/g, " ")]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatDraft(text: string) {
  return text.split("**").map((part, index) => (
    <span key={index}>
      {index > 0 && <span className="action-marker">**</span>}
      {index % 2 ? <em>{part}</em> : part}
    </span>
  ));
}

function formatActions(text: string) {
  return text.split(/\*\*([\s\S]+?)\*\*/g).map((part, index) =>
    index % 2 === 1 ? <em key={index}>{part}</em> : part,
  );
}

function Entry({ entry, player, npc, thinking }: {
  entry: TranscriptEntry;
  player?: Pick<Character, "name" | "portrait">;
  npc?: Pick<Character, "portrait">;
  thinking?: boolean;
}) {
  if (entry.kind !== "roll") {
    const isPlayer = entry.kind === "player";
    const name = isPlayer ? player?.name || "You" : entry.kind === "npc" ? entry.name : "Game Master";
    const portrait = isPlayer ? player?.portrait : npc?.portrait;
    const src = entry.kind === "gm" ? GAME_MASTER_PORTRAIT : portrait ? portraitUrl(portrait) : undefined;
    return <article className={`entry ${entry.kind}${thinking ? " thinking" : ""}`}>
      <span className="entry-avatar" aria-hidden="true">
        {entry.kind === "gm" ? "GM" : Array.from(name.trim())[0] ?? "?"}
        {src && <img key={src} src={src} alt="" width={40} height={40} onError={(event) => { event.currentTarget.hidden = true; }} />}
      </span>
      <div className="entry-bubble">
        <span className="entry-author">{name}</span>
        {entry.kind === "player" && !!entry.targets?.length &&
          <span className="entry-targets">To {entry.targets.map(({ name }) => name).join(", ")}</span>}
        <p>{thinking ? <AiLoading>{entry.text}</AiLoading> : formatActions(entry.text)}</p>
      </div>
    </article>;
  }
  const outcome = entry.critical ? `Critical ${entry.critical}` : entry.success ? "Success" : "Failure";
  return <div className={`roll ${entry.success ? "ok" : "fail"}`}>
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 2 9 5v10l-9 5-9-5V7zm0 0L3 17h18z" /></svg>
    <span>{entry.reason} <span aria-hidden="true">·</span> d20 <strong>{entry.roll}</strong> <span aria-hidden="true">→</span> {entry.total} vs {entry.difficulty}</span>
    <strong className="roll-outcome">{outcome}</strong>
  </div>;
}
