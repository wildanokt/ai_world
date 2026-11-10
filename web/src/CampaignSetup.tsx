import { useEffect, useRef, useState } from "react";
import { createCampaign, getWorld, listWorlds, type CampaignView, type CharacterProfile, type World, type WorldDoc, type WorldSummary } from "./api";
import { BLANK_CHARACTER, CharacterForm, Field, SettingFields, StartingLocationField } from "./GodConsole";

const steps = ["World & Setting", "Player Character", "Initial NPCs"];
const blankCharacter = (role: CharacterProfile["role"]): CharacterProfile => ({
  ...BLANK_CHARACTER, id: crypto.randomUUID(), role, name: "", maxHp: role === "player" ? 20 : 12,
});

export function CampaignSetup({
  worldId, onCancel, onStart,
}: {
  worldId?: string;
  onCancel: () => void;
  onStart: (campaign: CampaignView) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [doc, setDoc] = useState<World>();
  const [presetPlayer, setPresetPlayer] = useState<CharacterProfile>();
  const [step, setStep] = useState(0);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [portraitBusy, setPortraitBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  function applyPreset(world: World) {
    setDoc(world);
    setPresetPlayer(world.characters.find((character) => character.role === "player"));
    setSelected(world.characters.find((character) => character.role === "npc")?.id ?? "");
    setExcluded([]);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    async function load() {
      const list = await listWorlds();
      const preset = list.find((world) => world.id === worldId) ?? list[0];
      if (!preset) throw new Error("Create a World in the God Console first.");
      const world = await getWorld(preset.id);
      if (active) {
        setWorlds(list);
        applyPreset(world);
      }
    }
    void load().catch((err: Error) => {
      if (active) setError(err.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [worldId, retry]);

  async function chooseWorld(id: string) {
    setLoading(true);
    setError("");
    try { applyPreset(await getWorld(id)); }
    catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }

  function update(patch: Partial<WorldDoc>) {
    setDoc((current) => current && { ...current, ...patch });
  }

  function updateCharacter(id: string, patch: Partial<CharacterProfile>) {
    setDoc((current) => current && {
      ...current, characters: current.characters.map((character) => character.id === id ? { ...character, ...patch } : character),
    });
  }

  function close() {
    if (saving) return;
    dialog.current?.close();
    onCancel();
  }

  function navigate(next: number) {
    setError("");
    setStep(next);
    heading.current?.focus();
    dialog.current?.querySelector(".setup-body")?.scrollTo(0, 0);
  }

  const player = doc?.characters.find((character) => character.role === "player");
  const npcs = doc?.characters.filter((character) => character.role === "npc") ?? [];
  const npc = npcs.find((character) => character.id === selected);
  const cast = doc?.characters.filter((character) => character.role === "player" || !excluded.includes(character.id));
  const editing = portraitBusy || profileBusy;
  const busy = loading || saving || editing;

  async function start() {
    if (!doc || !cast || busy) return;
    const unnamed = cast.find((character) => !character.name.trim());
    if (unnamed) {
      setError("Name each selected character before starting the Campaign.");
      return;
    }
    const { id, premise, tone, contentLimits, lethality, startingLocation } = doc;
    setSaving(true);
    setError("");
    try {
      const next = await createCampaign({
        worldId: id, premise, tone, contentLimits, lethality, startingLocation,
        characters: cast.map((character) => character.role === "player" ? { ...character, location: startingLocation } : character),
      });
      dialog.current?.close();
      onStart(next);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  return <dialog ref={dialog} className="setup-dialog" aria-labelledby="setup-title" onCancel={(event) => {
    event.preventDefault();
    close();
  }}>
    <header className="setup-header">
      <div><h2 id="setup-title" tabIndex={-1} ref={heading}>New Campaign</h2><p>{doc?.name ?? "Choose where your story begins."}</p></div>
      <button className="ghost" onClick={close} disabled={saving}>Cancel</button>
    </header>
    <ol className="setup-steps" aria-label="Campaign setup progress">
      {steps.map((title, index) => <li key={title} aria-current={step === index ? "step" : undefined}>
        <span>{index + 1}</span>{title}
      </li>)}
    </ol>
    <div className="setup-body">
      {!doc && <p role="status">{loading ? "Loading Worlds…" : "Worlds unavailable."}</p>}
      {doc && step === 0 && <fieldset className="gc-form setup-fields" disabled={busy}>
        <legend className="sr-only">World and setting</legend>
        <Field label="World preset" hint="Choosing a different World replaces the settings and cast in this setup.">
          <select value={doc.id} onChange={(event) => void chooseWorld(event.target.value)}>
            {worlds.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </Field>
        <StartingLocationField doc={doc} update={update} />
        <SettingFields doc={doc} update={update} />
      </fieldset>}
      {doc && step === 1 && player && <div className="gc-form">
        <div className="setup-section-title">
          <div><h3>Player Character</h3><p>Starts at {doc.startingLocation} with full HP.</p></div>
          <div className="quick-replies">
            <button className="ghost" disabled={editing} onClick={() => update({ characters: [blankCharacter("player"), ...npcs] })}>New character</button>
            {presetPlayer && player.id !== presetPlayer.id && <button className="ghost" disabled={editing} onClick={() => update({ characters: [presetPlayer, ...npcs] })}>Restore preset</button>}
          </div>
        </div>
        <CharacterForm key={player.id} character={player} world={doc} locations={[]} lockLocation onPortraitBusy={setPortraitBusy} onProfileBusy={setProfileBusy} update={(patch) => updateCharacter(player.id, patch)} />
      </div>}
      {doc && step === 2 && <fieldset className="setup-fields setup-roster" disabled={saving}>
        <legend className="sr-only">Initial NPCs</legend>
        <div className="gc-list">
          <h3>Initial NPCs</h3>
          <p className="field-hint">Select who joins this Campaign.</p>
          {npcs.map((character) => <div className="roster-row" key={character.id}>
            <input aria-label={`Include ${character.name || "unnamed NPC"}`} type="checkbox" checked={!excluded.includes(character.id)} onChange={(event) => {
              const include = event.target.checked;
              setExcluded((current) => include ? current.filter((id) => id !== character.id) : [...current, character.id]);
            }} />
            <button className="ghost" disabled={editing} aria-pressed={selected === character.id} onClick={() => setSelected(character.id)}>{character.name || "Unnamed NPC"}</button>
          </div>)}
          <button className="ghost" disabled={editing || npcs.length >= 199} onClick={() => {
            const added = blankCharacter("npc");
            update({ characters: [...doc.characters, added] });
            setSelected(added.id);
          }}>Add NPC</button>
        </div>
        {npc && <CharacterForm key={npc.id} character={npc} world={doc} locations={doc.locations.map(({ name }) => name)} onPortraitBusy={setPortraitBusy} onProfileBusy={setProfileBusy} update={(patch) => updateCharacter(npc.id, patch)} />}
      </fieldset>}
    </div>
    <footer className="setup-footer">
      {error && <p className="error" role="alert">{error}</p>}
      <div>
        {step > 0 && <button className="ghost" disabled={busy} onClick={() => navigate(step - 1)}>Back</button>}
        {!doc && !loading && <button className="ghost" onClick={() => setRetry((count) => count + 1)}>Retry</button>}
        {step < 2
          ? <button disabled={busy || !doc || (step === 1 && !player?.name.trim())} onClick={() => navigate(step + 1)}>Next</button>
          : <button disabled={busy || !doc} onClick={() => void start()}>{saving ? "Starting…" : "Start Campaign"}</button>}
      </div>
    </footer>
  </dialog>;
}
