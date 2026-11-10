import type { WorldDoc } from "./world.js";

/** Seeded on first run so there is always a World to play. Editable in the God Console. */
export const DEFAULT_WORLD: WorldDoc = {
  name: "Eldoria",
  premise:
    "Eldoria is a river kingdom ten years past a war that emptied its castles. The old roads are unsafe again, " +
    "the crown is weak, and the guilds of the river town of Thornford quietly run more than they admit.",
  tone: "classic fantasy adventure, warm with flashes of danger",
  contentLimits: "",
  lethality: "standard",
  startingLocation: "The Gilded Tankard tavern",
  locations: [
    { name: "The Gilded Tankard tavern", description: "Thornford's busiest tavern: low beams, a roaring hearth, river traders.", links: ["Thornford market square"] },
    { name: "Thornford market square", description: "Stalls, gossip and the guild hall's watchful windows.", links: ["The Gilded Tankard tavern", "The old river road"] },
    { name: "The old river road", description: "Overgrown road along the river, haunted by bandits since the war.", links: ["Thornford market square"] },
  ],
  characters: [
    {
      id: "pc",
      name: "Arin",
      role: "player",
      description: "A young wanderer with a weathered cloak and a borrowed sword.",
      personality: "",
      goals: "Make a name, and enough coin to stop sleeping in haylofts.",
      secrets: "",
      maxHp: 20,
      skills: { Athletics: 2, Perception: 2, Persuasion: 1 },
      location: "",
      inventory: { "short sword": 1, "traveler's cloak": 1, "gold coin": 12 },
    },
    {
      id: "bram",
      name: "Bram",
      role: "npc",
      description: "The Gilded Tankard's broad, bald barkeep, a veteran of the war.",
      personality: "Gruff, dry humor, protective of regulars.",
      goals: "Keep the tavern out of guild debts.",
      secrets: "Owes the Ferrymen's Guild a large sum and passes them rumors to keep them patient.",
      maxHp: 16,
      skills: { Intimidation: 3, Insight: 2 },
      location: "",
      inventory: { cudgel: 1 },
    },
    {
      id: "selka",
      name: "Selka Vane",
      role: "npc",
      description: "A sharp-eyed cloth merchant who drinks too much on market days.",
      personality: "Charming, boastful when drunk, suspicious when sober.",
      goals: "Sell a cursed shipment before the guild finds out.",
      routine: ["Thornford market square", "The Gilded Tankard tavern"],
      secrets: "Her bolts of silk were looted from a sunken war barge and carry a drowning curse.",
      maxHp: 10,
      skills: { Persuasion: 3, Deception: 2 },
      location: "",
      inventory: { "gold coin": 40, "fine silk": 3 },
    },
  ],
};
