import { useState, type FormEvent } from "react";
import { draftCharacter, type CharacterProfile, type WorldDoc } from "./api";
import { AiLoading } from "./AiLoading";

const fields = [
  ["description", "Description"], ["personality", "Personality"], ["goals", "Goals"], ["secrets", "Secrets"],
] as const;
type ProfileText = Pick<CharacterProfile, (typeof fields)[number][0]>;

export function ProfileDraft({ character, world, onApply, onBusy }: {
  character: CharacterProfile;
  world: WorldDoc;
  onApply: (draft: ProfileText) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [brief, setBrief] = useState("");
  const [draft, setDraft] = useState<ProfileText | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(false);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !brief.trim()) return;
    setBusy(true);
    onBusy?.(true);
    setError("");
    setApplied(false);
    try {
      const name = character.name.trim();
      const keywords = [brief.trim(), name && `Character name: ${name}`].filter(Boolean).join("\n").slice(0, 500);
      const { description, personality, goals, secrets } = await draftCharacter(keywords, character.role, world);
      setDraft({ description, personality, goals, secrets });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }

  return <details className="profile-draft">
    <summary>Draft profile with AI</summary>
    <form className="gc-form" onSubmit={generate}>
      <p className="field-hint">Draft description, personality, goals and secrets. Review the result before applying it.</p>
      <label className="field">
        <span className="field-label">Profile brief</span>
        <textarea rows={2} maxLength={380} value={brief} disabled={busy} onChange={(event) => setBrief(event.target.value)}
          placeholder="e.g. Soft-spoken scout who has lost their map" />
      </label>
      <button className="ghost" type="submit" disabled={busy || !brief.trim()}>Draft profile</button>
    </form>
    {busy && <AiLoading>Drafting character profile…</AiLoading>}
    {error && <p className="error" role="alert">{error}</p>}
    {draft && <div className="profile-draft-preview">
      <dl>
        {fields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{draft[key] || "—"}</dd></div>)}
      </dl>
      <div className="quick-replies">
        <button type="button" disabled={busy} onClick={() => {
          onApply(draft);
          setDraft(null);
          setApplied(true);
        }}>Apply to character</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setDraft(null)}>Discard draft</button>
      </div>
    </div>}
    {applied && <p className="field-hint" role="status">Draft applied. You can still edit the fields below.</p>}
  </details>;
}
