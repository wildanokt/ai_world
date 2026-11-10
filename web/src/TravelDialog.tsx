import { useEffect, useRef, useState } from "react";
import { campaignTime } from "./campaign-time";
import { ApiError, getCampaign, travel, type CampaignView } from "./api";

function duration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours && `${hours} h`, rest && `${rest} min`].filter(Boolean).join(" ");
}

export function TravelDialog({ campaign, onClose, onTravel }: {
  campaign: CampaignView;
  onClose: () => void;
  onTravel: (next: CampaignView) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const from = campaign.state.characters[campaign.state.playerCharacterId]!.location;
  const routes = campaign.state.travel;
  const destination = routes.find(({ to }) => to === selected);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  function close() {
    if (busy) return;
    dialog.current?.close();
    onClose();
  }

  async function depart() {
    if (!destination || busy) return;
    setBusy(true);
    setError("");
    try {
      onTravel(await travel(campaign, from, destination.to));
      dialog.current?.close();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.status === 409) {
        try { onTravel(await getCampaign(campaign.id)); } catch { /* Keep the existing Campaign visible. */ }
        setSelected("");
      }
    } finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="confirm-dialog travel-dialog" aria-labelledby="travel-title" onCancel={(event) => {
    event.preventDefault();
    close();
  }}>
    <h2 id="travel-title">Travel</h2>
    <p>Departing from <strong>{from}</strong></p>
    {routes.length ? <fieldset className="travel-options" disabled={busy}>
      <legend className="sr-only">Choose a destination</legend>
      {routes.map(({ to, minutes }) => <label key={to} className="travel-route">
        <input type="radio" name="destination" value={to} checked={selected === to} onChange={() => setSelected(to)} />
        <span>{to}<small>Arrives {campaignTime(campaign.state.clock + minutes)}</small></span><strong>{duration(minutes)}</strong>
      </label>)}
    </fieldset> : <p className="muted">There are no outgoing routes from here.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="quick-replies">
      <button className="ghost" onClick={close} disabled={busy}>Cancel</button>
      <button onClick={() => void depart()} disabled={busy || !destination || !!campaign.state.combat}>
        {busy ? "Travelling…" : "Confirm travel"}
      </button>
    </div>
  </dialog>;
}
