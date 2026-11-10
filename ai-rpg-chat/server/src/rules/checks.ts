export type D20 = () => number;

export interface CheckInput {
  modifier: number;
  difficulty: number;
}

export interface CheckResult {
  roll: number;
  total: number;
  success: boolean;
  critical: "success" | "failure" | null;
}

export function skillCheck(input: CheckInput, d20: D20): CheckResult {
  const roll = d20();
  const total = roll + input.modifier;
  if (roll === 20) return { roll, total, success: true, critical: "success" };
  if (roll === 1) return { roll, total, success: false, critical: "failure" };
  return { roll, total, success: total >= input.difficulty, critical: null };
}

/** Real d20 using an injectable [0,1) random source. */
export const randomD20 =
  (random: () => number = Math.random): D20 =>
  () =>
    Math.floor(random() * 20) + 1;
