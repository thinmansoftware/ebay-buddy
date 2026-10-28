export type Money = { value: string; currency: string };

export function readMoney(value: unknown): Money | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const amount = record.value;
  const currency = record.currency;
  if ((typeof amount !== "string" && typeof amount !== "number") || typeof currency !== "string")
    return null;
  if (
    !/^[A-Z]{3}$/.test(currency) ||
    !/^\d+(?:\.\d+)?$/.test(String(amount)) ||
    !Number.isFinite(Number(amount))
  )
    return null;
  return { value: String(amount), currency };
}

export function moneyNumber(money: Money | null): number | null {
  if (!money) return null;
  const parsed = Number(money.value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMoneyValue(amount: number): string {
  return amount.toFixed(2);
}
