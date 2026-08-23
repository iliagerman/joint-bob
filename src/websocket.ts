export function webSocketCloseReason(value: string): string {
  if (Buffer.byteLength(value) <= 123) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character) > 123) break;
    result += character;
  }
  return result;
}
