import { AiLoading } from "./AiLoading";
import { ProfileDraft } from "./ProfileDraft";
import { CampaignControls, PortraitPicker } from "./CampaignControls";
import type { CampaignView, CatalogEntry, Location, Route } from "./api";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  applyCharacterProfile,
  createWorld,
  deleteWorld,
  draftCharacter,
  draftWorld,
  getWorld,
  listWorlds,
  updateWorld,
  type CharacterProfile,
  type Lethality,
  type Role,
  type WorldDoc,
  type WorldSummary,
} from "./api";

type Busy = "loading" | "applying-character" | "saving" | "deleting" | "drafting-world" | "drafting-character" | null;

export const BLANK_CHARACTER: Omit<CharacterProfile, "id" | "name" | "role"> = {
  description: "",
  personality: "",
  goals: "",
  secrets: "",
  maxHp: 12,
  skills: {},
  location: "",
  inventory: {},
};

const blankWorld = (): WorldDoc => ({
  name: "New World",
  premise: "",
  tone: "",
  contentLimits: "",
  lethality: "standard",
  startingLocation: "Starting village",
  locations: [{ name: "Starting village", description: "" }],
  characters: [{ ...BLANK_CHARACTER, id: "pc", name: "Hero", role: "player", maxHp: 20 }],
});

function newId(name: string, taken: string[]) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

