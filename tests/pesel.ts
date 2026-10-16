/** Builds a PESEL with a correct control digit. Month code = month + century offset (1800: 80, 1900: 0, 2000: 20, 2100: 40, 2200: 60). */
export function makePesel(year: number, month: number, day: number, serial = 1234): string {
  const offset = year >= 2200 ? 60 : year >= 2100 ? 40 : year >= 2000 ? 20 : year >= 1900 ? 0 : 80;
  const body = String(year % 100).padStart(2, "0") + String(month + offset).padStart(2, "0") + String(day).padStart(2, "0") + String(serial).padStart(4, "0");
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const sum = [...body].reduce((a, d, i) => a + Number(d) * w[i]!, 0);
  return body + ((10 - (sum % 10)) % 10);
}
