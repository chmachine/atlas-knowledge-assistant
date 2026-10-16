const usd = (v: number, digits: number) => `$${v.toFixed(digits)}`;

/**
 * The line under "Cost per question". The total adds up the cost of every question in view. The cost of simulated questions is
 * modelled, not billed, so when they are in view the line says so, and the total is not mistaken for money spent.
 */
export function costTotalNote(totalUsd: number, simulatedQuestions: number): string {
  const total = `${usd(totalUsd, 2)} in total`;
  return simulatedQuestions > 0 ? `${total}, including simulated questions (modelled, not billed)` : total;
}
