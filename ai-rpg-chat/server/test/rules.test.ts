import { describe, it, expect } from "vitest";
import { skillCheck, randomD20 } from "../src/rules/checks.js";

const fixedD20 = (face: number) => () => face;

describe("skill check", () => {
  it("succeeds when roll plus modifier meets the difficulty", () => {
    const result = skillCheck({ modifier: 3, difficulty: 15 }, fixedD20(12));
    expect(result).toMatchObject({ roll: 12, total: 15, success: true });
  });
});

describe("critical rolls", () => {
  it("natural 20 is a critical success even below the difficulty", () => {
    const result = skillCheck({ modifier: -2, difficulty: 25 }, fixedD20(20));
    expect(result).toMatchObject({ success: true, critical: "success" });
  });

  it("natural 1 is a critical failure even above the difficulty", () => {
    const result = skillCheck({ modifier: 15, difficulty: 10 }, fixedD20(1));
    expect(result).toMatchObject({ success: false, critical: "failure" });
  });

  it("ordinary rolls are not critical", () => {
    const result = skillCheck({ modifier: 0, difficulty: 10 }, fixedD20(10));
    expect(result.critical).toBeNull();
  });
});

describe("random d20", () => {
  it("maps the random range onto faces 1 through 20", () => {
    expect(randomD20(() => 0)()).toBe(1);
    expect(randomD20(() => 0.999999)()).toBe(20);
    expect(randomD20(() => 0.5)()).toBe(11);
  });
});
