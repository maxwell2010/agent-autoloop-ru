// The cost line in `agent-autoloop status`, from /v1/state's completion-time totals. Agents report usage for themselves, or
// don't: a plain command says nothing, and some give tokens but no price. So every figure says how many rounds it leaves out.
import type { Spending } from "../kernel/state.ts";
const count = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
/** To two places, a day on a cheap model would read as nothing at all. */
const dollars = (amount: number) => (amount > 0 && amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`);

function tally(label: string, { rounds, tokens, cost, missingTokens, missingCost }: Spending) {
  if (!rounds) return `${label} 0 цикл.`;
  const missing = (silent: number) => (silent ? `(${silent} цикл. без данных)` : "");
  const shownTokens =
    missingTokens === rounds
      ? "Token не сообщено"
      : `${count.format(tokens).replace(/(десятков тысяч|сотен миллионов)/, " $1")} Token${missing(missingTokens)}`;
  const shownCost = missingCost === rounds ? "Стоимость не сообщена" : `${dollars(cost)}${missing(missingCost)}`;
  return `${label} ${rounds} цикл. · ${shownTokens} · ${shownCost}`;
}

export function spendLine(spending: { today: Spending; week: Spending }) {
  return `${tally("Сегодня", spending.today)}    ${tally("Последние 7 дней", spending.week)}`;
}