export function GodConsole({
  campaign,
  onCampaign,
  currentWorldId,
  onClose,
  onPlay,
}: {
  campaign: CampaignView | null;
  onCampaign: (next: CampaignView) => void;
  currentWorldId: string | null;
  onClose: () => void;
  onPlay: (worldId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [worldId, setWorldId] = useState<string | null>(null);
  const [doc, setDoc] = useState<WorldDoc | null>(null);
  const [saved, setSaved] = useState("");
  const [tab, setTab] = useState<"world" | "characters" | "campaign">("world");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty = doc !== null && JSON.stringify(doc) !== saved;
  const confirmDiscard = () => !dirty || confirm("Discard unsaved changes to this World?");

  async function run(kind: Busy, task: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function show(id: string | null, next: WorldDoc, isSaved: boolean) {
    setWorldId(id);
    setDoc(next);
    setSaved(isSaved ? JSON.stringify(next) : "");
    setSelected(next.characters[0]?.id ?? null);
  }

  async function open(id: string) {
    const { id: _id, ...w } = await getWorld(id);
    show(id, w, true);
  }

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    run("loading", async () => {
      const list = await listWorlds();
      setWorlds(list);
      const first = list.find((w) => w.id === currentWorldId) ?? list[0];
      if (first) await open(first.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    if (!confirmDiscard()) return;
    dialog.current?.close();
    onClose();
  };

  const update = (patch: Partial<WorldDoc>) => setDoc((d) => (d ? { ...d, ...patch } : d));
  const updateCharacter = (id: string, patch: Partial<CharacterProfile>) =>
    setDoc((d) => (d ? { ...d, characters: d.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : d));

  async function save(): Promise<string | null> {
    if (!doc) return null;
    const result = worldId ? await updateWorld(worldId, doc) : await createWorld(doc);
    const { id, ...w } = result;
    show(id, w, true);
    setSelected((s) => s ?? w.characters[0]?.id ?? null);
    setWorlds(await listWorlds());
    return id;
  }

  const character = doc?.characters.find((c) => c.id === selected) ?? null;
  const working = busy !== null;
  const canApplyCharacter = campaign && character && campaign.state.world.id === worldId &&
    campaign.state.characters[character.id]?.role === character.role;

  return (
    <dialog
      ref={dialog}
      className="god-console"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-label="God Console"
    >
      <header className="gc-header">
        <h2>God Console</h2>
        {tab !== "campaign" && <>
        <select
          aria-label="World"
          value={worldId ?? ""}
          disabled={working}
          onChange={(e) => {
            if (confirmDiscard()) run("loading", () => open(e.target.value));
          }}
        >
          {worldId === null && <option value="">{doc ? `${doc.name} (unsaved)` : "Loading…"}</option>}
          {worlds.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <button
          className="ghost"
          disabled={working}
          onClick={() => {
            if (!confirmDiscard()) return;
            show(null, blankWorld(), false);
            setTab("world");
          }}
        >
          New World
        </button>
        </>}
        <button className="ghost close" onClick={close}>Close</button>
      </header>

      <nav className="gc-tabs" aria-label="God Console sections">
        {(["world", "characters", "campaign"] as const).filter((section) => section !== "campaign" || campaign).map((section) => (
          <button key={section} aria-pressed={tab === section} className={tab === section ? "active" : ""} onClick={() => setTab(section)}>
            {section === "world" ? "World" : section === "characters" ? `Characters${doc ? ` (${doc.characters.length})` : ""}` : "Live Campaign"}
          </button>
        ))}
      </nav>

      {tab === "world" && <DraftBar
        label="Draft a new World from keywords"
        placeholder="e.g. floating islands, sky pirates, storm god"
        busy={busy === "drafting-world"}
        disabled={working}
        onDraft={(keywords) =>
          confirmDiscard() &&
          run("drafting-world", async () => {
            show(null, await draftWorld(keywords), false);
            setTab("world");
            setNotice("Draft ready. Review and edit it, then Save to keep it.");
          })
        }
      />}

      <div className="gc-body" hidden={tab !== "campaign"}>
        {campaign && <CampaignControls key={campaign.id} campaign={campaign} onCampaign={onCampaign} />}
      </div>
      <div className="gc-body" hidden={tab === "campaign"}>
        {tab !== "campaign" && !doc && <p className="hint">{busy === "loading" ? "Loading…" : "No World selected."}</p>}
        {doc && tab === "world" && <WorldForm doc={doc} update={update} />}
        {doc && tab === "characters" && (
          <div className="gc-characters">
            <div className="gc-list">
              <ul>
                {doc.characters.map((c) => (
                  <li key={c.id}>
                    <button className={c.id === selected ? "active" : ""} onClick={() => setSelected(c.id)}>
                      <span>{c.name || "Unnamed"}</span>
                      <span className={`badge ${c.role}`}>{c.role === "player" ? "Player" : "NPC"}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                className="ghost"
                onClick={() => {
                  const id = newId("new-npc", doc.characters.map((c) => c.id));
                  update({ characters: [...doc.characters, { ...BLANK_CHARACTER, id, name: "New NPC", role: "npc" }] });
                  setSelected(id);
                }}
              >
                + Add NPC
              </button>
              <CharacterDraftBar
                busy={busy === "drafting-character"}
                disabled={working}
                onDraft={(keywords, role) =>
                  run("drafting-character", async () => {
                    const drafted = await draftCharacter(keywords, role, doc);
                    setDoc((d) => {
                      if (!d) return d;
                      const id = newId(drafted.id, d.characters.map((c) => c.id));
                      const others = role === "player" ? d.characters.map((c) => ({ ...c, role: "npc" as Role })) : d.characters;
                      setSelected(id);
                      return { ...d, characters: [...others, { ...drafted, id }] };
                    });
                    setNotice(
                      role === "player"
                        ? "Draft ready. It is now the Player Character; the previous one became an NPC. Save to keep it."
                        : "Draft ready. Review and edit it, then Save to keep it.",
                    );
                  })
                }
              />
            </div>
            {character ? (
              <div className="gc-form">
                <p className="field-hint">Save updates the World template. {canApplyCharacter
                  ? "Apply to active Campaign copies the name, profile, portrait, skills, and max HP into your current story."
                  : campaign && "Open Live Campaign to edit a character already in your current story."}</p>
                {canApplyCharacter && <button className="ghost" disabled={working || !character.name.trim()} onClick={() =>
                  run("applying-character", async () => {
                    onCampaign(await applyCharacterProfile(campaign.id, character));
                    setNotice("Character updated in the active Campaign.");
                  })
                }>{busy === "applying-character" ? "Applying…" : "Apply to active Campaign"}</button>}
              <CharacterForm
                key={character.id}
                character={character}
                world={doc}
                locations={doc.locations.map((l) => l.name)}
                update={(patch) => updateCharacter(character.id, patch)}
                makePlayer={() =>
                  update({
                    characters: doc.characters.map((c) => ({ ...c, role: c.id === character.id ? "player" : "npc" })),
                  })
                }
                remove={() => {
                  if (!confirm(`Remove ${character.name} from this World?`)) return;
                  const rest = doc.characters.filter((c) => c.id !== character.id);
                  update({ characters: rest });
                  setSelected(rest[0]?.id ?? null);
                }}
              />
              </div>
            ) : (
              <p className="hint">Select or add a character.</p>
            )}
          </div>
        )}
      </div>

      {tab !== "campaign" && <footer className="gc-footer">
        <div className="gc-status" aria-live="polite">
          {error && <span className="error">{error}</span>}
          {!error && notice && <span className="notice">{notice}</span>}
          {!error && !notice && dirty && <span className="muted">Unsaved changes</span>}
        </div>
        {worldId && (
          <button
            className="ghost danger"
            disabled={working || worlds.length <= 1}
            title={worlds.length <= 1 ? "The last World cannot be deleted" : undefined}
            onClick={() => {
              if (!confirm(`Delete the World "${doc?.name}"? Campaigns already started keep their copy.`)) return;
              run("deleting", async () => {
                await deleteWorld(worldId);
                const list = await listWorlds();
                setWorlds(list);
                if (list[0]) await open(list[0].id);
              });
            }}
          >
            Delete World
          </button>
        )}
        <button
          className="ghost"
          disabled={working || !doc}
          onClick={() =>
            run("saving", async () => {
              const id = dirty || !worldId ? await save() : worldId;
              if (id) onPlay(id);
            })
          }
        >
          {dirty || !worldId ? "Save & start campaign" : "Start campaign"}
        </button>
        <button disabled={working || !dirty} onClick={() => run("saving", async () => void (await save()))}>
          {busy === "saving" ? "Saving…" : "Save"}
        </button>
      </footer>}
    </dialog>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function SettingFields({ doc, update }: { doc: WorldDoc; update: (patch: Partial<WorldDoc>) => void }) {
  return <>
      <Field label="Premise" hint="Lore and the current situation. The Game Master reads this every turn.">
        <textarea rows={5} value={doc.premise} onChange={(e) => update({ premise: e.target.value })} />
      </Field>
      <div className="field-row">
        <Field label="Tone" hint="e.g. grim, political, low magic">
          <input value={doc.tone} onChange={(e) => update({ tone: e.target.value })} />
        </Field>
        <Field label="Lethality" hint="What happens at 0 HP">
          <select value={doc.lethality} onChange={(e) => update({ lethality: e.target.value as Lethality })}>
            <option value="forgiving">Forgiving: knocked out, never killed</option>
            <option value="standard">Standard: dying, can be saved</option>
            <option value="deadly">Deadly: 0 HP is death</option>
          </select>
        </Field>
      </div>
      <Field label="Content limits" hint="Anything the Game Master must avoid or keep off-screen.">
        <textarea rows={2} value={doc.contentLimits} onChange={(e) => update({ contentLimits: e.target.value })} />
      </Field>
  </>;
}

export function StartingLocationField({ doc, update }: { doc: WorldDoc; update: (patch: Partial<WorldDoc>) => void }) {
  return (
      <Field label="Starting location">
        <select value={doc.startingLocation} onChange={(e) => update({ startingLocation: e.target.value })}>
          {!doc.locations.some((l) => l.name === doc.startingLocation) && (
            <option value={doc.startingLocation}>{doc.startingLocation || "(none)"}</option>
          )}
          {doc.locations.map((l, i) => (
            <option key={i} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
  );
}

function WorldForm({ doc, update }: { doc: WorldDoc; update: (patch: Partial<WorldDoc>) => void }) {
  const setLocation = (i: number, patch: Partial<WorldDoc["locations"][number]>) =>
    update({ locations: doc.locations.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  return (
    <div className="gc-form">
      <Field label="Name">
        <input value={doc.name} onChange={(e) => update({ name: e.target.value })} />
      </Field>
      <SettingFields doc={doc} update={update} />

      <CatalogEditor label="Items" entries={doc.items ?? []} onChange={(items) => update({ items })} />
      <CatalogEditor label="Quests" entries={doc.quests ?? []} onChange={(quests) => update({ quests })} />
      <h3>Locations</h3>
      <StartingLocationField doc={doc} update={update} />
      {doc.locations.map((l, i) => (
        <div className="location-row" key={i}>
          <input
            aria-label="Location name"
            placeholder="Name"
            value={l.name}
            onChange={(e) => {
              const name = e.target.value;
              update({
                startingLocation: doc.startingLocation === l.name ? name : doc.startingLocation,
                locations: doc.locations.map((location, index) => ({
                  ...location,
                  name: index === i ? name : location.name,
                  links: location.links?.map((link) => link === l.name ? name : link),
                  routes: location.routes?.map((route) => route.to === l.name ? { ...route, to: name } : route),
                })),
                characters: doc.characters.map((character) => ({
                  ...character,
                  location: character.location && character.location === l.name ? name : character.location,
                  routine: character.routine?.map((stop) => stop === l.name ? name : stop),
                })),
              });
            }}
          />
          <input
            aria-label="Location description"
            placeholder="Description"
            value={l.description}
            onChange={(e) => setLocation(i, { description: e.target.value })}
          />
          <button className="ghost" aria-label={`Remove ${l.name}`} onClick={() => {
            const locations = doc.locations.filter((_, j) => j !== i).map((location) => ({
              ...location,
              links: location.links?.filter((link) => link !== l.name),
              routes: location.routes?.filter((route) => route.to !== l.name),
            }));
            update({
              locations,
              startingLocation: doc.startingLocation === l.name ? locations[0]?.name ?? "" : doc.startingLocation,
              characters: doc.characters.map((character) => ({
                ...character, location: character.location === l.name ? "" : character.location,
                routine: character.routine?.filter((stop) => stop !== l.name),
              })),
            });
          }}>
            ✕
          </button>
        </div>
      ))}
      <button className="ghost" onClick={() => update({ locations: [...doc.locations, { name: "", description: "" }] })}>
        + Add location
      </button>
      <RoutesEditor locations={doc.locations} onChange={(locations) => update({ locations })} />
    </div>
  );
}

function savedRoutes(location: Location): Route[] {
  return location.routes ?? [...new Set(location.links ?? [])].map((to) => ({ to, minutes: 30 }));
}

function RoutesEditor({ locations, onChange }: { locations: Location[]; onChange: (next: Location[]) => void }) {
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [returnTrip, setReturnTrip] = useState(false);
  const [returnMinutes, setReturnMinutes] = useState(30);
  const from = locations.find((location) => location.name === origin) ?? locations[0];
  const routes = from ? savedRoutes(from) : [];
  const choices = locations.filter((location) =>
    location.name && location !== from && !routes.some(({ to }) => to === location.name),
  );
  const target = choices.find((location) => location.name === destination) ?? choices[0];
  const canReturn = !!target && !!from && !savedRoutes(target).some(({ to }) => to === from.name);
  const validMinutes = (value: number) => Number.isInteger(value) && value >= 1 && value <= 1440;

  return <details className="route-editor">
    <summary>Travel routes</summary>
    <p className="field-hint">Each direction has its own travel time. Older links start at 30 minutes.</p>
    {locations.length > 0 && <div className="gc-form">
      <Field label="Depart from">
        <select value={from?.name ?? ""} onChange={(e) => setOrigin(e.target.value)}>
          {locations.map((location, i) => <option key={i} value={location.name}>{location.name || "Unnamed location"}</option>)}
        </select>
      </Field>
      {routes.map(({ to, minutes }, index) => <div className="route-row" key={to}>
        <span>{to}</span>
        <label>Minutes <input aria-label={`Minutes to ${to}`} type="number" min={1} max={1440} value={minutes} onChange={(e) => {
          const value = Number(e.target.value);
          onChange(locations.map((location) => location === from ? {
            ...location, routes: routes.map((route, i) => index === i ? { ...route, minutes: value } : route),
          } : location));
        }} /></label>
        <button className="ghost danger" onClick={() => onChange(locations.map((location) =>
          location === from ? { ...location, routes: routes.filter((_, i) => i !== index) } : location,
        ))}>Remove <span className="sr-only">{to}</span></button>
      </div>)}
      {!routes.length && <p className="field-hint">No outgoing routes.</p>}
      {!!from?.name && target && <div className="gc-form route-add">
        <div className="field-row">
          <Field label="Destination">
            <select value={target.name} onChange={(e) => setDestination(e.target.value)}>
              {choices.map((location, i) => <option key={i}>{location.name}</option>)}
            </select>
          </Field>
          <Field label="Travel minutes"><input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></Field>
        </div>
        {canReturn && <label><input type="checkbox" checked={returnTrip} onChange={(e) => setReturnTrip(e.target.checked)} /> Also add a return route</label>}
        {canReturn && returnTrip && <Field label="Return minutes"><input type="number" min={1} max={1440} value={returnMinutes} onChange={(e) => setReturnMinutes(Number(e.target.value))} /></Field>}
        <button className="ghost" disabled={routes.length >= 30 || !validMinutes(minutes) ||
          (canReturn && returnTrip && (!validMinutes(returnMinutes) || savedRoutes(target).length >= 30))}
          onClick={() => {
            onChange(locations.map((location) => {
              if (location === from) return { ...location, routes: [...routes, { to: target.name, minutes }] };
              if (location === target && canReturn && returnTrip) {
                return { ...location, routes: [...savedRoutes(location), { to: from.name, minutes: returnMinutes }] };
              }
              return location;
            }));
            setDestination("");
            setReturnTrip(false);
          }}>Add route</button>
      </div>}
    </div>}
  </details>;
}

function RoutineInput({ routine, onChange }: { routine: string[]; onChange: (next: string[]) => void }) {
  const [text, setText] = useState(routine.join(" | "));
  return <input value={text} onChange={(e) => {
    setText(e.target.value);
    onChange(e.target.value.split("|").map((name) => name.trim()).filter(Boolean));
  }} />;
}

function CatalogEditor({ label, entries, onChange }: { label: string; entries: CatalogEntry[]; onChange: (entries: CatalogEntry[]) => void }) {
  return <details><summary>{label}</summary>
    {entries.map((entry, index) => <div className="field-row" key={index}>
      <Field label="Name"><input value={entry.name} maxLength={80} onChange={(e) =>
        onChange(entries.map((old, i) => i === index ? { ...old, name: e.target.value } : old))
      } /></Field>
      <Field label="Description"><textarea rows={2} value={entry.description} maxLength={1000} onChange={(e) =>
        onChange(entries.map((old, i) => i === index ? { ...old, description: e.target.value } : old))
      } /></Field>
      <button className="ghost" onClick={() => onChange(entries.filter((_, i) => i !== index))}>Remove</button>
    </div>)}
    <button className="ghost" disabled={entries.length >= 100} onClick={() => onChange([...entries, { name: "", description: "" }])}>Add entry</button>
  </details>;
}

export function CharacterForm({
  character: c,
  world,
  locations,
  update,
  makePlayer,
  remove,
  lockLocation = false,
  onPortraitBusy,
  onProfileBusy,
}: {
  character: CharacterProfile;
  world: WorldDoc;
  locations: string[];
  update: (patch: Partial<CharacterProfile>) => void;
  makePlayer?: () => void;
  remove?: () => void;
  lockLocation?: boolean;
  onPortraitBusy?: (busy: boolean) => void;
  onProfileBusy?: (busy: boolean) => void;
}) {
  return (
    <div className="gc-form">
      <div className="field-row">
        <Field label="Name">
          <input value={c.name} onChange={(e) => update({ name: e.target.value })} />
        </Field>
        <Field label="Max HP">
          <input
            type="number"
            min={1}
            max={999}
            value={c.maxHp}
            onChange={(e) => update({ maxHp: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
          />
        </Field>
        {!lockLocation && <Field label="Location">
          <select value={c.location} onChange={(e) => update({ location: e.target.value })}>
            <option value="">Starting location</option>
            {c.location && !locations.includes(c.location) && <option value={c.location}>{c.location}</option>}
            {locations.filter(Boolean).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>}
      </div>
      <PortraitPicker key={c.id} portrait={c.portrait} onBusy={onPortraitBusy} onChange={(portrait) => update({ portrait: portrait ?? undefined })} />
      {c.role === "npc" && <Field label="Offscreen routine" hint="Ordered location names separated by |. Movement follows location links.">
        <RoutineInput key={c.id} routine={c.routine ?? []} onChange={(routine) => update({ routine })} />
      </Field>}
      <ProfileDraft key={c.id} character={c} world={world} onApply={update} onBusy={onProfileBusy} />
      <Field label="Description" hint="Appearance and first impression">
        <textarea rows={2} value={c.description} onChange={(e) => update({ description: e.target.value })} />
      </Field>
      <Field label="Personality">
        <textarea rows={2} value={c.personality} onChange={(e) => update({ personality: e.target.value })} />
      </Field>
      <Field label="Goals">
        <textarea rows={2} value={c.goals} onChange={(e) => update({ goals: e.target.value })} />
      </Field>
      <Field label="Secrets" hint="Only the Game Master knows these until the player uncovers them.">
        <textarea rows={2} value={c.secrets} onChange={(e) => update({ secrets: e.target.value })} />
      </Field>
      <div className="field-row">
        <NumberMap label="Skills" hint="d20 modifier, -5 to +10" min={-5} max={10} value={c.skills} onChange={(skills) => update({ skills })} />
        <NumberMap label="Inventory" hint="Quantity" min={1} max={999} value={c.inventory} onChange={(inventory) => update({ inventory })} />
      </div>
      {(makePlayer || remove) && <div className="gc-character-actions">
        {c.role === "player" ? (
          <span className="badge player">Player Character</span>
        ) : makePlayer && (
          <button className="ghost" onClick={makePlayer}>
            Make Player Character
          </button>
        )}
        {remove && <button className="ghost danger" onClick={remove} disabled={c.role === "player"} title={c.role === "player" ? "Make someone else the Player Character first" : undefined}>
          Remove character
        </button>}
      </div>}
    </div>
  );
}

/** Editable name → number pairs (skills, inventory). Rows live locally so renaming never loses a row. */
function NumberMap({
  label,
  hint,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  value: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
}) {
  const [rows, setRows] = useState(() => Object.entries(value).map(([name, n]) => ({ name, n })));
  const commit = (next: typeof rows) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.n])));
  };
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  return (
    <fieldset className="number-map">
      <legend className="field-label">{label}</legend>
      {rows.map((r, i) => (
        <div className="number-row" key={i}>
          <input
            aria-label={`${label} name`}
            value={r.name}
            onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
          />
          <input
            aria-label={`${label} value`}
            type="number"
            min={min}
            max={max}
            value={r.n}
            onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, n: clamp(Number(e.target.value) || 0) } : x)))}
          />
          <button className="ghost" aria-label={`Remove ${r.name}`} onClick={() => commit(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="ghost" onClick={() => setRows([...rows, { name: "", n: min > 0 ? min : 1 }])}>
        + Add
      </button>
      <span className="field-hint">{hint}</span>
    </fieldset>
  );
}

function DraftBar({
  label,
  placeholder,
  busy,
  disabled,
  onDraft,
}: {
  label: string;
  placeholder: string;
  busy: boolean;
  disabled: boolean;
  onDraft: (keywords: string) => void;
}) {
  const [keywords, setKeywords] = useState("");
  return (
    <form
      className="draft-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (keywords.trim()) onDraft(keywords.trim());
      }}
    >
      <input aria-label={label} placeholder={placeholder} value={keywords} onChange={(e) => setKeywords(e.target.value)} disabled={disabled} />
      <button type="submit" disabled={disabled || !keywords.trim()}>
        {busy ? <AiLoading>Drafting World…</AiLoading> : "Draft World"}
      </button>
    </form>
  );
}

function CharacterDraftBar({
  busy,
  disabled,
  onDraft,
}: {
  busy: boolean;
  disabled: boolean;
  onDraft: (keywords: string, role: Role) => void;
}) {
  const [keywords, setKeywords] = useState("");
  const [role, setRole] = useState<Role>("npc");
  return (
    <form
      className="draft-bar stacked"
      onSubmit={(e) => {
        e.preventDefault();
        if (keywords.trim()) onDraft(keywords.trim(), role);
      }}
    >
      <span className="field-label">Draft a character</span>
      <input aria-label="Character keywords" placeholder="e.g. retired spy, owes a debt" value={keywords} onChange={(e) => setKeywords(e.target.value)} disabled={disabled} />
      <div className="draft-row">
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={disabled}>
          <option value="npc">NPC</option>
          <option value="player">Player Character</option>
        </select>
        <button type="submit" disabled={disabled || !keywords.trim()}>
          {busy ? <AiLoading>Drafting…</AiLoading> : "Draft character"}
        </button>
      </div>
    </form>
  );
}
