/** The Russian plural form for `n`: 1 задача, 2 задачи, 5 задач, 11 задач, 21 задача, 22 задачи. */
export function ruPlural(n: number, one: string, few: string, many: string): string {
  const m100 = Math.abs(Math.trunc(n)) % 100;
  const m10 = m100 % 10;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}

/** The English plural form for `n`: 1 day, 7 days. */
export const enPlural = (n: number, one: string, other: string): string => (n === 1 ? one : other);
